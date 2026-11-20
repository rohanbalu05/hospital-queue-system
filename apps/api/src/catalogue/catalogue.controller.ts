import { Body, Controller, Get, Inject, Param, Patch, Post, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import {
  CreateSessionRequest,
  deriveAvailability,
  SessionListQuery,
  UpdateCapacityRequest,
  type Doctor,
  type QueuePolicy,
  type Session,
  type SessionOverlap,
  type SlotAvailability,
} from '@hqms/contracts';
import {
  createSession,
  getDoctor,
  getLatestPolicy,
  getPolicyById,
  getSession,
  getSessionRecord,
  listAppointmentsBySession,
  listDoctors,
  listSessionRecords,
  lockCapacity,
  lockDoctor,
  lockSession,
  updateCapacity,
  withTransaction,
  writeAudit,
  type Pool,
  type SessionRecord,
} from '@hqms/db';
import { APP_CONFIG, CLOCK, DB_POOL } from '../common/tokens.js';
import type { AppConfig } from '../common/config.js';
import type { Clock } from '../common/clock.js';
import { conflict, notFound, validationFailed } from '../common/errors.js';
import type { RequestCtx } from '../common/request-context.js';
import { UuidPipe, ZodPipe } from '../common/zod.pipe.js';
import { AccessPolicy } from '../access/access-policy.service.js';
import { ALL_ROLES, Ctx, Roles } from '../identity/auth.decorators.js';
import type { CreateSessionRequestDto, SessionListQueryDto } from '../common/types.js';
import { isSlotAssignable, slotTimes } from '../scheduling/slots.js';

/** Doctors, sessions, capacity and the current policy (FR-02). */
@Controller()
export class CatalogueController {
  constructor(
    @Inject(DB_POOL) private readonly pool: Pool,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(AccessPolicy) private readonly access: AccessPolicy,
  ) {}

  @Roles(...ALL_ROLES)
  @Get('doctors')
  doctors(): Promise<Doctor[]> {
    return listDoctors(this.pool, { activeOnly: true });
  }

  @Roles(...ALL_ROLES)
  @Get('policies/current')
  async currentPolicy(): Promise<QueuePolicy> {
    const policy = await getLatestPolicy(this.pool);
    if (!policy) throw notFound('Policy');
    return policy;
  }

  /** Patients see every bookable session; staff only sessions of doctors in their scope. */
  @Roles(...ALL_ROLES)
  @Get('sessions')
  async list(
    @Ctx() ctx: RequestCtx,
    @Query(new ZodPipe(SessionListQuery)) query: SessionListQueryDto,
  ): Promise<Session[]> {
    const { user } = ctx;
    const scope = this.access.doctorScope(user);
    const records = await listSessionRecords(this.pool, {
      ...query,
      ...(user.role !== 'patient' && scope !== null ? { doctorIds: scope } : {}),
    });
    const now = this.clock.now();
    const visible =
      user.role !== 'patient'
        ? records
        : records.filter(
            ({ session: s }) =>
              (s.status === 'scheduled' || s.status === 'open') && new Date(s.endsAt).getTime() > now.getTime(),
          );
    return visible.map((r) => this.withAvailability(r, user.role !== 'patient'));
  }

  @Roles(...ALL_ROLES)
  @Get('sessions/:id')
  async get(@Ctx() ctx: RequestCtx, @Param('id', new UuidPipe()) id: string): Promise<Session> {
    return this.withAvailability(await this.readableRecord(ctx, id), ctx.user.role !== 'patient');
  }

  /**
   * Slot times from starts_at every slot_minutes. A slot is unavailable when an active appointment holds it or when
   * booking could not assign it now (D-035: `slot + lateGraceMin < now + MIN_ARRIVAL_WINDOW_MIN`, which includes
   * every slot already in the past).
   */
  @Roles(...ALL_ROLES)
  @Get('sessions/:id/slots')
  async slots(@Ctx() ctx: RequestCtx, @Param('id', new UuidPipe()) id: string): Promise<SlotAvailability> {
    const { session, policyId } = await this.readableRecord(ctx, id);
    const policy = await getPolicyById(this.pool, policyId);
    if (!policy) throw notFound('Policy');
    const held = await listAppointmentsBySession(this.pool, id, { statuses: ['booked', 'checked_in', 'completed'] });
    const taken = new Set(held.map((a) => new Date(a.scheduledAt).getTime()));
    const now = this.clock.now();
    return {
      sessionId: id,
      slots: slotTimes(session).map((at) => ({
        scheduledAt: at,
        available:
          !taken.has(new Date(at).getTime()) &&
          isSlotAssignable(at, now, policy.lateGraceMin, this.config.minArrivalWindowMin),
      })),
      capacity: session.capacity,
    };
  }

  /** Admin: create a session (starts as `scheduled`) with the policy defaults unless capacities are given. */
  @Roles('admin')
  @Post('sessions')
  async create(
    @Ctx() ctx: RequestCtx,
    @Body(new ZodPipe(CreateSessionRequest)) body: CreateSessionRequestDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<Session> {
    if (new Date(body.endsAt).getTime() <= new Date(body.startsAt).getTime()) {
      throw validationFailed('endsAt must be after startsAt');
    }
    const doctor = await getDoctor(this.pool, body.doctorId);
    if (!doctor || !doctor.active) throw notFound('Doctor');
    const id = await withTransaction(this.pool, async (tx) => {
      await lockDoctor(tx, body.doctorId);
      // PR-41 / D-038: a doctor cannot run two sessions at once. scheduled, open, paused and unavailable sessions all
      // block (for an unavailable one the admin reopens it instead). A CLOSED session does not: a doctor whose session
      // was closed early can be given a new one in that window (orchestrator decision).
      // Half-open intervals: a session may start exactly when the previous one ends. Checked under the doctor lock, so
      // two parallel creates cannot both pass.
      const clash = await tx.query<{ id: string; starts_at: string; ends_at: string }>(
        `SELECT id, starts_at, ends_at FROM sessions
          WHERE doctor_id = $1 AND status <> 'closed' AND starts_at < $3::timestamptz AND ends_at > $2::timestamptz
          ORDER BY starts_at LIMIT 1`,
        [body.doctorId, body.startsAt, body.endsAt],
      );
      if (clash.rows[0]) {
        const details: SessionOverlap = {
          reason: 'SESSION_OVERLAP',
          overlappingSessionId: clash.rows[0].id,
          startsAt: new Date(clash.rows[0].starts_at).toISOString(),
          endsAt: new Date(clash.rows[0].ends_at).toISOString(),
        };
        throw conflict('CONFLICT', 'This doctor already has a session at that time', details);
      }
      const created = await createSession(tx, {
        doctorId: body.doctorId,
        sessionDate: body.sessionDate,
        label: body.label,
        startsAt: body.startsAt,
        endsAt: body.endsAt,
        ...(body.bookedCapacity === undefined ? {} : { bookedCapacity: body.bookedCapacity }),
        ...(body.walkinCapacity === undefined ? {} : { walkinCapacity: body.walkinCapacity }),
      });
      if (!created) throw conflict('CONFLICT', 'This doctor already has a session starting at that time');
      await writeAudit(tx, {
        actorId: ctx.user.userId,
        actorRole: ctx.user.role,
        operation: 'session.create',
        entityType: 'session',
        entityId: created,
        next: { doctorId: body.doctorId, startsAt: body.startsAt, endsAt: body.endsAt },
        correlationId: ctx.correlationId,
      });
      return created;
    });
    res.status(201);
    return this.sessionOrThrow(id);
  }

  /** Admin: change capacity. Lock order doctor -> session -> capacity; reductions below usage are 409. */
  @Roles('admin')
  @Patch('sessions/:id/capacity')
  async updateCapacity(
    @Ctx() ctx: RequestCtx,
    @Param('id', new UuidPipe()) id: string,
    @Body(new ZodPipe(UpdateCapacityRequest)) body: UpdateCapacityRequest,
  ): Promise<Session> {
    const pre = await getSession(this.pool, id);
    if (!pre) throw notFound('Session');
    await withTransaction(this.pool, async (tx) => {
      await lockDoctor(tx, pre.doctorId);
      const session = await lockSession(tx, id);
      const before = await lockCapacity(tx, id);
      const after = await updateCapacity(tx, id, body.bookedCapacity, body.walkinCapacity, {
        ...(body.expectedVersion === undefined ? {} : { expectedVersion: body.expectedVersion }),
      });
      await writeAudit(tx, {
        actorId: ctx.user.userId,
        actorRole: ctx.user.role,
        operation: 'session.capacity.update',
        entityType: 'session',
        entityId: session.id,
        previous: { bookedCapacity: before.bookedCapacity, walkinCapacity: before.walkinCapacity },
        next: { bookedCapacity: after.bookedCapacity, walkinCapacity: after.walkinCapacity },
        correlationId: ctx.correlationId,
      });
    });
    return this.sessionOrThrow(id);
  }

  private async sessionOrThrow(id: string): Promise<Session> {
    const record = await getSessionRecord(this.pool, id);
    if (!record) throw notFound('Session');
    return this.withAvailability(record, true); // admin-only callers
  }

  private async readableRecord(ctx: RequestCtx, id: string): Promise<SessionRecord> {
    const record = await getSessionRecord(this.pool, id);
    if (!record) throw notFound('Session');
    if (ctx.user.role !== 'patient') this.access.assertDoctorScope(ctx.user, record.session.doctorId);
    return record;
  }

  /** B4.8: availability derived from the session state (D-032); the free-text reason only for staff reads. */
  private withAvailability(record: SessionRecord, staff: boolean): Session {
    return {
      ...record.session,
      availability: deriveAvailability(record.availability, this.clock.now(), { includeReason: staff }),
    };
  }
}
