import { Inject, Injectable } from '@nestjs/common';
import type { Appointment, BookAppointmentRequest, RescheduleAppointmentRequest } from '@hqms/contracts';
import {
  enqueueJob,
  getAppointment,
  getPatient,
  getPolicyById,
  getSession,
  hashRequest,
  insertAppointment,
  listAppointmentsByPatient,
  listAppointmentsBySession,
  lockCapacities,
  lockCapacity,
  lockDoctor,
  lockDoctors,
  lockSession,
  lockSessions,
  releaseAllocation,
  reserveBooked,
  setAppointmentStatus,
  withTransaction,
  writeAudit,
  writeOutbox,
  type AppointmentRecord,
  type IdempotentResult,
  type Pool,
  type Tx,
} from '@hqms/db';
import { assertTransition } from '@hqms/domain';
import { CLOCK, DB_POOL } from '../common/tokens.js';
import type { Clock } from '../common/clock.js';
import type { AppointmentListQueryDto, CancelAppointmentRequestDto } from '../common/types.js';
import { conflict, notFound, validationFailed } from '../common/errors.js';
import type { RequestCtx } from '../common/request-context.js';
import { AccessPolicy } from '../access/access-policy.service.js';
import { assertBookable, cancelReservationReleaseJob, firstFreeSlot, toAppointment, toDomainPolicy } from './shared.js';

@Injectable()
export class AppointmentsService {
  constructor(
    @Inject(DB_POOL) private readonly pool: Pool,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(AccessPolicy) private readonly access: AccessPolicy,
  ) {}

  /** FR-03: reserve capacity and record the appointment in one transaction (lock order doctor, session, capacity). */
  async book(ctx: RequestCtx, body: BookAppointmentRequest, key: string): Promise<IdempotentResult<Appointment>> {
    const { user } = ctx;
    if (body.followUpTaskId) throw validationFailed('Return bookings from a follow-up task are not available yet');
    const patientId = this.access.resolveBookingPatient(user, body.patientId);
    const target = await getSession(this.pool, body.sessionId);
    if (!target) throw notFound('Session');
    if (user.role !== 'patient') this.access.assertDoctorScope(user, target.doctorId);
    if (!(await getPatient(this.pool, patientId))) throw notFound('Patient');

    return withTransaction(
      this.pool,
      async (tx) => {
        await lockDoctor(tx, target.doctorId);
        const session = await lockSession(tx, target.id);
        await lockCapacity(tx, target.id);
        const now = this.clock.now();
        assertBookable(session, now);
        const policy = await this.policyOf(tx, session.policyId);
        const scheduledAt = await firstFreeSlot(tx, session);
        const allocationId = await reserveBooked(tx, session.id);
        const appt = await insertAppointment(tx, {
          patientId,
          sessionId: session.id,
          doctorId: session.doctorId,
          scheduledAt,
          allocationId,
          bookedBy: user.userId,
        });
        await writeAudit(tx, {
          actorId: user.userId,
          actorRole: user.role,
          operation: 'appointment.book',
          entityType: 'appointment',
          entityId: appt.id,
          next: { status: appt.status, sessionId: session.id, scheduledAt },
          policyVersion: policy.version,
          correlationId: ctx.correlationId,
        });
        await writeOutbox(tx, {
          eventType: 'AppointmentBooked',
          entityType: 'appointment',
          entityId: appt.id,
          entityVersion: appt.version,
          sessionId: session.id,
          patientId,
          payload: { scheduledAt },
        });
        await this.scheduleReservationRelease(tx, appt, policy.lateGraceMin);
        return { status: 201, body: toAppointment(appt) };
      },
      {
        idempotency: {
          actorId: user.userId,
          operation: 'appointment.book',
          key,
          requestHash: hashRequest(body),
        },
      },
    );
  }

  /** FR-04: release the place of a booked appointment. Checked-in or completed ones never reopen capacity. */
  async cancel(
    ctx: RequestCtx,
    id: string,
    body: CancelAppointmentRequestDto,
    key: string | undefined,
  ): Promise<IdempotentResult<Appointment>> {
    const { user } = ctx;
    const pre = await getAppointment(this.pool, id);
    if (!pre) throw notFound('Appointment');
    this.access.assertAppointmentAccess(user, pre);

    const work = async (tx: Tx): Promise<{ status: number; body: Appointment }> => {
      await lockDoctor(tx, pre.doctorId);
      const session = await lockSession(tx, pre.sessionId);
      await lockCapacity(tx, pre.sessionId);
      const cur = await getAppointment(tx, id);
      if (!cur) throw notFound('Appointment');
      assertTransition('appointment', cur.status, 'cancelled');
      const updated = await setAppointmentStatus(tx, id, 'cancelled', {
        ...(body.expectedVersion === undefined ? {} : { expectedVersion: body.expectedVersion }),
        cancelReason: body.reason ?? null,
      });
      await releaseAllocation(tx, cur.allocationId);
      await cancelReservationReleaseJob(tx, id);
      const policy = await this.policyOf(tx, session.policyId);
      await writeAudit(tx, {
        actorId: user.userId,
        actorRole: user.role,
        operation: 'appointment.cancel',
        entityType: 'appointment',
        entityId: id,
        previous: { status: cur.status },
        next: { status: 'cancelled' },
        reason: body.reason ?? null,
        policyVersion: policy.version,
        correlationId: ctx.correlationId,
      });
      for (const eventType of ['AppointmentCancelled', 'ReservationReleased'] as const) {
        await writeOutbox(tx, {
          eventType,
          entityType: 'appointment',
          entityId: id,
          entityVersion: updated.version,
          sessionId: cur.sessionId,
          patientId: cur.patientId,
        });
      }
      return { status: 200, body: toAppointment(updated) };
    };

    if (!key) return { ...(await withTransaction(this.pool, work)), replayed: false };
    return withTransaction(this.pool, work, {
      idempotency: {
        actorId: user.userId,
        operation: 'appointment.cancel',
        key,
        requestHash: hashRequest({ id, body }),
      },
    });
  }

  /**
   * FR-04: exchange reservations atomically. All affected guards are taken in one ordered batch
   * (doctors, then sessions, then capacities). The target is reserved FIRST: if it is full the whole
   * transaction rolls back and the original appointment and its allocation are untouched.
   */
  async reschedule(
    ctx: RequestCtx,
    id: string,
    body: RescheduleAppointmentRequest,
    key: string,
  ): Promise<IdempotentResult<Appointment>> {
    const { user } = ctx;
    const pre = await getAppointment(this.pool, id);
    if (!pre) throw notFound('Appointment');
    this.access.assertAppointmentAccess(user, pre);
    const target = await getSession(this.pool, body.targetSessionId);
    if (!target) throw notFound('Session');
    if (user.role !== 'patient') this.access.assertDoctorScope(user, target.doctorId);
    if (target.id === pre.sessionId) throw validationFailed("The target session is the appointment's current session");

    return withTransaction(
      this.pool,
      async (tx) => {
        await lockDoctors(tx, [pre.doctorId, target.doctorId]);
        const locked = await lockSessions(tx, [pre.sessionId, target.id]);
        await lockCapacities(tx, [pre.sessionId, target.id]);
        const targetSession = locked.find((s) => s.id.toLowerCase() === target.id.toLowerCase());
        if (!targetSession) throw notFound('Session');

        const cur = await getAppointment(tx, id);
        if (!cur) throw notFound('Appointment');
        assertTransition('appointment', cur.status, 'rescheduled');
        if (body.expectedVersion !== undefined && cur.version !== body.expectedVersion) {
          throw conflict('CONFLICT', 'Appointment was changed by someone else', {
            expectedVersion: body.expectedVersion,
            currentVersion: cur.version,
          });
        }
        assertBookable(targetSession, this.clock.now());
        const policy = await this.policyOf(tx, targetSession.policyId);

        // Reserve the target first; CAPACITY_FULL here rolls everything back.
        const scheduledAt = await firstFreeSlot(tx, targetSession);
        const allocationId = await reserveBooked(tx, targetSession.id);
        const created = await insertAppointment(tx, {
          patientId: cur.patientId,
          sessionId: targetSession.id,
          doctorId: targetSession.doctorId,
          scheduledAt,
          allocationId,
          bookedBy: user.userId,
          rescheduledFromId: cur.id,
        });
        await setAppointmentStatus(tx, cur.id, 'rescheduled', { expectedVersion: cur.version });
        await releaseAllocation(tx, cur.allocationId);
        await cancelReservationReleaseJob(tx, cur.id);
        await this.scheduleReservationRelease(tx, created, policy.lateGraceMin);

        await writeAudit(tx, {
          actorId: user.userId,
          actorRole: user.role,
          operation: 'appointment.reschedule',
          entityType: 'appointment',
          entityId: created.id,
          previous: { appointmentId: cur.id, sessionId: cur.sessionId, scheduledAt: cur.scheduledAt },
          next: { appointmentId: created.id, sessionId: targetSession.id, scheduledAt },
          policyVersion: policy.version,
          correlationId: ctx.correlationId,
        });
        await writeOutbox(tx, {
          eventType: 'AppointmentRescheduled',
          entityType: 'appointment',
          entityId: created.id,
          entityVersion: created.version,
          sessionId: targetSession.id,
          patientId: cur.patientId,
          payload: { scheduledAt },
        });
        await writeOutbox(tx, {
          eventType: 'ReservationReleased',
          entityType: 'appointment',
          entityId: cur.id,
          entityVersion: cur.version + 1,
          sessionId: cur.sessionId,
          patientId: cur.patientId,
        });
        return { status: 201, body: toAppointment(created) };
      },
      {
        idempotency: {
          actorId: user.userId,
          operation: 'appointment.reschedule',
          key,
          requestHash: hashRequest({ id, body }),
        },
      },
    );
  }

  async get(ctx: RequestCtx, id: string): Promise<Appointment> {
    const appt = await getAppointment(this.pool, id);
    if (!appt) throw notFound('Appointment');
    this.access.assertAppointmentAccess(ctx.user, appt);
    return toAppointment(appt);
  }

  /** Patients list only their own; staff must name a patient or a session and see only their doctors' appointments. */
  async list(ctx: RequestCtx, query: AppointmentListQueryDto): Promise<Appointment[]> {
    const { user } = ctx;
    let rows: AppointmentRecord[];
    if (user.role === 'patient') {
      if (!user.patientId) throw notFound('Patient');
      if (query.patientId !== undefined && query.patientId !== user.patientId) throw notFound('Patient');
      rows = await listAppointmentsByPatient(this.pool, user.patientId);
      if (query.sessionId) rows = rows.filter((a) => a.sessionId === query.sessionId);
    } else if (query.sessionId) {
      const session = await getSession(this.pool, query.sessionId);
      if (!session) throw notFound('Session');
      this.access.assertDoctorScope(user, session.doctorId);
      rows = await listAppointmentsBySession(this.pool, query.sessionId);
      if (query.patientId) rows = rows.filter((a) => a.patientId === query.patientId);
    } else if (query.patientId) {
      rows = (await listAppointmentsByPatient(this.pool, query.patientId)).filter((a) =>
        this.access.canActOnDoctor(user, a.doctorId),
      );
    } else {
      throw validationFailed('patientId or sessionId is required');
    }
    return rows.map(toAppointment);
  }

  private async policyOf(tx: Tx, policyId: string) {
    const policy = await getPolicyById(tx, policyId);
    if (!policy) throw notFound('Policy');
    return toDomainPolicy(policy);
  }

  /** Timer intent (committed with the booking): no-show at scheduled time + late grace frees the place. */
  private async scheduleReservationRelease(tx: Tx, appt: AppointmentRecord, lateGraceMin: number): Promise<void> {
    await enqueueJob(tx, {
      jobType: 'reservation_release',
      payload: { appointmentId: appt.id },
      runAt: new Date(new Date(appt.scheduledAt).getTime() + lateGraceMin * 60_000),
      dedupeKey: `reservation_release:${appt.id}`,
    });
  }
}
