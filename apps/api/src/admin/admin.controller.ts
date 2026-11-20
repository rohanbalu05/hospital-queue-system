import { randomInt } from 'node:crypto';
import { Body, Controller, Get, HttpCode, Inject, Param, Post, Put } from '@nestjs/common';
import {
  CreateStaffRequest,
  SetAssignmentsRequest,
  StaffStatusRequest,
  type StaffCredentials,
  type StaffMember,
} from '@hqms/contracts';
import {
  hashPassword,
  setAssignedDoctorIds,
  withTransaction,
  writeAudit,
  type Pool,
  type Queryable,
  type Tx,
} from '@hqms/db';
import { conflict, notFound, validationFailed } from '../common/errors.js';
import type { RequestCtx } from '../common/request-context.js';
import { DB_POOL } from '../common/tokens.js';
import { UuidPipe, ZodPipe } from '../common/zod.pipe.js';
import { Ctx, Roles } from '../identity/auth.decorators.js';

const STAFF_SQL = `
  SELECT u.id, u.display_name, u.email, u.role, u.active, u.doctor_id,
         CASE WHEN u.role = 'doctor' THEN CASE WHEN u.doctor_id IS NULL THEN ARRAY[]::uuid[] ELSE ARRAY[u.doctor_id] END
              WHEN u.role IN ('reception','followup') THEN
                COALESCE((SELECT array_agg(sa.doctor_id ORDER BY sa.doctor_id) FROM staff_assignments sa WHERE sa.user_id = u.id), ARRAY[]::uuid[])
              ELSE ARRAY[]::uuid[] END AS doctor_ids
    FROM users u
   WHERE u.role <> 'patient'`;

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- pg row
const mapStaff = (r: any): StaffMember => ({
  userId: r.id,
  displayName: r.display_name,
  email: r.email,
  role: r.role,
  doctorIds: r.doctor_ids,
  active: r.active,
  doctorId: r.doctor_id ?? null,
});

/**
 * One-time temporary password: 20 characters from an alphabet without look-alikes (no 0/O, 1/l/I), drawn with
 * crypto.randomInt (rejection-sampled, uniform), shown as five groups of four. About 115 bits. It is returned once
 * in the response body and is never logged, audited or stored anywhere but as an argon2 hash.
 */
const PASSWORD_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
export function generateTemporaryPassword(): string {
  const chars: string[] = [];
  for (let i = 0; i < 20; i += 1) chars.push(PASSWORD_ALPHABET[randomInt(PASSWORD_ALPHABET.length)] as string);
  return (chars.join('').match(/.{4}/g) as string[]).join('-');
}

/**
 * Admin staff management (FR-01, PR-42): who works for which doctor, plus the account lifecycle. Admin only; every
 * change is audited (never with password material).
 *
 * Create and reset-password are deliberately NOT idempotent: the response carries a one-time password, and an
 * idempotency record would have to store that body in the database. A retried create after a lost response gets 409
 * (the email exists); the admin then resets the password to get fresh credentials.
 */
@Controller('admin/staff')
export class AdminController {
  constructor(@Inject(DB_POOL) private readonly pool: Pool) {}

  /** Every staff account, active or not (the admin needs the deactivated ones to reactivate them). */
  @Roles('admin')
  @Get()
  async list(): Promise<StaffMember[]> {
    const res = await this.pool.query(`${STAFF_SQL} ORDER BY u.active DESC, u.role, u.display_name, u.id`);
    return res.rows.map(mapStaff);
  }

  @Roles('admin')
  @Post()
  async create(
    @Ctx() ctx: RequestCtx,
    @Body(new ZodPipe(CreateStaffRequest)) body: CreateStaffRequest,
  ): Promise<StaffCredentials> {
    if (body.role !== 'doctor' && (body.doctorId || body.newDoctor)) {
      throw validationFailed('doctorId and newDoctor are only for doctor accounts');
    }
    if ((body.role === 'doctor' || body.role === 'admin') && (body.doctorIds?.length ?? 0) > 0) {
      throw validationFailed('Doctor and admin accounts have no doctor assignments');
    }
    const doctorIds = [...new Set(body.doctorIds ?? [])].sort();
    const temporaryPassword = generateTemporaryPassword();
    const passwordHash = await hashPassword(temporaryPassword);
    const userId = await withTransaction(this.pool, async (tx) => {
      const actor = await tx.query<{ hospital_id: string }>(`SELECT hospital_id FROM users WHERE id = $1`, [ctx.user.userId]);
      const hospitalId = actor.rows[0]?.hospital_id;
      if (!hospitalId) throw notFound('Admin');
      const taken = await tx.query(`SELECT 1 FROM users WHERE lower(email) = lower($1)`, [body.email]);
      if ((taken.rowCount ?? 0) > 0) throw conflict('CONFLICT', 'A user with this email already exists');
      if (doctorIds.length > 0) {
        const ok = await tx.query<{ n: number }>(`SELECT count(*)::int AS n FROM doctors WHERE id = ANY($1::uuid[]) AND active`, [doctorIds]);
        if ((ok.rows[0]?.n ?? 0) !== doctorIds.length) throw validationFailed('Every doctor must exist and be active');
      }
      let linkedDoctorId: string | null = null;
      let createdDoctor = false;
      if (body.role === 'doctor') {
        if (body.doctorId) {
          const d = await tx.query<{ active: boolean; has_login: boolean }>(
            `SELECT d.active, EXISTS (SELECT 1 FROM users u WHERE u.doctor_id = d.id) AS has_login FROM doctors d WHERE d.id = $1 FOR UPDATE OF d`,
            [body.doctorId],
          );
          const row = d.rows[0];
          if (!row || !row.active) throw notFound('Doctor');
          if (row.has_login) throw conflict('CONFLICT', 'This doctor already has a login');
          linkedDoctorId = body.doctorId;
        } else if (body.newDoctor) {
          const created = await tx.query<{ id: string }>(
            `INSERT INTO doctors (hospital_id, full_name, department, room) VALUES ($1, $2, $3, $4) RETURNING id`,
            [hospitalId, body.displayName, body.newDoctor.department, body.newDoctor.room],
          );
          linkedDoctorId = created.rows[0]?.id ?? null;
          createdDoctor = true;
        }
      }
      let id: string;
      try {
        const ins = await tx.query<{ id: string }>(
          `INSERT INTO users (hospital_id, email, display_name, role, password_hash, doctor_id)
           VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
          [hospitalId, body.email, body.displayName, body.role, passwordHash, linkedDoctorId],
        );
        id = ins.rows[0]?.id as string;
      } catch (err) {
        // A concurrent create of the same email (or doctor) slipped between the check and the insert.
        if ((err as { code?: string }).code === '23505') throw conflict('CONFLICT', 'A user with this email already exists');
        throw err;
      }
      if (doctorIds.length > 0) await setAssignedDoctorIds(tx, id, doctorIds);
      await writeAudit(tx, {
        actorId: ctx.user.userId,
        actorRole: ctx.user.role,
        operation: 'staff.create',
        entityType: 'user',
        entityId: id,
        next: { role: body.role, email: body.email, doctorId: linkedDoctorId, createdDoctor, doctorIds },
        correlationId: ctx.correlationId,
      });
      return id;
    });
    return { member: await this.mustOne(this.pool, userId), temporaryPassword };
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
      return this.mustOne(tx, userId);
    });
  }

  /**
   * Deactivate: the account cannot sign in and every open login session is revoked. An admin cannot deactivate
   * themself, and the last active admin cannot be deactivated (409). Repeating it changes nothing.
   */
  @Roles('admin')
  @Post(':userId/deactivate')
  @HttpCode(200)
  async deactivate(
    @Ctx() ctx: RequestCtx,
    @Param('userId', new UuidPipe()) userId: string,
    @Body(new ZodPipe(StaffStatusRequest)) body: StaffStatusRequest,
  ): Promise<StaffMember> {
    return withTransaction(this.pool, async (tx) => {
      const target = await this.lockStaff(tx, userId);
      if (userId === ctx.user.userId) throw conflict('CONFLICT', 'You cannot deactivate your own account');
      if (target.active) {
        if (target.role === 'admin') {
          // Lock every active admin so two parallel deactivations cannot both pass the count.
          const admins = await tx.query<{ id: string }>(`SELECT id FROM users WHERE role = 'admin' AND active ORDER BY id FOR UPDATE`);
          if (admins.rows.filter((a) => a.id !== userId).length === 0) {
            throw conflict('CONFLICT', 'The last active admin cannot be deactivated');
          }
        }
        await tx.query(`UPDATE users SET active = false WHERE id = $1`, [userId]);
        await this.revokeSessions(tx, userId);
        await this.audit(tx, ctx, 'staff.deactivate', userId, { active: true }, { active: false }, body.reason);
      }
      return this.mustOne(tx, userId);
    });
  }

  @Roles('admin')
  @Post(':userId/activate')
  @HttpCode(200)
  async activate(
    @Ctx() ctx: RequestCtx,
    @Param('userId', new UuidPipe()) userId: string,
    @Body(new ZodPipe(StaffStatusRequest)) body: StaffStatusRequest,
  ): Promise<StaffMember> {
    return withTransaction(this.pool, async (tx) => {
      const target = await this.lockStaff(tx, userId);
      if (!target.active) {
        await tx.query(`UPDATE users SET active = true WHERE id = $1`, [userId]);
        await this.audit(tx, ctx, 'staff.activate', userId, { active: false }, { active: true }, body.reason);
      }
      return this.mustOne(tx, userId);
    });
  }

  /** New one-time temporary password (argon2 hash stored); every open login session of the user is revoked. */
  @Roles('admin')
  @Post(':userId/reset-password')
  @HttpCode(200)
  async resetPassword(
    @Ctx() ctx: RequestCtx,
    @Param('userId', new UuidPipe()) userId: string,
    @Body(new ZodPipe(StaffStatusRequest)) body: StaffStatusRequest,
  ): Promise<StaffCredentials> {
    const temporaryPassword = generateTemporaryPassword();
    const passwordHash = await hashPassword(temporaryPassword);
    await withTransaction(this.pool, async (tx) => {
      await this.lockStaff(tx, userId);
      await tx.query(`UPDATE users SET password_hash = $2, identity_provider = 'local' WHERE id = $1`, [userId, passwordHash]);
      await this.revokeSessions(tx, userId);
      await this.audit(tx, ctx, 'staff.reset_password', userId, undefined, undefined, body.reason);
    });
    return { member: await this.mustOne(this.pool, userId), temporaryPassword };
  }

  /** The staff row, locked; patients are not staff (404). */
  private async lockStaff(tx: Tx, userId: string): Promise<{ role: string; active: boolean }> {
    const r = await tx.query<{ role: string; active: boolean }>(`SELECT role, active FROM users WHERE id = $1 AND role <> 'patient' FOR UPDATE`, [userId]);
    const row = r.rows[0];
    if (!row) throw notFound('Staff member');
    return row;
  }

  private async revokeSessions(tx: Tx, userId: string): Promise<void> {
    await tx.query(`UPDATE auth_sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL`, [userId]);
  }

  private audit(
    tx: Tx,
    ctx: RequestCtx,
    operation: string,
    userId: string,
    previous: Record<string, unknown> | undefined,
    next: Record<string, unknown> | undefined,
    reason: string,
  ) {
    return writeAudit(tx, {
      actorId: ctx.user.userId,
      actorRole: ctx.user.role,
      operation,
      entityType: 'user',
      entityId: userId,
      ...(previous ? { previous } : {}),
      ...(next ? { next } : {}),
      reason,
      correlationId: ctx.correlationId,
    });
  }

  private async one(db: Queryable, userId: string): Promise<StaffMember | null> {
    const res = await db.query(`${STAFF_SQL} AND u.id = $1`, [userId]);
    return res.rows[0] ? mapStaff(res.rows[0]) : null;
  }

  private async mustOne(db: Queryable, userId: string): Promise<StaffMember> {
    const m = await this.one(db, userId);
    if (!m) throw notFound('Staff member');
    return m;
  }
}
