import { Controller, Get, Inject } from '@nestjs/common';
import type { HealthStatus } from '@hqms/contracts';
import type { Pool } from '@hqms/db';
import type { AppConfig } from '../common/config.js';
import { ApiException } from '../common/errors.js';
import { APP_CONFIG, DB_POOL } from '../common/tokens.js';
import { Public } from '../identity/auth.decorators.js';

@Controller()
export class HealthController {
  constructor(
    @Inject(DB_POOL) private readonly pool: Pool,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  /**
   * Public liveness. 503 only when the database is down. A dead worker (no heartbeat within WORKER_STALE_SEC) makes
   * the status `degraded` but stays HTTP 200, so a probe does not restart the API for a worker problem (PR-02).
   * Status words only: no counts, ids or timings.
   */
  @Public()
  @Get('health')
  async health(): Promise<HealthStatus> {
    let workerUp: boolean;
    try {
      const r = await this.pool.query<{ up: boolean }>(
        `SELECT EXISTS (SELECT 1 FROM worker_heartbeats WHERE last_seen_at > now() - make_interval(secs => $1::int)) AS up`,
        [this.config.workerStaleSec],
      );
      workerUp = r.rows[0]?.up ?? false;
    } catch {
      throw new ApiException(503, 'INTERNAL', 'Database unavailable');
    }
    return { status: workerUp ? 'ok' : 'degraded', db: 'up', worker: workerUp ? 'up' : 'down' };
  }
}
