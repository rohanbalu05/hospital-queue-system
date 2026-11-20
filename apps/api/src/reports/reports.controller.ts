import { Controller, Get, HttpCode, Inject, Param, Post, Query } from '@nestjs/common';
import type { Notification, OperationsReport, ReadAllResult, UnreadCount } from '@hqms/contracts';
import { notFound } from '../common/errors.js';
import type { AppConfig } from '../common/config.js';
import { PerUserRateLimit } from '../common/user-rate-limit.js';
import type { RequestCtx } from '../common/request-context.js';
import { APP_CONFIG, DB_POOL } from '../common/tokens.js';
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

/** Row shape shared by the list and mark-read reads. */
const NOTE_COLUMNS = 'id, kind, body, created_at, read_at, link, severity';

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- pg row
const mapNote = (r: any): Notification => ({
  id: r.id,
  kind: r.kind,
  body: r.body,
  createdAt: r.created_at,
  readAt: r.read_at,
  link: r.link,
  severity: r.severity,
});

/** In-app notices for the signed-in user (rows are written by the worker's outbox dispatcher). Own rows only, every role. */
@Controller('notifications')
export class NotificationsController {
  private readonly unreadLimit: PerUserRateLimit;
  private readonly readAllLimit: PerUserRateLimit;

  constructor(
    @Inject(DB_POOL) private readonly pool: Pool,
    @Inject(APP_CONFIG) config: AppConfig,
  ) {
    this.unreadLimit = new PerUserRateLimit(config.unreadCountRateLimitPerMin);
    this.readAllLimit = new PerUserRateLimit(config.readsRateLimitPerMin);
  }

  @Roles(...ALL_ROLES)
  @Get()
  async list(@Ctx() ctx: RequestCtx): Promise<Notification[]> {
    const res = await this.pool.query(
      `SELECT ${NOTE_COLUMNS} FROM notifications
        WHERE recipient_user_id = $1 ORDER BY created_at DESC, id LIMIT 100`,
      [ctx.user.userId],
    );
    return res.rows.map(mapNote);
  }

  /** Cheap count for the bell; the web app refetches it on live notices. */
  @Roles(...ALL_ROLES)
  @Get('unread-count')
  async unreadCount(@Ctx() ctx: RequestCtx): Promise<UnreadCount> {
    this.unreadLimit.hit(ctx.user.userId);
    const res = await this.pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM notifications WHERE recipient_user_id = $1 AND read_at IS NULL`,
      [ctx.user.userId],
    );
    return { unreadCount: res.rows[0]?.n ?? 0 };
  }

  /** Marks every unread notification of the caller as read; other people's rows are never touched. */
  @Roles(...ALL_ROLES)
  @Post('read-all')
  @HttpCode(200)
  async readAll(@Ctx() ctx: RequestCtx): Promise<ReadAllResult> {
    this.readAllLimit.hit(ctx.user.userId);
    const res = await this.pool.query(
      `UPDATE notifications SET read_at = now() WHERE recipient_user_id = $1 AND read_at IS NULL`,
      [ctx.user.userId],
    );
    return { updated: res.rowCount ?? 0 };
  }

  /** Own notifications only: someone else's id answers 404. Marking read twice keeps the first read time. */
  @Roles(...ALL_ROLES)
  @Post(':id/read')
  async read(@Ctx() ctx: RequestCtx, @Param('id', new UuidPipe()) id: string): Promise<Notification> {
    const res = await this.pool.query(
      `UPDATE notifications SET read_at = COALESCE(read_at, now())
        WHERE id = $1 AND recipient_user_id = $2 RETURNING ${NOTE_COLUMNS}`,
      [id, ctx.user.userId],
    );
    const r = res.rows[0];
    if (!r) throw notFound('Notification');
    return mapNote(r);
  }
}
