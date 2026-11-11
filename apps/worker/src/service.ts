import { createPool } from '@hqms/db';
import type { Pool } from 'pg';
import type { WorkerConfig } from './config.js';
import { defaultHandlers } from './handlers/index.js';
import type { Logger } from './log.js';
import { OutboxDispatcher } from './outbox.js';
import { JobRunner } from './runner.js';
import type { HandlerRegistry } from './types.js';

/** The worker process: one job runner plus the outbox dispatcher, sharing one small pool. */
export class WorkerService {
  readonly pool: Pool;
  readonly runner: JobRunner;
  readonly dispatcher: OutboxDispatcher | null;

  constructor(
    private readonly config: WorkerConfig,
    private readonly log: Logger,
    handlers: HandlerRegistry = defaultHandlers(),
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

  start(): void {
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
    await this.dispatcher?.stop();
    const { abandoned } = await this.runner.stop(this.config.shutdownTimeoutMs);
    if (abandoned > 0) this.log.warn('worker.abandoned_jobs', { count: abandoned });
    await this.pool.end();
    this.log.info('worker.stopped');
  }
}
