import { Inject, Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import type { QueueVersionNotice } from '@hqms/contracts';
import type { Pool } from '@hqms/db';
import { APP_CONFIG, CLOCK, DB_POOL } from '../common/tokens.js';
import type { AppConfig } from '../common/config.js';
import type { Clock } from '../common/clock.js';
import { ApiException } from '../common/errors.js';
import { localDate } from '../common/http.js';

/**
 * A live subscriber. `mode: 'session'` watches fixed session ids; `mode: 'display'` watches every open or
 * paused session of today (the waiting-room display), including sessions that appear or disappear.
 */
export interface Subscriber {
  mode: 'session' | 'display';
  sessionIds: ReadonlySet<string>;
  /** Highest version already announced per session (so a change is never missed or repeated). */
  sent: Map<string, number>;
  send(notice: QueueVersionNotice): void;
  close(): void;
}

/** Hard cap so a flood of public display connections cannot exhaust file descriptors. */
const MAX_SUBSCRIBERS = 1000;

/**
 * One shared poller per API instance (report 6.2: "compare active session versions in a batch rather than
 * one poll per client"). Every tick runs ONE query for all watched sessions and fans the changes out.
 * The poller only starts with the first subscriber and stops with the last. SSE carries version notices
 * only; clients refetch the authoritative snapshot, so a missed or duplicated notice is harmless.
 * (A LISTEN/NOTIFY fast path was left out: at 500 ms the poll is within the "within 2 s" objective and
 * costs one cheap indexed query per tick regardless of the number of clients.)
 */
@Injectable()
export class LiveService implements OnModuleDestroy {
  private readonly log = new Logger('LiveService');
  private readonly subs = new Set<Subscriber>();
  private timer: NodeJS.Timeout | null = null;
  private chain: Promise<void> = Promise.resolve();

  constructor(
    @Inject(DB_POOL) private readonly pool: Pool,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  get pingMs(): number {
    return this.config.ssePingMs;
  }

  /** Register a subscriber and announce the current version(s) to it immediately. Returns the unsubscribe function. */
  async subscribe(sub: Subscriber): Promise<() => void> {
    if (this.subs.size >= MAX_SUBSCRIBERS) throw new ApiException(503, 'INTERNAL', 'Too many live connections');
    this.subs.add(sub);
    this.ensureTimer();
    const off = (): void => {
      this.subs.delete(sub);
      if (this.subs.size === 0) this.stopTimer();
    };
    await this.pollNow();
    return off;
  }

  subscriberCount(): number {
    return this.subs.size;
  }

  onModuleDestroy(): void {
    this.stopTimer();
    for (const sub of [...this.subs]) sub.close();
    this.subs.clear();
  }

  private ensureTimer(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.pollNow(), this.config.ssePollMs);
    this.timer.unref();
  }

  private stopTimer(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Serialise ticks: a connect-time poll and the timer never run concurrently. */
  private pollNow(): Promise<void> {
    this.chain = this.chain.then(() => this.tick()).catch((err: unknown) => {
      this.log.warn(`poll failed: ${err instanceof Error ? err.name : 'error'}`);
    });
    return this.chain;
  }

  private async tick(): Promise<void> {
    if (this.subs.size === 0) return;
    const watched = new Set<string>();
    let display = false;
    for (const sub of this.subs) {
      for (const id of sub.sessionIds) watched.add(id);
      if (sub.mode === 'display') {
        display = true;
        for (const id of sub.sent.keys()) watched.add(id); // also notice sessions that left the display set
      }
    }
    const today = localDate(this.clock.now(), this.config.hospitalTz);
    const res = await this.pool.query<{ id: string; queue_version: number; updated_at: string; on_display: boolean }>(
      `SELECT id, queue_version, updated_at,
              (session_date = $3::date AND status IN ('open','paused')) AS on_display
         FROM sessions
        WHERE id = ANY($1::uuid[]) OR ($2::boolean AND session_date = $3::date AND status IN ('open','paused'))`,
      [[...watched], display, today],
    );
    const types = new Map<string, string>();
    for (const row of res.rows) {
      for (const sub of this.subs) {
        const watches =
          sub.mode === 'display' ? row.on_display || sub.sent.has(row.id) : sub.sessionIds.has(row.id);
        if (!watches) continue;
        const last = sub.sent.get(row.id);
        if (last !== undefined && row.queue_version <= last) continue;
        let eventType = 'connected';
        if (last !== undefined) {
          if (!types.has(row.id)) types.set(row.id, await this.latestEventType(row.id));
          eventType = types.get(row.id) ?? 'queue.changed';
        }
        sub.sent.set(row.id, row.queue_version);
        sub.send({
          sessionId: row.id,
          queueVersion: row.queue_version,
          eventType,
          committedAt: new Date(row.updated_at).toISOString(),
        });
      }
    }
  }

  /** Routing hint only (outbox position is not commit order, so it is never trusted for ordering). */
  private async latestEventType(sessionId: string): Promise<string> {
    const r = await this.pool.query<{ event_type: string }>(
      `SELECT event_type FROM outbox_events WHERE session_id = $1 ORDER BY position DESC LIMIT 1`,
      [sessionId],
    );
    return r.rows[0]?.event_type ?? 'queue.changed';
  }
}
