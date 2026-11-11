import { Controller, Get, Inject, Query } from '@nestjs/common';
import type { z } from 'zod';
import { AuditQuery, type AuditEvent } from '@hqms/contracts';
import type { Pool } from '@hqms/db';
import { DB_POOL } from '../common/tokens.js';
import { ZodPipe } from '../common/zod.pipe.js';
import { Roles } from '../identity/auth.decorators.js';

type AuditQueryDto = z.infer<typeof AuditQuery>;

/** FR-15: the audit trail, newest first. Admin only. */
@Controller('audit')
export class AuditController {
  constructor(@Inject(DB_POOL) private readonly pool: Pool) {}

  @Roles('admin')
  @Get()
  async list(@Query(new ZodPipe(AuditQuery)) q: AuditQueryDto): Promise<AuditEvent[]> {
    const res = await this.pool.query(
      `SELECT a.id, a.occurred_at, a.actor_id, u.display_name AS actor_name, a.actor_role, a.operation, a.entity_type,
              a.entity_id, a.previous, a.next, a.reason, a.policy_version, a.correlation_id
         FROM audit_events a LEFT JOIN users u ON u.id = a.actor_id
        WHERE ($1::text IS NULL OR a.entity_type = $1)
          AND ($2::uuid IS NULL OR a.entity_id = $2)
          AND ($3::timestamptz IS NULL OR a.occurred_at >= $3)
          AND ($4::timestamptz IS NULL OR a.occurred_at <= $4)
        ORDER BY a.occurred_at DESC, a.id DESC
        LIMIT $5`,
      [q.entityType ?? null, q.entityId ?? null, q.from ?? null, q.to ?? null, q.limit],
    );
    return res.rows.map((r) => ({
      id: r.id,
      occurredAt: r.occurred_at,
      actorId: r.actor_id,
      actorName: r.actor_name ?? null,
      actorRole: r.actor_role,
      operation: r.operation,
      entityType: r.entity_type,
      entityId: r.entity_id,
      previous: r.previous,
      next: r.next,
      reason: r.reason,
      policyVersion: r.policy_version,
      correlationId: r.correlation_id,
    }));
  }
}
