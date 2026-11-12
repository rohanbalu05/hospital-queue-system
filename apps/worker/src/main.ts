import { loadConfig } from './config.js';
import { createLogger } from './log.js';
import { WorkerService } from './service.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const log = createLogger({ service: 'worker', workerId: config.workerId }, config.logLevel);
  const worker = new WorkerService(config, log);

  let shuttingDown = false;
  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info('worker.signal', { signal });
    worker.stop().then(
      () => process.exit(0),
      (err) => {
        log.error('worker.stop_failed', { error: err instanceof Error ? err.message : String(err) });
        process.exit(1);
      },
    );
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('unhandledRejection', (reason) => {
    log.error('worker.unhandled_rejection', { error: reason instanceof Error ? reason.message : String(reason) });
  });

  worker.start();
}

main().catch((err) => {
  console.error(
    JSON.stringify({ level: 'error', msg: 'worker.fatal', error: err instanceof Error ? err.message : String(err) }),
  );
  process.exit(1);
});
