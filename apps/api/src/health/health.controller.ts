import { Controller, Get, Inject } from '@nestjs/common';
import type { Pool } from '@hqms/db';
import { DB_POOL } from '../common/tokens.js';
import { ApiException } from '../common/errors.js';
import { Public } from '../identity/auth.decorators.js';

@Controller()
export class HealthController {
  constructor(@Inject(DB_POOL) private readonly pool: Pool) {}

  /** Public liveness + database ping. No data beyond status. */
  @Public()
  @Get('health')
  async health(): Promise<{ status: 'ok'; db: 'up' }> {
    try {
      await this.pool.query('SELECT 1');
    } catch {
      throw new ApiException(503, 'INTERNAL', 'Database unavailable');
    }
    return { status: 'ok', db: 'up' };
  }
}
