import { Global, Inject, Module, type OnApplicationShutdown } from '@nestjs/common';
import { createPool, type Pool } from '@hqms/db';
import { APP_CONFIG, CLOCK, DB_POOL } from './tokens.js';
import { loadConfig, type AppConfig } from './config.js';
import { SystemClock } from './clock.js';

/** Process-wide singletons: configuration, the pg pool and the clock. */
@Global()
@Module({
  providers: [
    { provide: APP_CONFIG, useFactory: (): AppConfig => loadConfig() },
    {
      provide: DB_POOL,
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig): Pool =>
        createPool(config.databaseUrl, { max: config.dbPoolMax, applicationName: 'hqms-api' }),
    },
    { provide: CLOCK, useClass: SystemClock },
  ],
  exports: [APP_CONFIG, DB_POOL, CLOCK],
})
export class CoreModule implements OnApplicationShutdown {
  constructor(@Inject(DB_POOL) private readonly pool: Pool) {}

  async onApplicationShutdown(): Promise<void> {
    await this.pool.end();
  }
}
