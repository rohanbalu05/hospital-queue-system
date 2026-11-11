import { Body, Controller, Get, Inject, Param, Put } from '@nestjs/common';
import { SetAssignmentsRequest, type StaffMember } from '@hqms/contracts';
import { setAssignedDoctorIds, withTransaction, writeAudit, type Pool, type Queryable } from '@hqms/db';
import { notFound, validationFailed } from '../common/errors.js';
import type { RequestCtx } from '../common/request-context.js';
import { DB_POOL } from '../common/tokens.js';
import { UuidPipe, ZodPipe } from '../common/zod.pipe.js';
import { Ctx, Roles } from '../identity/auth.decorators.js';

const STAFF_SQL = `
  SELECT u.id, u.display_name, u.email, u.role,
         CASE WHEN u.role = 'doctor' THEN CASE WHEN u.doctor_id IS NULL THEN ARRAY[]::uuid[] ELSE ARRAY[u.doctor_id] END
              WHEN u.role IN ('reception','followup') THEN
                COALESCE((SELECT array_agg(sa.doctor_id ORDER BY sa.doctor_id) FROM staff_assignments sa WHERE sa.user_id = u.id), ARRAY[]::uuid[])
              ELSE ARRAY[]::uuid[] END AS doctor_ids
    FROM users u
   WHERE u.role <> 'patient' AND u.active`;

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- pg row
const mapStaff = (r: any): StaffMember => ({
  userId: r.id,
  displayName: r.display_name,
  email: r.email,
  role: r.role,
  doctorIds: r.doctor_ids,
});

/** Admin staff management (FR-01): who works for which doctor. Admin only; every change is audited. */
@Controller('admin/staff')
export class AdminController {
  constructor(@Inject(DB_POOL) private readonly pool: Pool) {}

  @Roles('admin')
  @Get()
  async list(): Promise<StaffMember[]> {
    const res = await this.pool.query(`${STAFF_SQL} ORDER BY u.role, u.display_name, u.id`);
    return res.rows.map(mapStaff);
  }

  /** Replace the doctors a reception or follow-up user is assigned to. Doctors and admins are not assignable. */
  @Roles('admin')
  @Put(':userId/assignments')
  async setAssignments(
    @Ctx() ctx: RequestCtx,
    @Param('userId', new UuidPipe()) userId: string,
    @Body(new ZodPipe(SetAssignmentsRequest)) body: SetAssignmentsRequest,
  ): Promise<StaffMember> {
    const doctorIds = [...new Set(body.doctorIds)].sort();
    return withTransaction(this.pool, async (tx) => {
      const u = await this.one(tx, userId);
      if (!u) throw notFound('Staff member');
      if (u.role !== 'reception' && u.role !== 'followup') {
        throw validationFailed('Only reception and follow-up users have doctor assignments');
      }
      if (doctorIds.length > 0) {
        const ok = await tx.query<{ n: number }>(`SELECT count(*)::int AS n FROM doctors WHERE id = ANY($1::uuid[]) AND active`, [
          doctorIds,
        ]);
        if ((ok.rows[0]?.n ?? 0) !== doctorIds.length) throw validationFailed('Every doctor must exist and be active');
      }
      await setAssignedDoctorIds(tx, userId, doctorIds);
      await writeAudit(tx, {
        actorId: ctx.user.userId,
        actorRole: ctx.user.role,
        operation: 'staff.assignments',
        entityType: 'user',
        entityId: userId,
        previous: { doctorIds: u.doctorIds },
        next: { doctorIds },
        correlationId: ctx.correlationId,
      });
      const out = await this.one(tx, userId);
      if (!out) throw notFound('Staff member');
      return out;
    });
  }

  private async one(db: Queryable, userId: string): Promise<StaffMember | null> {
    const res = await db.query(`${STAFF_SQL} AND u.id = $1`, [userId]);
    return res.rows[0] ? mapStaff(res.rows[0]) : null;
  }
}
