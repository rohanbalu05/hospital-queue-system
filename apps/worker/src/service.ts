import { createPool } from '@hqms/db';
import type { Pool } from 'pg';
import type { WorkerConfig } from './config.js';
import { defaultHandlers, documentDeps, ensureReconcileJob } from './handlers/index.js';
import { errorSummary, type Logger } from './log.js';
import { OutboxDispatcher } from './outbox.js';
import { JobRunner } from './runner.js';
import type { HandlerRegistry } from './types.js';

/** The worker process: one job runner plus the outbox dispatcher, sharing one small pool. */
export class WorkerService {
  readonly pool: Pool;
  readonly runner: JobRunner;
  readonly dispatcher: OutboxDispatcher | null;
  private seedTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly config: WorkerConfig,
    private readonly log: Logger,
    handlers: HandlerRegistry = defaultHandlers(
      documentDeps({
        ...process.env,
        OBJECT_STORAGE: config.objectStorage,
        STORAGE_DIR: config.storageDir,
        OCR_PROVIDER: config.ocrProvider,
        OCR_TIMEOUT_SEC: String(config.ocrTimeoutSec),
      }),
    ),
    pool?: Pool,
  ) {
    // Each in-flight handler uses at most one connection at a time, plus claim/renew/dispatcher queries.
    this.pool =
      pool ??
      createPool(config.databaseUrl, {
        max: config.concurrency + 3,
        applicationName: `hqms-worker-${config.workerId}`,
      });
    this.runner = new JobRunner({
      pool: this.pool,
      handlers,
      workerId: config.workerId,
      concurrency: config.concurrency,
      pollMs: config.pollMs,
      leaseMs: config.leaseSec * 1000,
      handlerTimeoutMs: config.handlerTimeoutSec * 1000,
      backoffCapSec: config.backoffCapSec,
      jobTypes: config.jobTypes,
      log,
    });
    this.dispatcher = config.dispatchOutbox
      ? new OutboxDispatcher({ pool: this.pool, pollMs: config.pollMs, batch: config.outboxBatch, log })
      : null;
  }

  /** Does this process serve reconcile_uploads? (a separate document worker does; an ops-only one may not) */
  private get servesReconciler(): boolean {
    const types = this.config.jobTypes;
    return types === null || types.includes('reconcile_uploads');
  }

  /**
   * reconcile_uploads reschedules itself one hour ahead (dedupe key reconcile_uploads:yyyy-mm-dd-hh). If the chain
   * was ever broken (job cancelled, database wiped), seeding this hour's job at start-up and every
   * `reconcileSeedSec` repairs it; a second worker doing the same hits the dedupe key and does nothing.
   */
  private seedReconciler(): void {
    ensureReconcileJob(this.pool).catch((err: unknown) =>
      this.log.warn('reconcile.seed_failed', { error: errorSummary(err) }),
    );
  }

  start(): void {
    if (this.servesReconciler) {
      this.seedReconciler();
      this.seedTimer = setInterval(() => this.seedReconciler(), this.config.reconcileSeedSec * 1000);
      this.seedTimer.unref();
    }
    this.runner.start();
    this.dispatcher?.start();
    this.log.info('worker.started', {
      workerId: this.config.workerId,
      concurrency: this.config.concurrency,
      pollMs: this.config.pollMs,
      leaseSec: this.config.leaseSec,
      jobTypes: this.config.jobTypes?.join(',') ?? 'all',
      outbox: this.dispatcher !== null,
    });
  }

  /** Stop claiming, finish in-flight work, close the pool. */
  async stop(): Promise<void> {
    this.log.info('worker.stopping');
    if (this.seedTimer) clearInterval(this.seedTimer);
    await this.dispatcher?.stop();
    const { abandoned } = await this.runner.stop(this.config.shutdownTimeoutMs);
    if (abandoned > 0) this.log.warn('worker.abandoned_jobs', { count: abandoned });
    await this.pool.end();
    this.log.info('worker.stopped');
  }
}
