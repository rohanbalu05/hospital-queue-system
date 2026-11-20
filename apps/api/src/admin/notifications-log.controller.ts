import { Controller, Get, Inject, Query } from '@nestjs/common';
import { NotificationDeliveryQuery, type NotificationDelivery } from '@hqms/contracts';
import type { Pool } from '@hqms/db';
import { DB_POOL } from '../common/tokens.js';
import { ZodPipe } from '../common/zod.pipe.js';
import { Roles } from '../identity/auth.decorators.js';

type DeliveryQueryDto = ReturnType<typeof NotificationDeliveryQuery.parse>;

/** Stored address -> what leaves the server. Phone: last four digits. Email: first letter + domain. In-app: "in-app". */
export function maskAddress(channel: string, address: string): string {
  if (channel === 'in_app') return 'in-app';
  if (channel === 'email') {
    const at = address.lastIndexOf('@');
    if (at < 1) return '***';
    return `${address[0]}***@${address.slice(at + 1)}`;
  }
  const digits = address.replace(/\D/g, '');
  return digits.length === 0 ? '******' : `******${digits.slice(-4)}`;
}

/**
 * The "Notifications sent" log (D-034): one row per recipient per channel per event, newest first. Admin only.
 * The recipient is named from the patient record (or the staff account) and the address is always masked, so a
 * phone number or email address never appears in an API response.
 */
@Controller('admin/notifications')
export class NotificationsLogController {
  constructor(@Inject(DB_POOL) private readonly pool: Pool) {}

  @Roles('admin')
  @Get()
  async list(@Query(new ZodPipe(NotificationDeliveryQuery)) q: DeliveryQueryDto): Promise<NotificationDelivery[]> {
    const res = await this.pool.query(
      `SELECT d.id, d.channel, d.status, d.address, d.body, d.provider, d.provider_message_id, d.attempts, d.last_error,
              d.session_id, d.created_at, d.sent_at, e.event_type,
              COALESCE(p.full_name, u.display_name) AS recipient_name,
              CASE WHEN d.patient_id IS NOT NULL THEN 'patient' ELSE u.role END AS recipient_role
         FROM notification_deliveries d
         LEFT JOIN outbox_events e ON e.id = d.event_id
         LEFT JOIN patients p ON p.id = d.patient_id
         LEFT JOIN users u ON u.id = d.recipient_user_id
        WHERE ($1::text IS NULL OR d.channel = $1)
          AND ($2::text IS NULL OR d.status = $2)
          AND ($3::uuid IS NULL OR d.session_id = $3)
        ORDER BY d.created_at DESC, d.id
        LIMIT $4`,
      [q.channel ?? null, q.status ?? null, q.sessionId ?? null, q.limit],
    );
    return res.rows.map(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- pg row
      (r: any): NotificationDelivery => ({
        id: r.id,
        channel: r.channel,
        status: r.status,
        recipientName: r.recipient_name ?? 'Unknown',
        recipientRole: r.recipient_role ?? 'unknown',
        address: maskAddress(r.channel, r.address),
        body: r.body,
        eventType: r.event_type ?? null,
        sessionId: r.session_id,
        provider: r.provider,
        providerMessageId: r.provider_message_id,
        attempts: r.attempts,
        lastError: r.last_error,
        createdAt: r.created_at,
        sentAt: r.sent_at,
      }),
    );
  }
}
