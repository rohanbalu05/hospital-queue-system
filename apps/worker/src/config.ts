import { hostname } from 'node:os';
import type { LogLevel } from './log.js';

export interface WorkerConfig {
  databaseUrl: string;
  workerId: string;
  pollMs: number;
  concurrency: number;
  leaseSec: number;
  /** Cap for the exponential retry backoff (2^attempts seconds). */
  backoffCapSec: number;
  /** A handler running longer than this is treated as failed (its lease is no longer renewed). */
  handlerTimeoutSec: number;
  /** Restrict this process to some job types (e.g. a separate document worker). Empty = all. */
  jobTypes: string[] | null;
  dispatchOutbox: boolean;
  outboxBatch: number;
  /** Max time to wait for in-flight jobs on SIGTERM before exiting (leases then expire and re-claim). */
  shutdownTimeoutMs: number;
  logLevel: LogLevel;
}

function int(env: NodeJS.ProcessEnv, name: string, fallback: number, min = 1): number {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min) throw new Error(`${name} must be an integer >= ${min} (got "${raw}")`);
  return n;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): WorkerConfig {
  const databaseUrl = env['DATABASE_URL'];
  if (!databaseUrl) throw new Error('DATABASE_URL is not set');
  const level = (env['LOG_LEVEL'] ?? 'info') as LogLevel;
  if (!['debug', 'info', 'warn', 'error'].includes(level)) throw new Error(`LOG_LEVEL invalid: ${level}`);
  const types = (env['WORKER_JOB_TYPES'] ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return {
    databaseUrl,
    workerId: env['WORKER_ID'] || `${hostname()}-${process.pid}`,
    pollMs: int(env, 'WORKER_POLL_MS', 500, 10),
    concurrency: int(env, 'WORKER_CONCURRENCY', 4),
    leaseSec: int(env, 'WORKER_LEASE_SEC', 30),
    backoffCapSec: int(env, 'WORKER_BACKOFF_CAP_SEC', 300),
    handlerTimeoutSec: int(env, 'WORKER_HANDLER_TIMEOUT_SEC', 120),
    jobTypes: types.length > 0 ? types : null,
    dispatchOutbox: (env['WORKER_DISPATCH_OUTBOX'] ?? 'true') !== 'false',
    outboxBatch: int(env, 'WORKER_OUTBOX_BATCH', 50),
    shutdownTimeoutMs: int(env, 'WORKER_SHUTDOWN_TIMEOUT_MS', 25_000, 0),
    logLevel: level,
  };
}
