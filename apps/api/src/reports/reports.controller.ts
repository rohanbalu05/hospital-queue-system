import { Controller, Get, Inject, Param, Post, Query } from '@nestjs/common';
import type { Notification, OperationsReport } from '@hqms/contracts';
import { notFound } from '../common/errors.js';
import type { RequestCtx } from '../common/request-context.js';
import { DB_POOL } from '../common/tokens.js';
import type { Pool } from '@hqms/db';
import { UuidPipe, ZodPipe } from '../common/zod.pipe.js';
import { ALL_ROLES, Ctx, Roles } from '../identity/auth.decorators.js';
import { OperationsReportQuery, ReportsService, type OperationsReportQueryDto } from './reports.service.js';

/** FR-15-b. Admin only. */
@Controller('reports')
export class ReportsController {
  constructor(@Inject(ReportsService) private readonly reports: ReportsService) {}

  @Roles('admin')
  @Get('operations')
  operations(@Query(new ZodPipe(OperationsReportQuery)) q: OperationsReportQueryDto): Promise<OperationsReport> {
    return this.reports.operations(q);
  }
}

/** In-app notices for the signed-in user (rows are written by the worker's outbox dispatcher). */
@Controller('notifications')
export class NotificationsController {
  constructor(@Inject(DB_POOL) private readonly pool: Pool) {}

  @Roles(...ALL_ROLES)
  @Get()
  async list(@Ctx() ctx: RequestCtx): Promise<Notification[]> {
    const res = await this.pool.query(
      `SELECT id, kind, body, created_at, read_at FROM notifications
        WHERE recipient_user_id = $1 ORDER BY created_at DESC, id LIMIT 100`,
      [ctx.user.userId],
    );
    return res.rows.map((r) => ({ id: r.id, kind: r.kind, body: r.body, createdAt: r.created_at, readAt: r.read_at }));
  }

  /** Own notifications only: someone else's id answers 404. Marking read twice keeps the first read time. */
  @Roles(...ALL_ROLES)
  @Post(':id/read')
  async read(@Ctx() ctx: RequestCtx, @Param('id', new UuidPipe()) id: string): Promise<Notification> {
    const res = await this.pool.query(
      `UPDATE notifications SET read_at = COALESCE(read_at, now())
        WHERE id = $1 AND recipient_user_id = $2 RETURNING id, kind, body, created_at, read_at`,
      [id, ctx.user.userId],
    );
    const r = res.rows[0];
    if (!r) throw notFound('Notification');
    return { id: r.id, kind: r.kind, body: r.body, createdAt: r.created_at, readAt: r.read_at };
  }
}
