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
  type SessionLockRow,
  type Tx,
} from '@hqms/db';
import { assertTransition } from '@hqms/domain';
import { CLOCK, DB_POOL } from '../common/tokens.js';
import type { Clock } from '../common/clock.js';
import type { AppointmentListQueryDto, CancelAppointmentRequestDto } from '../common/types.js';
import { conflict, forbidden, notFound, validationFailed } from '../common/errors.js';
import type { RequestCtx } from '../common/request-context.js';
import { AccessPolicy } from '../access/access-policy.service.js';
import { PatientScope } from '../access/patient-scope.service.js';
import { lockTask } from '../followup/followup.repo.js';
import {
  assertBookable,
  assertNoActiveAppointment,
  cancelReservationReleaseJob,
  enrichAppointments,
  firstFreeSlot,
  toAppointment,
  toDomainPolicy,
} from './shared.js';

@Injectable()
export class AppointmentsService {
  constructor(
    @Inject(DB_POOL) private readonly pool: Pool,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(AccessPolicy) private readonly access: AccessPolicy,
    @Inject(PatientScope) private readonly scope: PatientScope,
  ) {}

  /** FR-03: reserve capacity and record the appointment in one transaction (lock order doctor, session, capacity). */
  async book(ctx: RequestCtx, body: BookAppointmentRequest, key: string): Promise<IdempotentResult<Appointment>> {
    const { user } = ctx;
    if (body.followUpTaskId) {
      // FR-14: a return booking goes through exactly the same reservation path (see reserveAndInsert).
      if (user.role !== 'followup' && user.role !== 'admin') throw forbidden('Only follow-up staff book from a follow-up task');
      return this.bookReturn(ctx, body.followUpTaskId, body.sessionId, body.patientId, key, 'appointment.book');
    }
    if (user.role === 'followup') throw forbidden('Follow-up staff book only through a follow-up task');
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
        const appt = await this.reserveAndInsert(tx, ctx, session, patientId, null);
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

  /**
   * FR-14: book the return appointment of a follow-up task. Same path as a normal booking (doctor -> session ->
   * capacity locks, first free slot, one active appointment per patient and session, CAPACITY_FULL as a plain
   * 409: there is no bypass and no extra capacity), plus the two-way link: appointments.follow_up_task_id and
   * follow_up_tasks.return_appointment_id, committed with the booking.
   */
  async bookReturn(
    ctx: RequestCtx,
    taskId: string,
    sessionId: string,
    requestedPatientId: string | undefined,
    key: string,
    operation: string,
  ): Promise<IdempotentResult<Appointment>> {
    const { user } = ctx;
    const pre = await this.pool.query<{ patient_id: string }>(`SELECT patient_id FROM follow_up_tasks WHERE id = $1`, [taskId]);
    const patientId = pre.rows[0]?.patient_id;
    if (!patientId) throw notFound('Follow-up task');
    await this.scope.assertAccess(user, patientId);
    if (requestedPatientId !== undefined && requestedPatientId !== patientId) {
      throw validationFailed('patientId does not match the follow-up task');
    }
    const target = await getSession(this.pool, sessionId);
    if (!target) throw notFound('Session');
    this.access.assertDoctorScope(user, target.doctorId);

    return withTransaction(
      this.pool,
      async (tx) => {
        await lockDoctor(tx, target.doctorId);
        const session = await lockSession(tx, target.id);
        await lockCapacity(tx, target.id);
        // The task row is locked after the guards (it is not a guard): its state is re-read under the lock.
        const task = await lockTask(tx, taskId, this.clock.now());
        if (task.status !== 'open' && task.status !== 'acknowledged') {
          throw conflict('CONFLICT', 'This follow-up task is closed', { status: task.status });
        }
        if (task.returnAppointmentId) {
          const existing = await getAppointment(tx, task.returnAppointmentId);
          if (existing && ['booked', 'checked_in', 'completed'].includes(existing.status)) {
            throw conflict('CONFLICT', 'This follow-up task already has a return appointment', {
              returnAppointmentId: existing.id,
            });
          }
        }
        const appt = await this.reserveAndInsert(tx, ctx, session, task.patientId, taskId);
        await tx.query(
          `UPDATE follow_up_tasks SET return_appointment_id = $2, version = version + 1, updated_at = now() WHERE id = $1`,
          [taskId, appt.id],
        );
        await writeAudit(tx, {
          actorId: user.userId,
          actorRole: user.role,
          operation: 'follow_up.return_booking',
          entityType: 'follow_up_task',
          entityId: taskId,
          previous: { returnAppointmentId: task.returnAppointmentId },
          next: { returnAppointmentId: appt.id, sessionId: session.id, scheduledAt: appt.scheduledAt },
          correlationId: ctx.correlationId,
        });
        await writeOutbox(tx, {
          eventType: 'ReturnAppointmentBooked',
          entityType: 'appointment',
          entityId: appt.id,
          entityVersion: appt.version,
          sessionId: session.id,
          patientId: task.patientId,
          payload: { followUpTaskId: taskId },
        });
        return { status: 201, body: toAppointment(appt) };
      },
      {
        idempotency: {
          actorId: user.userId,
          operation,
          key,
          requestHash: hashRequest({ taskId, sessionId }),
        },
      },
    );
  }

  /**
   * The one reservation path for every booking (patient, reception, return). Caller holds the doctor, session and
   * capacity locks. Reserves the place, inserts the appointment, writes audit + AppointmentBooked and the timer intent.
   */
  private async reserveAndInsert(
    tx: Tx,
    ctx: RequestCtx,
    session: SessionLockRow,
    patientId: string,
    followUpTaskId: string | null,
  ): Promise<AppointmentRecord> {
    const { user } = ctx;
    const now = this.clock.now();
    assertBookable(session, now);
    const policy = await this.policyOf(tx, session.policyId);
    await assertNoActiveAppointment(tx, patientId, session.id);
    const scheduledAt = await firstFreeSlot(tx, session, now, policy.lateGraceMin);
    const allocationId = await reserveBooked(tx, session.id);
    const appt = await insertAppointment(tx, {
      patientId,
      sessionId: session.id,
      doctorId: session.doctorId,
      scheduledAt,
      allocationId,
      bookedBy: user.userId,
      followUpTaskId,
    });
    await writeAudit(tx, {
      actorId: user.userId,
      actorRole: user.role,
      operation: 'appointment.book',
      entityType: 'appointment',
      entityId: appt.id,
      next: { status: appt.status, sessionId: session.id, scheduledAt, followUpTaskId },
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
    return appt;
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
          ...(eventType === 'ReservationReleased' ? { payload: { reason: 'cancelled' } } : {}),
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
        const now = this.clock.now();
        assertBookable(targetSession, now);
        const policy = await this.policyOf(tx, targetSession.policyId);
        await assertNoActiveAppointment(tx, cur.patientId, targetSession.id);

        // Reserve the target first; CAPACITY_FULL here rolls everything back before any write commits.
        const scheduledAt = await firstFreeSlot(tx, targetSession, now, policy.lateGraceMin);
        const allocationId = await reserveBooked(tx, targetSession.id);
        // The original goes to 'rescheduled' before the replacement is inserted (active-appointment index).
        await setAppointmentStatus(tx, cur.id, 'rescheduled', { expectedVersion: cur.version });
        const created = await insertAppointment(tx, {
          patientId: cur.patientId,
          sessionId: targetSession.id,
          doctorId: targetSession.doctorId,
          scheduledAt,
          allocationId,
          bookedBy: user.userId,
          rescheduledFromId: cur.id,
        });
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
          payload: { reason: 'rescheduled' },
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
    const [out] = await enrichAppointments(this.pool, [appt], ctx.user.role !== 'patient');
    if (!out) throw notFound('Appointment');
    return out;
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
    return enrichAppointments(this.pool, rows, user.role !== 'patient');
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
