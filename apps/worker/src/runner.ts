import type { Pool } from 'pg';
import { errorSummary, silentLogger, type Logger } from './log.js';
import {
  PermanentJobError,
  systemClock,
  type Clock,
  type HandlerRegistry,
  type HandlerResult,
  type JobRow,
} from './types.js';

/*
 * Postgres-backed job runner (report §6.2: durable, at-least-once, stable job ids).
 *
 *  - Claim: one UPDATE ... WHERE id IN (SELECT ... FOR UPDATE SKIP LOCKED LIMIT n) RETURNING. Ready jobs are
 *    pending/failed with run_at <= now, or running with an expired lease (a crashed worker) that still has
 *    attempts left (an exhausted one is never re-claimed; buryExhausted turns it 'dead'). Claiming sets a
 *    lease and increments attempts. Two runners never receive the same job id from one claim round.
 *  - Handlers are idempotent and do their own short transactions; the runner holds NO database lock while
 *    a handler runs (the claim transaction is a single autocommit statement).
 *  - Completion is guarded by (lease_owner, attempts): a worker that lost its lease cannot overwrite the
 *    outcome of the attempt that replaced it.
 *  - Failure: failed + exponential backoff (2^attempts seconds, capped) + last_error; once attempts reach
 *    max_attempts the job becomes 'dead' and stays in the table for operators.
 *  - Time comes from the injected clock, passed to SQL as a parameter, so tests can move time.
 */

export interface RunnerOptions {
  pool: Pool;
  handlers: HandlerRegistry;
  workerId: string;
  concurrency?: number;
  pollMs?: number;
  leaseMs?: number;
  handlerTimeoutMs?: number;
  backoffCapSec?: number;
  /** Restrict to these job types; null/undefined = all. */
  jobTypes?: readonly string[] | null;
  clock?: Clock;
  log?: Logger;
  /** Lease renewal period; defaults to leaseMs / 3. 0 disables renewal. */
  renewEveryMs?: number;
}

class ShutdownAbort extends Error {
  constructor() {
    super('worker shutting down');
    this.name = 'ShutdownAbort';
  }
}

export function backoffSeconds(attempts: number, capSec: number): number {
  return Math.min(capSec, 2 ** Math.max(1, attempts));
}

const JOB_COLUMNS = `id, job_type, payload, dedupe_key, state, run_at, attempts, max_attempts, lease_owner, lease_expires_at, last_error`;

interface JobDbRow {
  id: string;
  job_type: string;
  payload: Record<string, unknown> | null;
  dedupe_key: string | null;
  state: JobRow['state'];
  run_at: string;
  attempts: number;
  max_attempts: number;
  lease_owner: string | null;
  lease_expires_at: string | null;
  last_error: string | null;
}

function mapJob(r: JobDbRow): JobRow {
  return {
    id: r.id,
    jobType: r.job_type,
    payload: r.payload ?? {},
    dedupeKey: r.dedupe_key,
    state: r.state,
    runAt: new Date(r.run_at),
    attempts: r.attempts,
    maxAttempts: r.max_attempts,
    leaseOwner: r.lease_owner,
    leaseExpiresAt: r.lease_expires_at ? new Date(r.lease_expires_at) : null,
    lastError: r.last_error,
  };
}

export class JobRunner {
  private readonly pool: Pool;
  private readonly handlers: HandlerRegistry;
  readonly workerId: string;
  private readonly concurrency: number;
  private readonly pollMs: number;
  private readonly leaseMs: number;
  private readonly handlerTimeoutMs: number;
  private readonly backoffCapSec: number;
  private readonly jobTypes: string[] | null;
  private readonly clock: Clock;
  private readonly log: Logger;
  private readonly renewEveryMs: number;

  private stopping = false;
  private loopPromise: Promise<void> | null = null;
  private readonly inflight = new Set<Promise<void>>();
  private wake: (() => void) | null = null;
  private readonly shutdown = new AbortController();

  constructor(o: RunnerOptions) {
    this.pool = o.pool;
    this.handlers = o.handlers;
    this.workerId = o.workerId;
    this.concurrency = o.concurrency ?? 4;
    this.pollMs = o.pollMs ?? 500;
    this.leaseMs = o.leaseMs ?? 30_000;
    this.handlerTimeoutMs = o.handlerTimeoutMs ?? 120_000;
    this.backoffCapSec = o.backoffCapSec ?? 300;
    this.jobTypes = o.jobTypes && o.jobTypes.length > 0 ? [...o.jobTypes] : null;
    this.clock = o.clock ?? systemClock;
    this.log = (o.log ?? silentLogger).child({ component: 'runner' });
    this.renewEveryMs = o.renewEveryMs ?? Math.floor(this.leaseMs / 3);
  }

  /** Number of jobs currently executing in this process. */
  get inFlight(): number {
    return this.inflight.size;
  }

  /**
   * Jobs whose last attempt crashed (lease expired while running) and which have no attempts left become
   * 'dead' instead of being claimed again. Returns how many were buried.
   */
  async buryExhausted(): Promise<number> {
    const now = this.clock().toISOString();
    const res = await this.pool.query(
      `UPDATE jobs
          SET state = 'dead', finished_at = $1::timestamptz, updated_at = $1::timestamptz,
              lease_owner = NULL, lease_expires_at = NULL,
              last_error = COALESCE(last_error, 'lease expired during the final attempt')
        WHERE state = 'running' AND lease_expires_at < $1::timestamptz AND attempts >= max_attempts
          AND ($2::text[] IS NULL OR job_type = ANY($2))`,
      [now, this.jobTypes],
    );
    if (res.rowCount) this.log.warn('jobs.dead_after_lease_expiry', { count: res.rowCount });
    return res.rowCount ?? 0;
  }

  /** Claim up to `limit` ready jobs for this worker. Exposed for tests; the loop calls it for you. */
  async claim(limit: number): Promise<JobRow[]> {
    if (limit <= 0) return [];
    const now = this.clock().toISOString();
    const res = await this.pool.query<JobDbRow>(
      `UPDATE jobs
          SET state = 'running', lease_owner = $2,
              lease_expires_at = $1::timestamptz + ($3::int * interval '1 millisecond'),
              attempts = attempts + 1, updated_at = $1::timestamptz
        WHERE id IN (
          SELECT id FROM jobs
           WHERE ($5::text[] IS NULL OR job_type = ANY($5))
             AND ((state IN ('pending', 'failed') AND run_at <= $1::timestamptz)
               OR (state = 'running' AND lease_expires_at < $1::timestamptz AND attempts < max_attempts))
           ORDER BY run_at, created_at, id
           LIMIT $4
           FOR UPDATE SKIP LOCKED)
        RETURNING ${JOB_COLUMNS}`,
      [now, this.workerId, this.leaseMs, limit, this.jobTypes],
    );
    return res.rows.map(mapJob);
  }

  /** One round: bury exhausted, claim up to `limit`, run them all to completion. Returns the number run. */
  async tick(limit = this.concurrency): Promise<number> {
    await this.buryExhausted();
    const jobs = await this.claim(limit);
    await Promise.all(jobs.map((j) => this.execute(j)));
    return jobs.length;
  }

  /** Run rounds until nothing is ready (per the injected clock). For tests and one-shot runs. */
  async drain(): Promise<number> {
    let total = 0;
    for (;;) {
      const n = await this.tick();
      if (n === 0) return total;
      total += n;
    }
  }

  /** Start the polling loop (idempotent). */
  start(): void {
    if (this.loopPromise) return;
    this.stopping = false;
    this.loopPromise = this.loop();
  }

  /**
   * Graceful stop: no new claims, wait for in-flight handlers (up to `timeoutMs`; jobs still running then
   * keep their lease and are re-claimed after it expires, which is safe because handlers are idempotent).
   */
  async stop(timeoutMs = 25_000): Promise<{ abandoned: number }> {
    this.stopping = true;
    this.wake?.();
    await this.loopPromise;
    this.loopPromise = null;
    let abandoned = 0;
    if (this.inflight.size > 0) {
      let timer: NodeJS.Timeout | undefined;
      const timedOut = new Promise<'timeout'>((resolve) => {
        timer = setTimeout(() => resolve('timeout'), timeoutMs);
      });
      const pending = [...this.inflight];
      const result = await Promise.race([Promise.allSettled(pending).then(() => 'done' as const), timedOut]);
      clearTimeout(timer);
      if (result === 'timeout') {
        // Give up on handlers still running: they stop waiting, write no outcome, and keep their lease, so
        // the jobs are re-claimed after it expires (handlers are idempotent).
        abandoned = this.inflight.size;
        this.shutdown.abort();
        await Promise.allSettled(pending);
      }
    }
    return { abandoned };
  }

  private async loop(): Promise<void> {
    this.log.info('runner.started', { workerId: this.workerId, concurrency: this.concurrency });
    while (!this.stopping) {
      let claimed = 0;
      try {
        const free = this.concurrency - this.inflight.size;
        if (free > 0) {
          await this.buryExhausted();
          const jobs = await this.claim(free);
          claimed = jobs.length;
          for (const job of jobs) {
            const p: Promise<void> = this.execute(job)
              .catch((err) => this.log.error('runner.execute_crashed', { jobId: job.id, error: errorSummary(err) }))
              .finally(() => {
                this.inflight.delete(p);
                this.wake?.();
              });
            this.inflight.add(p);
          }
        }
      } catch (err) {
        // Database unreachable etc.: never crash the loop, just back off one poll interval.
        this.log.error('runner.claim_failed', { error: errorSummary(err) });
      }
      const saturated = this.inflight.size >= this.concurrency;
      if (claimed === 0 || saturated) await this.sleepOrWake(this.pollMs);
    }
    this.log.info('runner.stopped', { inFlight: this.inflight.size });
  }

  private sleepOrWake(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        if (this.wake === done) this.wake = null;
        resolve();
      };
      const timer = setTimeout(done, ms);
      this.wake = done;
    });
  }

  /** Run one claimed job: handler, then the guarded outcome write. Never throws for handler errors. */
  async execute(job: JobRow): Promise<void> {
    const log = this.log.child({ jobId: job.id, jobType: job.jobType, attempt: job.attempts });
    const handler = this.handlers[job.jobType];
    if (!handler) {
      await this.fail(job, new PermanentJobError(`no handler registered for job type ${job.jobType}`), log);
      return;
    }

    const abort = new AbortController();
    let onShutdown: () => void = () => {};
    const shutdownAbort = new Promise<never>((_, reject) => {
      onShutdown = () => {
        abort.abort();
        reject(new ShutdownAbort());
      };
    });
    shutdownAbort.catch(() => {});
    this.shutdown.signal.addEventListener('abort', onShutdown);
    let leaseLost = false;
    const renewer =
      this.renewEveryMs > 0
        ? setInterval(() => {
            void this.renewLease(job)
              .then((ok) => {
                if (!ok && !leaseLost) {
                  leaseLost = true;
                  log.warn('job.lease_lost');
                }
              })
              .catch((err) => log.warn('job.lease_renew_failed', { error: errorSummary(err) }));
          }, this.renewEveryMs)
        : undefined;
    renewer?.unref();
    let timeout: NodeJS.Timeout | undefined;

    try {
      const timedOut = new Promise<never>((_, reject) => {
        timeout = setTimeout(() => {
          abort.abort();
          reject(new Error(`handler timed out after ${this.handlerTimeoutMs} ms`));
        }, this.handlerTimeoutMs);
      });
      const run = handler(job, { pool: this.pool, now: this.clock, log, signal: abort.signal });
      // If the timeout wins, the handler may still settle later; swallow its rejection.
      run.catch(() => {});
      const result: HandlerResult = await Promise.race([run, timedOut, shutdownAbort]);
      await this.complete(job, result, log);
    } catch (err) {
      if (err instanceof ShutdownAbort) log.warn('job.abandoned_on_shutdown');
      else await this.fail(job, err, log);
    } finally {
      clearTimeout(timeout);
      if (renewer) clearInterval(renewer);
      this.shutdown.signal.removeEventListener('abort', onShutdown);
    }
  }

  private async renewLease(job: JobRow): Promise<boolean> {
    const now = this.clock().toISOString();
    const res = await this.pool.query(
      `UPDATE jobs SET lease_expires_at = $1::timestamptz + ($2::int * interval '1 millisecond'), updated_at = $1::timestamptz
        WHERE id = $3 AND state = 'running' AND lease_owner = $4 AND attempts = $5`,
      [now, this.leaseMs, job.id, this.workerId, job.attempts],
    );
    return (res.rowCount ?? 0) > 0;
  }

  private async complete(job: JobRow, result: HandlerResult, log: Logger): Promise<void> {
    const now = this.clock().toISOString();
    let sql: string;
    let params: unknown[];
    let outcome: string;
    if (result && 'retryAt' in result) {
      // Deferred: not an attempt. Give the attempt back so timers waiting on a clock never burn retries.
      sql = `UPDATE jobs SET state = 'pending', run_at = $5::timestamptz, attempts = attempts - 1,
                    lease_owner = NULL, lease_expires_at = NULL, updated_at = $4::timestamptz
              WHERE id = $1 AND state = 'running' AND lease_owner = $2 AND attempts = $3`;
      params = [job.id, this.workerId, job.attempts, now, result.retryAt.toISOString()];
      outcome = 'deferred';
    } else if (result && 'cancelled' in result) {
      sql = `UPDATE jobs SET state = 'cancelled', finished_at = $4::timestamptz, updated_at = $4::timestamptz,
                    lease_owner = NULL, lease_expires_at = NULL
              WHERE id = $1 AND state = 'running' AND lease_owner = $2 AND attempts = $3`;
      params = [job.id, this.workerId, job.attempts, now];
      outcome = 'cancelled';
    } else {
      sql = `UPDATE jobs SET state = 'succeeded', finished_at = $4::timestamptz, updated_at = $4::timestamptz,
                    lease_owner = NULL, lease_expires_at = NULL
              WHERE id = $1 AND state = 'running' AND lease_owner = $2 AND attempts = $3`;
      params = [job.id, this.workerId, job.attempts, now];
      outcome = 'succeeded';
    }
    const res = await this.pool.query(sql, params);
    if (res.rowCount === 0) log.warn('job.outcome_ignored_lease_lost', { outcome });
    else log.info(`job.${outcome}`);
  }

  private async fail(job: JobRow, err: unknown, log: Logger): Promise<void> {
    const now = this.clock();
    const permanent = err instanceof PermanentJobError;
    const dead = permanent || job.attempts >= job.maxAttempts;
    const message = errorSummary(err);
    const runAt = new Date(now.getTime() + backoffSeconds(job.attempts, this.backoffCapSec) * 1000);
    const res = dead
      ? await this.pool.query(
          `UPDATE jobs SET state = 'dead', last_error = $4, finished_at = $5::timestamptz, updated_at = $5::timestamptz,
                  lease_owner = NULL, lease_expires_at = NULL
            WHERE id = $1 AND state = 'running' AND lease_owner = $2 AND attempts = $3`,
          [job.id, this.workerId, job.attempts, message, now.toISOString()],
        )
      : await this.pool.query(
          `UPDATE jobs SET state = 'failed', last_error = $4, run_at = $6::timestamptz, updated_at = $5::timestamptz,
                  lease_owner = NULL, lease_expires_at = NULL
            WHERE id = $1 AND state = 'running' AND lease_owner = $2 AND attempts = $3`,
          [job.id, this.workerId, job.attempts, message, now.toISOString(), runAt.toISOString()],
        );
    if (res.rowCount === 0) {
      log.warn('job.outcome_ignored_lease_lost', { outcome: dead ? 'dead' : 'failed' });
      return;
    }
    if (dead) log.error('job.dead', { error: message });
    else
      log.warn('job.failed_will_retry', {
        error: message,
        retryInSec: backoffSeconds(job.attempts, this.backoffCapSec),
      });
  }
}
