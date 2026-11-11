import { Inject, Injectable } from '@nestjs/common';
import type { AdmitWalkInRequest, ArrivalResult, CheckInRequest, QueueGroup, VisitKind } from '@hqms/contracts';
import {
  admitWalkin,
  consumeAllocation,
  getAppointment,
  getPatient,
  getPolicyById,
  getSession,
  hashRequest,
  lockCapacity,
  lockDoctor,
  lockSession,
  releaseAllocation,
  setAppointmentStatus,
  withTransaction,
  writeAudit,
  writeOutbox,
  type IdempotentResult,
  type Pool,
  type SessionLockRow,
  type Tx,
} from '@hqms/db';
import { assertTransition, classifyArrival, computeEligibleAt } from '@hqms/domain';
import { APP_CONFIG, CLOCK, DB_POOL } from '../common/tokens.js';
import type { AppConfig } from '../common/config.js';
import type { Clock } from '../common/clock.js';
import { conflict, notFound } from '../common/errors.js';
import { localDate } from '../common/http.js';
import type { RequestCtx } from '../common/request-context.js';
import { AccessPolicy } from '../access/access-policy.service.js';
import { cancelReservationReleaseJob, toDomainPolicy } from '../scheduling/shared.js';
import {
  findArrivalByAppointment,
  hasActiveAppointment,
  hasActiveEntry,
  insertQueueEntry,
  insertVisit,
  takeQueuePosition,
} from './arrivals.repo.js';

@Injectable()
export class ArrivalsService {
  constructor(
    @Inject(DB_POOL) private readonly pool: Pool,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(AccessPolicy) private readonly access: AccessPolicy,
  ) {}

  /**
   * FR-05: check an appointment in. One transaction, lock order doctor -> session -> capacity.
   * A repeat returns the existing arrival (200); a new arrival is 201.
   */
  async checkIn(
    ctx: RequestCtx,
    appointmentId: string,
    body: CheckInRequest,
    key: string,
  ): Promise<IdempotentResult<ArrivalResult>> {
    const { user } = ctx;
    const pre = await getAppointment(this.pool, appointmentId);
    if (!pre) throw notFound('Appointment');
    this.access.assertDoctorScope(user, pre.doctorId);

    return withTransaction(
      this.pool,
      async (tx) => {
        await lockDoctor(tx, pre.doctorId);
        const session = await lockSession(tx, pre.sessionId);
        await lockCapacity(tx, pre.sessionId);

        const existing = await findArrivalByAppointment(tx, appointmentId, session.queueVersion);
        if (existing) return { status: 200, body: existing };

        const appt = await getAppointment(tx, appointmentId);
        if (!appt) throw notFound('Appointment');
        assertTransition('appointment', appt.status, 'checked_in'); // booked, or missed (late admission only, below)
        const now = this.clock.now();
        this.assertSessionAcceptsArrivals(session, now);
        if (await hasActiveEntry(tx, session.id, appt.patientId)) {
          throw conflict('CONFLICT', 'This patient already has an active place in this session');
        }

        const policyRow = await getPolicyById(tx, session.policyId);
        if (!policyRow) throw notFound('Policy');
        const policy = toDomainPolicy(policyRow);

        // A 'missed' appointment (the worker released its place after the grace period) is by definition late.
        const alreadyMissed = appt.status === 'missed';
        const arrival = alreadyMissed
          ? 'late_requires_review'
          : classifyArrival({ scheduledAt: new Date(appt.scheduledAt), arrivedAt: now }, policy);
        let kind: VisitKind;
        let group: QueueGroup;
        let allocationId: string;
        let eligibleAt: Date;
        let reason: string | null = null;
        if (arrival === 'on_time') {
          await consumeAllocation(tx, appt.allocationId);
          kind = 'appointment';
          group = 'A';
          allocationId = appt.allocationId;
          eligibleAt = new Date(
            computeEligibleAt(
              { kind: 'appointment', scheduledAt: new Date(appt.scheduledAt), checkedInAt: now },
              policy,
            ),
          );
        } else {
          const minutesLate = Math.floor((now.getTime() - new Date(appt.scheduledAt).getTime()) / 60_000);
          if (body.admitLate !== true) {
            throw conflict(
              'LATE_ARRIVAL_REQUIRES_REVIEW',
              'Arrival is after the grace period; staff must confirm capacity and admit the patient as a late arrival',
              { minutesLate, graceMinutes: policy.lateGraceMin, scheduledAt: appt.scheduledAt },
            );
          }
          // Staff approved: take a walk-in place (CAPACITY_FULL rolls back), give up the missed booked place.
          allocationId = await admitWalkin(tx, session.id);
          // The booked place goes back to the pool unless the worker already released it (missed).
          if (!alreadyMissed && (await releaseAllocation(tx, appt.allocationId)) === 'released') {
            await writeOutbox(tx, {
              eventType: 'ReservationReleased',
              entityType: 'appointment',
              entityId: appt.id,
              entityVersion: appt.version,
              sessionId: session.id,
              patientId: appt.patientId,
              payload: {},
            });
          }
          kind = 'late_admission';
          group = 'W';
          eligibleAt = new Date(computeEligibleAt({ kind: 'late_admission', acceptedAt: now }, policy));
          reason = 'late arrival admitted by staff under walk-in ordering';
        }
        await cancelReservationReleaseJob(tx, appt.id);

        const visit = await insertVisit(tx, {
          patientId: appt.patientId,
          sessionId: session.id,
          doctorId: session.doctorId,
          appointmentId: appt.id,
          allocationId,
          kind,
          checkedInAt: now,
          checkedInBy: user.userId,
        });
        const pos = await takeQueuePosition(tx, session.id, group);
        const queueEntryId = await insertQueueEntry(tx, {
          visitId: visit.id,
          sessionId: session.id,
          doctorId: session.doctorId,
          group,
          token: pos.token,
          seq: pos.seq,
          scheduledAt: appt.scheduledAt,
          checkedInAt: now,
          eligibleAt,
        });
        await setAppointmentStatus(tx, appt.id, 'checked_in');

        const result: ArrivalResult = {
          visitId: visit.id,
          queueEntryId,
          token: pos.token,
          group,
          kind,
          eligibleAt: eligibleAt.toISOString(),
          queueVersion: pos.queueVersion,
        };
        await this.recordArrival(tx, ctx, session, visit, result, policy.version, {
          operation: 'visit.check_in',
          previous: { appointmentStatus: appt.status },
          patientId: appt.patientId,
          appointmentId: appt.id,
          reason,
        });
        return { status: 201, body: result };
      },
      {
        idempotency: {
          actorId: user.userId,
          operation: 'visit.check_in',
          key,
          requestHash: hashRequest({ appointmentId, body }),
        },
      },
    );
  }

  /** FR-05: admit a walk-in against the session's walk-in capacity. */
  async admitWalkIn(
    ctx: RequestCtx,
    sessionId: string,
    body: AdmitWalkInRequest,
    key: string,
  ): Promise<IdempotentResult<ArrivalResult>> {
    const { user } = ctx;
    const pre = await getSession(this.pool, sessionId);
    if (!pre) throw notFound('Session');
    this.access.assertDoctorScope(user, pre.doctorId);
    if (!(await getPatient(this.pool, body.patientId))) throw notFound('Patient');

    return withTransaction(
      this.pool,
      async (tx) => {
        await lockDoctor(tx, pre.doctorId);
        const session = await lockSession(tx, sessionId);
        await lockCapacity(tx, sessionId);
        const now = this.clock.now();
        this.assertSessionAcceptsArrivals(session, now);
        if (await hasActiveEntry(tx, sessionId, body.patientId)) {
          throw conflict('CONFLICT', 'This patient already has an active place in this session');
        }
        if (await hasActiveAppointment(tx, sessionId, body.patientId)) {
          throw conflict(
            'CONFLICT',
            'This patient has an active appointment in this session; check the appointment in instead of admitting a walk-in',
          );
        }
        const policyRow = await getPolicyById(tx, session.policyId);
        if (!policyRow) throw notFound('Policy');
        const policy = toDomainPolicy(policyRow);

        const allocationId = await admitWalkin(tx, sessionId);
        const eligibleAt = new Date(computeEligibleAt({ kind: 'walkin', acceptedAt: now }, policy));
        const visit = await insertVisit(tx, {
          patientId: body.patientId,
          sessionId,
          doctorId: session.doctorId,
          appointmentId: null,
          allocationId,
          kind: 'walkin',
          checkedInAt: now,
          checkedInBy: user.userId,
        });
        const pos = await takeQueuePosition(tx, sessionId, 'W');
        const queueEntryId = await insertQueueEntry(tx, {
          visitId: visit.id,
          sessionId,
          doctorId: session.doctorId,
          group: 'W',
          token: pos.token,
          seq: pos.seq,
          scheduledAt: null,
          checkedInAt: now,
          eligibleAt,
        });
        const result: ArrivalResult = {
          visitId: visit.id,
          queueEntryId,
          token: pos.token,
          group: 'W',
          kind: 'walkin',
          eligibleAt: eligibleAt.toISOString(),
          queueVersion: pos.queueVersion,
        };
        await this.recordArrival(tx, ctx, session, visit, result, policy.version, {
          operation: 'visit.walk_in',
          previous: undefined,
          patientId: body.patientId,
          appointmentId: null,
          reason: null,
        });
        return { status: 201, body: result };
      },
      {
        idempotency: {
          actorId: user.userId,
          operation: 'visit.walk_in',
          key,
          requestHash: hashRequest({ sessionId, body }),
        },
      },
    );
  }

  /** Arrivals are accepted before the doctor opens the session, while open or paused; not once unavailable or closed. */
  private assertSessionAcceptsArrivals(session: SessionLockRow, now: Date): void {
    if (session.status === 'unavailable' || session.status === 'closed') {
      throw conflict('SESSION_NOT_CALLABLE', 'This session is not accepting arrivals', { status: session.status });
    }
    if (localDate(now, this.config.hospitalTz) !== session.sessionDate) {
      throw conflict('CONFLICT', 'Arrivals are only accepted on the day of the session', {
        sessionDate: session.sessionDate,
      });
    }
  }

  /** Audit + domain event for a committed arrival (same transaction as the state change). */
  private async recordArrival(
    tx: Tx,
    ctx: RequestCtx,
    session: SessionLockRow,
    visit: { id: string; version: number },
    result: ArrivalResult,
    policyVersion: number,
    extra: {
      operation: string;
      previous: unknown;
      patientId: string;
      appointmentId: string | null;
      reason: string | null;
    },
  ): Promise<void> {
    await writeAudit(tx, {
      actorId: ctx.user.userId,
      actorRole: ctx.user.role,
      operation: extra.operation,
      entityType: 'visit',
      entityId: visit.id,
      previous: extra.previous,
      next: {
        kind: result.kind,
        group: result.group,
        token: result.token,
        sessionId: session.id,
        eligibleAt: result.eligibleAt,
        ...(extra.appointmentId ? { appointmentId: extra.appointmentId } : {}),
      },
      reason: extra.reason,
      policyVersion,
      correlationId: ctx.correlationId,
    });
    await writeOutbox(tx, {
      eventType: 'VisitCheckedIn',
      entityType: 'visit',
      entityId: visit.id,
      entityVersion: visit.version,
      sessionId: session.id,
      patientId: extra.patientId,
      payload: { queueVersion: result.queueVersion, token: result.token },
    });
  }
}
