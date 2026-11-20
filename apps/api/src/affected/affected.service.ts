import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  deriveAvailability,
  type AffectedPatients,
  type AppointmentAlternatives,
  type MoveAffectedRequest,
  type MoveAffectedResult,
  type MoveOutcome,
} from '@hqms/contracts';
import {
  admitWalkin,
  bumpQueueVersion,
  consumeAllocation,
  getAppointment,
  getPolicyById,
  getSessionRecord,
  hashRequest,
  lockCapacities,
  lockDoctors,
  lockSessions,
  reserveBooked,
  withTransaction,
  writeAudit,
  writeOutbox,
  ConflictError,
  DatabaseUnavailableError,
  IdempotencyConflictError,
  NotFoundError,
  type Pool,
  type SessionLockRow,
} from '@hqms/db';
import { assertTransition, InvalidTransitionError } from '@hqms/domain';
import { APP_CONFIG, CLOCK, DB_POOL } from '../common/tokens.js';
import type { AppConfig } from '../common/config.js';
import type { Clock } from '../common/clock.js';
import { ApiException, conflict, notFound, validationFailed } from '../common/errors.js';
import { hasLivePlace } from '../common/live-place.js';
import { localDate } from '../common/http.js';
import type { RequestCtx } from '../common/request-context.js';
import { AccessPolicy } from '../access/access-policy.service.js';
import { hasActiveAppointment, insertQueueEntry, takeQueuePosition } from '../arrivals/arrivals.repo.js';
import { lockEntry, readEntry } from '../queue/queue.repo.js';
import { AppointmentsService } from '../scheduling/appointments.service.js';
import {
  carryEntryState,
  findAlternatives,
  insertTransferVisit,
  readInQueue,
  readNotArrived,
  retireTransferredEntry,
} from './affected.repo.js';

type ItemKind = 'appointment' | 'queue_entry';

@Injectable()
export class AffectedService {
  private readonly log = new Logger('AffectedService');

  constructor(
    @Inject(DB_POOL) private readonly pool: Pool,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(AccessPolicy) private readonly access: AccessPolicy,
    @Inject(AppointmentsService) private readonly appointments: AppointmentsService,
  ) {}

  /**
   * GET /appointments/{id}/alternatives: the owning patient, or staff in scope of the appointment's doctor.
   * The patient's one click is the existing reschedule with the alternative's sessionId.
   */
  async alternativesFor(ctx: RequestCtx, appointmentId: string): Promise<AppointmentAlternatives> {
    const { user } = ctx;
    const appt = await getAppointment(this.pool, appointmentId);
    if (!appt) throw notFound('Appointment');
    this.access.assertAppointmentAccess(user, appt);
    const source = await getSessionRecord(this.pool, appt.sessionId);
    if (!source) throw notFound('Session');
    const now = this.clock.now();
    const alternatives = await findAlternatives(this.pool, {
      sourceDoctorId: source.session.doctorId,
      department: source.session.department,
      now,
      today: localDate(now, this.config.hospitalTz),
      minArrivalWindowMin: this.config.minArrivalWindowMin,
      excludePatientId: appt.patientId,
    });
    return {
      appointmentId,
      sourceAvailability: deriveAvailability(source.availability, now, { includeReason: user.role !== 'patient' }),
      alternatives,
    };
  }

  /** GET /sessions/{id}/affected: reception in scope of the doctor, admin (the route guard keeps everyone else out). */
  async affected(ctx: RequestCtx, sessionId: string): Promise<AffectedPatients> {
    const record = await getSessionRecord(this.pool, sessionId);
    if (!record) throw notFound('Session');
    const { session } = record;
    this.access.assertDoctorScope(ctx.user, session.doctorId);
    const now = this.clock.now();
    const [notArrived, inQueue, alternatives] = await Promise.all([
      readNotArrived(this.pool, sessionId),
      readInQueue(this.pool, sessionId),
      findAlternatives(this.pool, {
        sourceDoctorId: session.doctorId,
        department: session.department,
        now,
        today: localDate(now, this.config.hospitalTz),
        minArrivalWindowMin: this.config.minArrivalWindowMin,
      }),
    ]);
    return {
      sessionId,
      doctorName: session.doctorName,
      department: session.department,
      availability: deriveAvailability(record.availability, now, { includeReason: true }),
      notArrived,
      inQueue,
      alternatives,
    };
  }

  /**
   * POST /sessions/{id}/affected/move (D-033). Checks that hold for the whole batch run first; then every item is
   * its own short transaction (lock order: doctors by id, sessions by id, capacities), keyed by the batch key and
   * the item id so a retried batch replays moved items instead of moving them again. One item failing (full target,
   * a patient already placed there, a patient called meanwhile) never fails the batch: it is reported as skipped.
   */
  async move(ctx: RequestCtx, sessionId: string, body: MoveAffectedRequest, key: string): Promise<MoveAffectedResult> {
    const { user } = ctx;
    const sourceRec = await getSessionRecord(this.pool, sessionId);
    if (!sourceRec) throw notFound('Session');
    const source = sourceRec.session;
    this.access.assertDoctorScope(user, source.doctorId);
    const targetRec = await getSessionRecord(this.pool, body.targetSessionId);
    if (!targetRec) throw notFound('Session');
    const target = targetRec.session;
    this.access.assertDoctorScope(user, target.doctorId);
    if (target.id === source.id) throw validationFailed('The target session is the session being moved from');
    assertAway(source.status);
    assertTargetOpen(target.status, target.endsAt, this.clock.now());

    const results: MoveOutcome[] = [];
    for (const id of new Set(body.appointmentIds)) {
      results.push(await this.moveAppointment(ctx, source, target, id, key));
    }
    for (const id of new Set(body.queueEntryIds)) {
      results.push(await this.transferEntry(ctx, source, target, id, key));
    }
    const moved = results.filter((r) => r.outcome === 'moved').length;
    return {
      sourceSessionId: source.id,
      targetSessionId: target.id,
      moved,
      skipped: results.length - moved,
      results,
    };
  }

  private async moveAppointment(
    ctx: RequestCtx,
    source: { id: string; doctorId: string },
    target: { id: string; doctorId: string },
    appointmentId: string,
    key: string,
  ): Promise<MoveOutcome> {
    const { user } = ctx;
    try {
      const pre = await getAppointment(this.pool, appointmentId);
      if (!pre || pre.sessionId !== source.id) throw notFound('Appointment in this session');
      const done = await withTransaction(
        this.pool,
        async (tx) => {
          await lockDoctors(tx, [source.doctorId, target.doctorId]);
          const locked = await lockSessions(tx, [source.id, target.id]);
          await lockCapacities(tx, [source.id, target.id]);
          const { src, tgt } = pick(locked, source.id, target.id);
          assertAway(src.status);
          const created = await this.appointments.rescheduleInTx(tx, ctx, appointmentId, tgt, undefined);
          const body: MoveOutcome = {
            kind: 'appointment',
            sourceId: appointmentId,
            outcome: 'moved',
            code: null,
            message: null,
            newAppointmentId: created.id,
            newQueueEntryId: null,
            token: null,
            scheduledAt: new Date(created.scheduledAt).toISOString(),
          };
          return { status: 200, body };
        },
        {
          idempotency: {
            actorId: user.userId,
            operation: 'affected.move.appointment',
            key: `${key}:a:${appointmentId}`,
            requestHash: hashRequest({ source: source.id, target: target.id, appointmentId }),
          },
        },
      );
      return done.body;
    } catch (err) {
      return this.skipped('appointment', appointmentId, err);
    }
  }

  /**
   * Transfer one checked-in patient (D-033). Old entry -> cancelled and old visit -> transferred; a new visit
   * (kind `transfer`, transferred_from_visit_id) and entry in the target keep the group, the original check-in,
   * schedule and eligibility times (and any assigned priority or parked state) and consume a place of the same
   * kind (A -> booked, W -> walk-in). The patient's original appointment is not touched.
   */
  private async transferEntry(
    ctx: RequestCtx,
    source: { id: string; doctorId: string; sessionDate: string },
    target: { id: string; doctorId: string; sessionDate: string },
    entryId: string,
    key: string,
  ): Promise<MoveOutcome> {
    const { user } = ctx;
    try {
      const pre = await readEntry(this.pool, entryId);
      if (!pre || pre.sessionId !== source.id) throw notFound('Queue entry in this session');
      const done = await withTransaction(
        this.pool,
        async (tx) => {
          await lockDoctors(tx, [source.doctorId, target.doctorId]);
          const locked = await lockSessions(tx, [source.id, target.id]);
          await lockCapacities(tx, [target.id]);
          const { src, tgt } = pick(locked, source.id, target.id);
          assertAway(src.status);
          const now = this.clock.now();
          assertTargetOpen(tgt.status, tgt.endsAt, now);
          if (tgt.sessionDate !== src.sessionDate) {
            throw conflict(
              'CONFLICT',
              'A patient who is already here can only be transferred to a session of the same day',
              {
                sourceDate: src.sessionDate,
                targetDate: tgt.sessionDate,
              },
            );
          }
          const entry = await lockEntry(tx, entryId);
          assertTransition('queueEntry', entry.state, 'cancelled');
          assertTransition('visit', entry.visitStatus as 'open', 'transferred');
          if (
            (await hasLivePlace(tx, tgt.id, entry.patientId)) ||
            (await hasActiveAppointment(tx, tgt.id, entry.patientId))
          ) {
            throw conflict('CONFLICT', 'This patient already has a place or an appointment in the target session');
          }
          // The place: A -> booked (reserved then consumed, the patient is here), W -> walk-in (consumed on admit).
          let allocationId: string;
          if (entry.group === 'A') {
            allocationId = await reserveBooked(tx, tgt.id);
            await consumeAllocation(tx, allocationId);
          } else {
            allocationId = await admitWalkin(tx, tgt.id);
          }
          const visit = await insertTransferVisit(tx, {
            patientId: entry.patientId,
            sessionId: tgt.id,
            doctorId: tgt.doctorId,
            allocationId,
            checkedInAt: entry.checkedInAt,
            checkedInBy: user.userId,
            fromVisitId: entry.visitId,
          });
          const pos = await takeQueuePosition(tx, tgt.id, entry.group);
          const newEntryId = await insertQueueEntry(tx, {
            visitId: visit.id,
            sessionId: tgt.id,
            doctorId: tgt.doctorId,
            group: entry.group,
            token: pos.token,
            seq: pos.seq,
            scheduledAt: entry.scheduledAt,
            checkedInAt: new Date(entry.checkedInAt),
            eligibleAt: new Date(entry.eligibleAt),
          });
          await carryEntryState(tx, newEntryId, entry.id);
          await retireTransferredEntry(tx, entry.id, entry.visitId);
          const sourceVersion = await bumpQueueVersion(tx, src.id);
          const policy = await getPolicyById(tx, tgt.policyId);

          await writeAudit(tx, {
            actorId: user.userId,
            actorRole: user.role,
            operation: 'visit.transfer_out',
            entityType: 'visit',
            entityId: entry.visitId,
            previous: { status: entry.visitStatus, queueEntryId: entry.id, token: entry.token, sessionId: src.id },
            next: { status: 'transferred', toSessionId: tgt.id, queueVersion: sourceVersion },
            reason: 'doctor unavailable: patient transferred',
            correlationId: ctx.correlationId,
          });
          await writeAudit(tx, {
            actorId: user.userId,
            actorRole: user.role,
            operation: 'visit.transfer_in',
            entityType: 'visit',
            entityId: visit.id,
            previous: { fromVisitId: entry.visitId, fromSessionId: src.id, token: entry.token },
            next: {
              kind: 'transfer',
              group: entry.group,
              token: pos.token,
              sessionId: tgt.id,
              queueVersion: pos.queueVersion,
            },
            policyVersion: policy?.version ?? null,
            correlationId: ctx.correlationId,
          });
          await writeOutbox(tx, {
            eventType: 'QueuePatientTransferred',
            entityType: 'queue_entry',
            entityId: newEntryId,
            entityVersion: 1,
            sessionId: tgt.id,
            patientId: entry.patientId,
            payload: { queueVersion: pos.queueVersion, token: pos.token, fromSessionId: src.id },
          });
          const body: MoveOutcome = {
            kind: 'queue_entry',
            sourceId: entryId,
            outcome: 'moved',
            code: null,
            message: null,
            newAppointmentId: null,
            newQueueEntryId: newEntryId,
            token: pos.token,
            scheduledAt: entry.scheduledAt === null ? null : new Date(entry.scheduledAt).toISOString(),
          };
          return { status: 200, body };
        },
        {
          idempotency: {
            actorId: user.userId,
            operation: 'affected.move.queue_entry',
            key: `${key}:q:${entryId}`,
            requestHash: hashRequest({ source: source.id, target: target.id, entryId }),
          },
        },
      );
      return done.body;
    } catch (err) {
      return this.skipped('queue_entry', entryId, err);
    }
  }

  /**
   * An item that could not be moved. Business refusals become `skipped` with their code; reusing the batch key for
   * a different request and a lost database connection still fail the request (nothing about them is per-item).
   */
  private skipped(kind: ItemKind, sourceId: string, err: unknown): MoveOutcome {
    if (err instanceof IdempotencyConflictError || err instanceof DatabaseUnavailableError) throw err;
    let code: string;
    let message: string;
    if (err instanceof ApiException) {
      code = err.code;
      message = err.message;
    } else if (err instanceof ConflictError) {
      code = err.code;
      message = err.message;
    } else if (err instanceof NotFoundError) {
      code = 'NOT_FOUND';
      message = err.message;
    } else if (err instanceof InvalidTransitionError) {
      code = 'INVALID_TRANSITION';
      message = `This patient cannot be moved from their current state (${err.from})`;
    } else {
      // Unknown failure of one item: report it for this item only, never the values involved.
      this.log.error(`move item ${kind} failed: ${err instanceof Error ? err.name : 'unknown error'}`);
      code = 'INTERNAL';
      message = 'This patient could not be moved; try again';
    }
    return {
      kind,
      sourceId,
      outcome: 'skipped',
      code,
      message,
      newAppointmentId: null,
      newQueueEntryId: null,
      token: null,
      scheduledAt: null,
    };
  }
}

function assertAway(status: SessionLockRow['status'] | string): void {
  if (status !== 'unavailable' && status !== 'paused') {
    throw conflict('INVALID_TRANSITION', 'Patients can only be moved while the doctor is away or unavailable', {
      machine: 'session',
      from: status,
    });
  }
}

function assertTargetOpen(status: string, endsAt: string, now: Date): void {
  if ((status !== 'scheduled' && status !== 'open') || new Date(endsAt).getTime() <= now.getTime()) {
    throw conflict('SESSION_NOT_CALLABLE', 'The target session is not accepting patients', { status });
  }
}

function pick(
  locked: SessionLockRow[],
  sourceId: string,
  targetId: string,
): { src: SessionLockRow; tgt: SessionLockRow } {
  const src = locked.find((s) => s.id.toLowerCase() === sourceId.toLowerCase());
  const tgt = locked.find((s) => s.id.toLowerCase() === targetId.toLowerCase());
  if (!src || !tgt) throw notFound('Session');
  return { src, tgt };
}
