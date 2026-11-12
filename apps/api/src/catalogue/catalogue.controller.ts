import { Body, Controller, Get, Inject, Param, Patch, Post, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import {
  CreateSessionRequest,
  SessionListQuery,
  UpdateCapacityRequest,
  type Doctor,
  type QueuePolicy,
  type Session,
  type SlotAvailability,
} from '@hqms/contracts';
import {
  createSession,
  getDoctor,
  getLatestPolicy,
  getSession,
  listAppointmentsBySession,
  listDoctors,
  listSessions,
  lockCapacity,
  lockDoctor,
  lockSession,
  updateCapacity,
  withTransaction,
  writeAudit,
  type Pool,
} from '@hqms/db';
import { CLOCK, DB_POOL } from '../common/tokens.js';
import type { Clock } from '../common/clock.js';
import { conflict, notFound, validationFailed } from '../common/errors.js';
import type { RequestCtx } from '../common/request-context.js';
import { UuidPipe, ZodPipe } from '../common/zod.pipe.js';
import { AccessPolicy } from '../access/access-policy.service.js';
import { ALL_ROLES, Ctx, Roles } from '../identity/auth.decorators.js';
import type { CreateSessionRequestDto, SessionListQueryDto } from '../common/types.js';
import { slotTimes } from '../scheduling/slots.js';

/** Doctors, sessions, capacity and the current policy (FR-02). */
@Controller()
export class CatalogueController {
  constructor(
    @Inject(DB_POOL) private readonly pool: Pool,
    @Inject(CLOCK) private readonly clock: Clock,
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
    const sessions = await listSessions(this.pool, {
      ...query,
      ...(user.role !== 'patient' && scope !== null ? { doctorIds: scope } : {}),
    });
    if (user.role !== 'patient') return sessions;
    const now = this.clock.now().getTime();
    return sessions.filter(
      (s) => (s.status === 'scheduled' || s.status === 'open') && new Date(s.endsAt).getTime() > now,
    );
  }

  @Roles(...ALL_ROLES)
  @Get('sessions/:id')
  async get(@Ctx() ctx: RequestCtx, @Param('id', new UuidPipe()) id: string): Promise<Session> {
    return this.readableSession(ctx, id);
  }

  /** Slot times from starts_at every slot_minutes; a slot is unavailable when an active appointment holds it. */
  @Roles(...ALL_ROLES)
  @Get('sessions/:id/slots')
  async slots(@Ctx() ctx: RequestCtx, @Param('id', new UuidPipe()) id: string): Promise<SlotAvailability> {
    const session = await this.readableSession(ctx, id);
    const held = await listAppointmentsBySession(this.pool, id, { statuses: ['booked', 'checked_in', 'completed'] });
    const taken = new Set(held.map((a) => new Date(a.scheduledAt).getTime()));
    return {
      sessionId: id,
      slots: slotTimes(session).map((at) => ({ scheduledAt: at, available: !taken.has(new Date(at).getTime()) })),
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
    const session = await getSession(this.pool, id);
    if (!session) throw notFound('Session');
    return session;
  }

  private async readableSession(ctx: RequestCtx, id: string): Promise<Session> {
    const session = await getSession(this.pool, id);
    if (!session) throw notFound('Session');
    if (ctx.user.role !== 'patient') this.access.assertDoctorScope(ctx.user, session.doctorId);
    return session;
  }
}
