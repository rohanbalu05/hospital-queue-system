import type { Pool } from 'pg';
import { errorSummary, silentLogger, type Logger } from './log.js';

/*
 * Worker heartbeat (PR-02, migration 0010). Each worker process upserts one worker_heartbeats row at start and every
 * few seconds, so GET /health and the admin system panel can tell "the worker is dead" from "nothing to do".
 *
 * Every write is its own short autocommit statement on the shared pool: never inside a job transaction and never
 * holding a lock, so a slow job cannot make a healthy worker look dead, and a database blip only delays the next beat.
 * Timestamps come from the database clock, the same one /health compares against.
 */

export interface HeartbeatOptions {
  pool: Pool;
  workerId: string;
  /** Job types this process serves; null or empty = every type. */
  jobTypes: readonly string[] | null;
  dispatchOutbox: boolean;
  intervalMs: number;
  log?: Logger;
}

export class Heartbeat {
  private readonly o: HeartbeatOptions;
  private readonly log: Logger;
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;

  constructor(o: HeartbeatOptions) {
    this.o = o;
    this.log = (o.log ?? silentLogger).child({ component: 'heartbeat' });
  }

  private async beat(first: boolean): Promise<void> {
    try {
      await this.o.pool.query(
        `INSERT INTO worker_heartbeats (worker_id, job_types, dispatch_outbox, started_at, last_seen_at)
         VALUES ($1, $2::text[], $3, now(), now())
         ON CONFLICT (worker_id) DO UPDATE
            SET job_types = EXCLUDED.job_types,
                dispatch_outbox = EXCLUDED.dispatch_outbox,
                started_at = CASE WHEN $4::boolean THEN now() ELSE worker_heartbeats.started_at END,
                last_seen_at = now()`,
        [this.o.workerId, this.o.jobTypes ? [...this.o.jobTypes] : [], this.o.dispatchOutbox, first],
      );
    } catch (err) {
      // Never throws: a missed beat is retried on the next tick.
      this.log.warn('heartbeat.failed', { error: errorSummary(err) });
    }
  }

  /** First beat (awaited, so the row exists when this resolves), then one per interval. */
  async start(): Promise<void> {
    this.stopped = false;
    await this.beat(true);
    if (this.stopped || this.timer) return;
    this.timer = setInterval(() => void this.beat(false), this.o.intervalMs);
    this.timer.unref();
  }

  /** Stop beating and remove this worker's own row (a clean stop is not "down", it is simply gone). */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    try {
      await this.o.pool.query(`DELETE FROM worker_heartbeats WHERE worker_id = $1`, [this.o.workerId]);
    } catch (err) {
      this.log.warn('heartbeat.remove_failed', { error: errorSummary(err) });
    }
  }
}
