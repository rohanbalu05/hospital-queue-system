import { Inject, Injectable } from '@nestjs/common';
import type { CallNextResult, QueueEntry } from '@hqms/contracts';
import {
  enqueueJob,
  getPolicyById,
  getSession,
  lockDoctor,
  lockSession,
  required,
  sqlState,
  writeAudit,
  writeOutbox,
  bumpQueueVersion,
  type IdempotentResult,
  type Pool,
  type Tx,
} from '@hqms/db';
import { assertTransition, classifyArrival, computeEligibleAt, selectNext, type Policy } from '@hqms/domain';
import { APP_CONFIG, CLOCK, DB_POOL } from '../common/tokens.js';
import type { AppConfig } from '../common/config.js';
import type { Clock } from '../common/clock.js';
import { conflict, notFound } from '../common/errors.js';
import { localDate } from '../common/http.js';
import type { RequestCtx } from '../common/request-context.js';
import { AccessPolicy } from '../access/access-policy.service.js';
import { toDomainPolicy } from '../scheduling/shared.js';
import { assertVersion, runCommand } from './command.js';
import type {
  QueueEntryActionRequestDto,
  ReEnterRequest,
  SetPriorityRequestDto,
} from './dto.js';
import {
  cancelCallTimeoutJob,
  insertDecision,
  lockEntry,
  readActiveForDoctor,
  readDecision,
  readEntry,
  readGuards,
  readWaiting,
  setPointerAndBump,
  toCandidate,
  toQueueEntry,
} from './queue.repo.js';

/** Constraint behind "one active called/in-service allocation per doctor" (Table 13, D-005). */
const DOCTOR_ACTIVE_UQ = 'queue_entries_doctor_active_uq';

@Injectable()
export class QueueService {
  constructor(
    @Inject(DB_POOL) private readonly pool: Pool,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(AccessPolicy) private readonly access: AccessPolicy,
  ) {}

  /**
   * FR-06 / FR-07. One transaction: lock doctor -> lock session -> re-read everything under the locks.
   * The doctor lock serialises call-next across ALL of the doctor's sessions, so overlapping sessions
   * cannot both call; the partial unique index on queue_entries is the backstop (23505 -> DOCTOR_OCCUPIED).
   */
  async callNext(ctx: RequestCtx, sessionId: string, key: string): Promise<IdempotentResult<CallNextResult>> {
    const { user } = ctx;
    const pre = await getSession(this.pool, sessionId);
    if (!pre) throw notFound('Session');
    this.access.assertDoctorScope(user, pre.doctorId);

    return runCommand<CallNextResult>(this.pool, ctx, 'queue.call_next', key, { sessionId }, async (tx) => {
      const doctor = await lockDoctor(tx, pre.doctorId);
      const session = await lockSession(tx, sessionId);
      const now = this.clock.now();
      const policy = toDomainPolicy(required(await getPolicyById(tx, session.policyId), 'policy'));

      // Non-preemptive: the doctor's outstanding allocation (any session) blocks a new call.
      const active = await readActiveForDoctor(tx, doctor.id);
      if (active) {
        throw conflict('DOCTOR_OCCUPIED', 'The doctor already has a patient called or in consultation', {
          token: active.token,
          state: active.state,
          sessionId: active.sessionId,
        });
      }

      let opened = false;
      if (session.status === 'scheduled') {
        // The first call of the day opens the session (decision D-023: no separate step needed to start work).
        if (localDate(now, this.config.hospitalTz) !== session.sessionDate) {
          throw conflict('SESSION_NOT_CALLABLE', 'This session is not today', { status: session.status });
        }
        await tx.query(`UPDATE sessions SET status = 'open', version = version + 1, updated_at = now() WHERE id = $1`, [
          session.id,
        ]);
        await writeAudit(tx, {
          actorId: user.userId,
          actorRole: user.role,
          operation: 'session.open',
          entityType: 'session',
          entityId: session.id,
          previous: { status: 'scheduled' },
          next: { status: 'open' },
          reason: 'Opened by the first call',
          policyVersion: policy.version,
          correlationId: ctx.correlationId,
        });
        opened = true;
      } else if (session.status !== 'open') {
        throw conflict('SESSION_NOT_CALLABLE', `The session is ${session.status}; resume or open it first`, {
          status: session.status,
        });
      }

      const waiting = await readWaiting(tx, session.id);
      const selection = selectNext(
        {
          entries: waiting.map(toCandidate),
          rotationPointer: session.rotationPointer,
          sessionCallable: true,
          doctorOccupied: false,
        },
        policy,
        now,
      );
      const byId = new Map(waiting.map((w) => [w.id, w]));
      const candidates = selection.eligibleIds.map((id) => {
        const w = byId.get(id);
        return {
          id,
          token: w?.token ?? null,
          group: w?.group ?? null,
          eligibleAt: w?.eligibleAt ?? null,
          seq: w?.seq ?? null,
          priorityClass: w?.priorityClass ?? null,
        };
      });
      const decisionBase = {
        sessionId: session.id,
        doctorId: doctor.id,
        reason: selection.reason,
        rotationSlot: selection.rotationSlot,
        pointerBefore: selection.pointerBefore,
        pointerAfter: selection.pointerAfter,
        policyVersion: policy.version,
        explanation: selection.explanation,
        candidates,
        decidedAt: now,
        decidedBy: user.userId,
      };

      if (selection.candidateId === null) {
        // Nothing to call: the decision is still recorded (FR-06); only an auto-open changes visible state.
        const queueVersion = opened ? await bumpQueueVersion(tx, session.id) : session.queueVersion;
        const decisionId = await insertDecision(tx, { ...decisionBase, queueEntryId: null, queueVersion });
        return { status: 200, body: { decision: await readDecision(tx, decisionId), entry: null } };
      }

      const entry = await lockEntry(tx, selection.candidateId);
      if (entry.state !== 'waiting' || entry.sessionId !== session.id) {
        throw conflict('CONFLICT', 'The selected patient is no longer waiting; try again');
      }
      assertTransition('queueEntry', entry.state, 'called');
      try {
        await tx.query(
          `UPDATE queue_entries
              SET state = 'called', called_at = $2, call_count = call_count + 1, version = version + 1, updated_at = $2
            WHERE id = $1`,
          [entry.id, now],
        );
      } catch (err) {
        if (sqlState(err) === '23505' && (err as { constraint?: string }).constraint === DOCTOR_ACTIVE_UQ) {
          throw conflict('DOCTOR_OCCUPIED', 'The doctor already has a patient called or in consultation');
        }
        throw err;
      }
      const queueVersion = await setPointerAndBump(tx, session.id, selection.pointerAfter);
      const decisionId = await insertDecision(tx, { ...decisionBase, queueEntryId: entry.id, queueVersion });
      const callCount = entry.callCount + 1;

      await writeAudit(tx, {
        actorId: user.userId,
        actorRole: user.role,
        operation: 'queue.call_next',
        entityType: 'queue_entry',
        entityId: entry.id,
        previous: { state: 'waiting', version: entry.version, rotationPointer: selection.pointerBefore },
        next: {
          state: 'called',
          version: entry.version + 1,
          token: entry.token,
          reason: selection.reason,
          rotationPointer: selection.pointerAfter,
          queueVersion,
        },
        reason: selection.explanation,
        policyVersion: policy.version,
        correlationId: ctx.correlationId,
      });
      await writeOutbox(tx, {
        eventType: 'QueuePatientCalled',
        entityType: 'queue_entry',
        entityId: entry.id,
        entityVersion: entry.version + 1,
        sessionId: session.id,
        patientId: entry.patientId,
        payload: { queueVersion, token: entry.token, room: doctor.room },
      });
      await enqueueJob(tx, {
        jobType: 'call_timeout',
        payload: { queueEntryId: entry.id, calledAt: now.toISOString() },
        runAt: new Date(now.getTime() + policy.calledTimeoutSec * 1000),
        dedupeKey: `call_timeout:${entry.id}:${callCount}`,
      });

      const fresh = required(await readEntry(tx, entry.id), 'queue entry');
      return {
        status: 200,
        body: { decision: await readDecision(tx, decisionId), entry: toQueueEntry(fresh) },
      };
    });
  }

  /** FR-08: manual skip of a called patient (before the 2-minute timeout does it). */
  skip(ctx: RequestCtx, entryId: string, body: QueueEntryActionRequestDto, key: string | undefined) {
    return this.entryCommand(ctx, entryId, 'queue.skip', key, body, async (tx, entry, s) => {
      assertVersion(body.expectedVersion, entry.version, 'The queue entry');
      assertTransition('queueEntry', entry.state, 'skipped');
      const now = this.clock.now();
      await tx.query(
        `UPDATE queue_entries SET state = 'skipped', skipped_at = $2, version = version + 1, updated_at = $2 WHERE id = $1`,
        [entry.id, now],
      );
      await cancelCallTimeoutJob(tx, entry.id, entry.callCount);
      return this.finish(tx, ctx, s.policy, entry, {
        operation: 'queue.skip',
        eventType: 'QueuePatientSkipped',
        reason: body.reason ?? 'Skipped manually by staff',
        eventExtra: {},
        next: { state: 'skipped' },
      });
    });
  }

  /** FR-08: a waiting patient who is not present is marked absent (kept in the session, off the order). */
  absent(ctx: RequestCtx, entryId: string, body: QueueEntryActionRequestDto, key: string | undefined) {
    return this.entryCommand(ctx, entryId, 'queue.absent', key, body, async (tx, entry, s) => {
      assertVersion(body.expectedVersion, entry.version, 'The queue entry');
      assertTransition('queueEntry', entry.state, 'absent');
      await tx.query(`UPDATE queue_entries SET state = 'absent', version = version + 1, updated_at = $2 WHERE id = $1`, [
        entry.id,
        this.clock.now(),
      ]);
      return this.finish(tx, ctx, s.policy, entry, {
        operation: 'queue.absent',
        eventType: 'QueuePatientSkipped',
        reason: body.reason ?? 'Marked absent',
        eventExtra: { kind: 'absent' },
        next: { state: 'absent' },
      });
    });
  }

  /**
   * FR-08-b: a skipped or absent patient returns. The SAME queue entry goes back to waiting with fresh
   * eligibility; call_count, called_at and skipped_at are kept as history.
   *
   * Late rule: a group-A patient who is past scheduled time + grace needs reception's confirmation
   * (`admitLate: true`); the entry then follows walk-in ordering (group W, ordered by this acceptance
   * time). No second capacity place is consumed: the patient already holds the place consumed at their
   * first check-in, and consumed places never reopen (D-023). Without confirmation -> 409
   * LATE_ARRIVAL_REQUIRES_REVIEW.
   */
  reEnter(ctx: RequestCtx, entryId: string, body: ReEnterRequest, key: string | undefined) {
    return this.entryCommand(ctx, entryId, 'queue.re_enter', key, body, async (tx, entry, s) => {
      assertVersion(body.expectedVersion, entry.version, 'The queue entry');
      assertTransition('queueEntry', entry.state, 'waiting');
      if (s.status !== 'scheduled' && s.status !== 'open' && s.status !== 'paused') {
        throw conflict('SESSION_NOT_CALLABLE', `The session is ${s.status}; the patient cannot re-enter it`, {
          status: s.status,
        });
      }
      const now = this.clock.now();
      const eligibleAt = new Date(computeEligibleAt({ kind: 're_entry', reEnteredAt: now }, s.policy));
      let toGroup = entry.group;
      let reason = body.reason ?? 'Re-entered the queue';
      if (
        entry.group === 'A' &&
        entry.scheduledAt !== null &&
        classifyArrival({ scheduledAt: new Date(entry.scheduledAt), arrivedAt: now }, s.policy) === 'late_requires_review'
      ) {
        if (body.admitLate !== true) {
          throw conflict(
            'LATE_ARRIVAL_REQUIRES_REVIEW',
            'The patient is past the grace period; staff must confirm and admit them as a late arrival',
            {
              minutesLate: Math.floor((now.getTime() - new Date(entry.scheduledAt).getTime()) / 60_000),
              graceMinutes: s.policy.lateGraceMin,
              scheduledAt: entry.scheduledAt,
            },
          );
        }
        toGroup = 'W';
        reason = `${reason}; late return admitted by staff under walk-in ordering`;
      }
      if (toGroup !== entry.group) {
        // Walk-in ordering uses the accepted check-in time: use this acceptance, not the original check-in.
        await tx.query(
          `UPDATE queue_entries SET queue_group = 'W', checked_in_at = $2 WHERE id = $1`,
          [entry.id, now],
        );
        await tx.query(`UPDATE visits SET kind = 'late_admission', updated_at = $2 WHERE id = $1`, [entry.visitId, now]);
      }
      await tx.query(
        `UPDATE queue_entries SET state = 'waiting', eligible_at = $2, version = version + 1, updated_at = $3 WHERE id = $1`,
        [entry.id, eligibleAt, now],
      );
      return this.finish(tx, ctx, s.policy, entry, {
        operation: 'queue.re_enter',
        eventType: 'QueueEntryReentered',
        reason,
        eventExtra: { group: toGroup },
        next: { state: 'waiting', group: toGroup, eligibleAt: eligibleAt.toISOString(), callCount: entry.callCount },
      });
    });
  }

  /**
   * FR-15 override trail: a clinical priority class, set or cleared by the DOCTOR only (reception is a
   * non-clinical actor -> 403 by the route). Never touches the active consultation (non-preemptive).
   */
  setPriority(ctx: RequestCtx, entryId: string, body: SetPriorityRequestDto, key: string | undefined) {
    return this.entryCommand(ctx, entryId, 'queue.priority', key, body, async (tx, entry, s) => {
      assertVersion(body.expectedVersion, entry.version, 'The queue entry');
      if (entry.state !== 'waiting' && entry.state !== 'skipped' && entry.state !== 'absent') {
        throw conflict('CONFLICT', `Priority can only be set on a patient who has not been seen (state ${entry.state})`, {
          state: entry.state,
        });
      }
      const now = this.clock.now();
      if (body.priorityClass === null) {
        await tx.query(
          `UPDATE queue_entries SET priority_class = NULL, priority_reason = NULL, priority_set_by = NULL,
                  priority_set_at = NULL, version = version + 1, updated_at = $2 WHERE id = $1`,
          [entry.id, now],
        );
      } else {
        await tx.query(
          `UPDATE queue_entries SET priority_class = $2, priority_reason = $3, priority_set_by = $4,
                  priority_set_at = $5, version = version + 1, updated_at = $5 WHERE id = $1`,
          [entry.id, body.priorityClass, body.reason, ctx.user.userId, now],
        );
      }
      return this.finish(tx, ctx, s.policy, entry, {
        operation: 'queue.priority',
        eventType: 'QueuePriorityChanged',
        reason: body.reason,
        eventExtra: { priorityClass: body.priorityClass },
        previousExtra: { priorityClass: entry.priorityClass, priorityReason: entry.priorityReason },
        next: { priorityClass: body.priorityClass },
      });
    });
  }

  // -------------------------------------------------------------------------

  /** Shared preamble: scope check, doctor -> session locks, then lock and re-read the entry under them. */
  private async entryCommand(
    ctx: RequestCtx,
    entryId: string,
    operation: string,
    key: string | undefined,
    identity: unknown,
    work: (
      tx: Tx,
      entry: Awaited<ReturnType<typeof lockEntry>>,
      session: { status: 'scheduled' | 'open' | 'paused' | 'unavailable' | 'closed'; policy: Policy },
    ) => Promise<{ status: number; body: QueueEntry }>,
  ): Promise<IdempotentResult<QueueEntry>> {
    const guards = await readGuards(this.pool, entryId, 'entry');
    if (!guards) throw notFound('Queue entry');
    this.access.assertDoctorScope(ctx.user, guards.doctorId);
    return runCommand(this.pool, ctx, operation, key, { entryId, identity }, async (tx) => {
      await lockDoctor(tx, guards.doctorId);
      const session = await lockSession(tx, guards.sessionId);
      const policy = toDomainPolicy(required(await getPolicyById(tx, session.policyId), 'policy'));
      const entry = await lockEntry(tx, entryId);
      return work(tx, entry, { status: session.status, policy });
    });
  }

  /** Common tail of an entry command: bump, audit, outbox, and the fresh staff projection. */
  private async finish(
    tx: Tx,
    ctx: RequestCtx,
    policy: Policy,
    before: Awaited<ReturnType<typeof lockEntry>>,
    a: {
      operation: string;
      eventType: 'QueuePatientSkipped' | 'QueueEntryReentered' | 'QueuePriorityChanged';
      reason: string;
      eventExtra: Record<string, string | number | boolean | null>;
      previousExtra?: Record<string, unknown>;
      next: Record<string, unknown>;
    },
  ): Promise<{ status: number; body: QueueEntry }> {
    const queueVersion = await bumpQueueVersion(tx, before.sessionId);
    await writeAudit(tx, {
      actorId: ctx.user.userId,
      actorRole: ctx.user.role,
      operation: a.operation,
      entityType: 'queue_entry',
      entityId: before.id,
      previous: { state: before.state, version: before.version, token: before.token, ...(a.previousExtra ?? {}) },
      next: { ...a.next, version: before.version + 1, queueVersion },
      reason: a.reason,
      policyVersion: policy.version,
      correlationId: ctx.correlationId,
    });
    await writeOutbox(tx, {
      eventType: a.eventType,
      entityType: 'queue_entry',
      entityId: before.id,
      entityVersion: before.version + 1,
      sessionId: before.sessionId,
      patientId: before.patientId,
      payload: { queueVersion, token: before.token, ...a.eventExtra },
    });
    const fresh = required(await readEntry(tx, before.id), 'queue entry');
    return { status: 200, body: toQueueEntry(fresh) };
  }
}
