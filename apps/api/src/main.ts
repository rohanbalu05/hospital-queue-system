import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module.js';
import { prepareDatabase } from './bootstrap.js';
import { loadConfig } from './common/config.js';
import { configureApp } from './setup.js';

async function bootstrap(): Promise<void> {
  const log = new Logger('Bootstrap');
  const config = loadConfig();
  await prepareDatabase(config, (m) => log.log(m));
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  configureApp(app, config);
  app.enableShutdownHooks();
  await app.listen(config.port, '0.0.0.0');
  log.log(`HQMS API listening on :${config.port} (identity provider: ${config.identityProvider})`);
}

bootstrap().catch((err: unknown) => {
  console.error('API failed to start:', err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
