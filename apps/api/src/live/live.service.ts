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
  /** Who is listening: staff streams carry the event type; patient and display streams only `queue.changed`. */
  audience: 'staff' | 'patient' | 'display';
  sessionIds: ReadonlySet<string>;
  /** Highest version already announced per session (so a change is never missed or repeated). */
  sent: Map<string, number>;
  send(notice: QueueVersionNotice): void;
  close(): void;
}

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
  /** The tick in flight, if any: the timer skips a tick while one is running, so ticks never pile up. */
  private running: Promise<void> | null = null;
  private authenticated = 0;
  private displays = 0;
  private readonly perIp = new Map<string, number>();

  constructor(
    @Inject(DB_POOL) private readonly pool: Pool,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  get pingMs(): number {
    return this.config.ssePingMs;
  }

  /**
   * Reserve a connection slot BEFORE any stream header is written, so a refusal is an ordinary 503 JSON error:
   * separate caps for the public display and authenticated streams, and one per client address.
   * Returns the release function (idempotent).
   */
  reserve(kind: 'display' | 'authenticated', ip: string): () => void {
    const cfg = this.config;
    const tooMany = (): never => {
      throw new ApiException(503, 'INTERNAL', 'Too many live connections; try again shortly');
    };
    if (kind === 'display' ? this.displays >= cfg.sseMaxDisplay : this.authenticated >= cfg.sseMaxAuthenticated) tooMany();
    if ((this.perIp.get(ip) ?? 0) >= cfg.sseMaxPerIp) tooMany();
    if (kind === 'display') this.displays += 1;
    else this.authenticated += 1;
    this.perIp.set(ip, (this.perIp.get(ip) ?? 0) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      if (kind === 'display') this.displays -= 1;
      else this.authenticated -= 1;
      const n = (this.perIp.get(ip) ?? 1) - 1;
      if (n <= 0) this.perIp.delete(ip);
      else this.perIp.set(ip, n);
    };
  }

  /** Register a subscriber and announce the current version(s) to it immediately. Returns the unsubscribe function. */
  async subscribe(sub: Subscriber): Promise<() => void> {
    this.subs.add(sub);
    this.ensureTimer();
    const off = (): void => {
      this.subs.delete(sub);
      if (this.subs.size === 0) this.stopTimer();
    };
    // A tick that started before this subscriber was added cannot have served it: wait it out, then poll once.
    if (this.running) await this.running;
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
    this.timer = setInterval(() => {
      if (!this.running) void this.pollNow(); // skip while the previous tick is still in flight
    }, this.config.ssePollMs);
    this.timer.unref();
  }

  private stopTimer(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** One tick at a time: a connect-time poll and the timer never run concurrently (an in-flight tick is shared). */
  private pollNow(): Promise<void> {
    if (this.running) return this.running;
    const run = this.tick()
      .catch((err: unknown) => {
        this.log.warn(`poll failed: ${err instanceof Error ? err.name : 'error'}`);
      })
      .finally(() => {
        if (this.running === run) this.running = null;
      });
    this.running = run;
    return run;
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
          if (sub.audience !== 'staff') {
            // Patients and the public display learn only that the queue moved: no event name that hints at a
            // clinical signal (priority, pause, a call). They refetch the snapshot they are allowed to see.
            eventType = 'queue.changed';
          } else {
            if (!types.has(row.id)) types.set(row.id, await this.latestEventType(row.id));
            eventType = types.get(row.id) ?? 'queue.changed';
          }
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
