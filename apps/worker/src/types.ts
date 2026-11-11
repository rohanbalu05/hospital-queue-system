import type { Pool } from 'pg';
import type { Logger } from './log.js';

/** Injectable time source. Handlers and the runner never read the wall clock directly. */
export type Clock = () => Date;
export const systemClock: Clock = () => new Date();

export type JobState = 'pending' | 'running' | 'succeeded' | 'failed' | 'dead' | 'cancelled';

export interface JobRow {
  id: string;
  jobType: string;
  payload: Record<string, unknown>;
  dedupeKey: string | null;
  state: JobState;
  runAt: Date;
  /** Includes the attempt now running (incremented by the claim). */
  attempts: number;
  maxAttempts: number;
  leaseOwner: string | null;
  leaseExpiresAt: Date | null;
  lastError: string | null;
}

/**
 * What a handler may return.
 *  - nothing: success.
 *  - { retryAt }: not due yet; put the job back as pending at that time WITHOUT consuming an attempt.
 *  - { cancelled: true }: nothing to do and never will be (entity gone / superseded); terminal 'cancelled'.
 *  - { superseded: true }: this attempt lost its lease to a newer one and wrote nothing; the runner writes no outcome
 *    (the replacement attempt owns the job).
 * Throwing means failure: backoff retry, then 'dead' after max_attempts. Throw PermanentJobError to skip retries.
 */
export type HandlerResult =
  // eslint-disable-next-line @typescript-eslint/no-invalid-void-type -- `async () => {}` handlers must be assignable
  void | { retryAt: Date } | { cancelled: true; reason?: string } | { superseded: true };

export interface JobContext {
  pool: Pool;
  now: Clock;
  log: Logger;
  /** Aborted when the handler timeout elapses or the worker is force-stopped. */
  signal: AbortSignal;
}

export type JobHandler = (job: JobRow, ctx: JobContext) => Promise<HandlerResult>;

/** Registry keyed by job_type (the JobType values from @hqms/contracts, plus test-only types). */
export type HandlerRegistry = Readonly<Record<string, JobHandler>>;

/** Bad payload or an unrecoverable condition: go straight to 'dead' (still visible, never discarded). */
export class PermanentJobError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PermanentJobError';
  }
}
