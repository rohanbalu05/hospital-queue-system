import { assertTransition } from '@hqms/domain';
import {
  lockCapacity,
  lockDoctor,
  lockSession,
  releaseAllocation,
  bumpQueueVersion,
  withTransaction,
  writeAudit,
  writeOutbox,
} from '@hqms/db';
import { PermanentJobError, type HandlerResult, type JobContext, type JobHandler, type JobRow } from '../types.js';

/*
 * Operational timers (report Table 7, section 6.6). Both handlers follow the same recipe:
 *
 *   1. Unlocked probe to learn the guard ids (doctor, session); these never change for a row.
 *   2. One short transaction: lock doctor -> session (-> capacity), RE-READ the entity under the lock.
 *   3. Check state/version first: anything other than the exact state this job was created for is a
 *      no-op, so redelivery, a duplicate job or a race with a staff action never repeats an effect.
 *   4. Not due yet by the injected clock -> {retryAt}; the runner reschedules without burning an attempt.
 *   5. Domain change + audit row + outbox event (+ queue_version bump) commit together; nothing external
 *      happens while locks are held.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function requireUuid(payload: Record<string, unknown>, key: string): string {
  const v = payload[key];
  if (typeof v !== 'string' || !UUID.test(v)) throw new PermanentJobError(`payload.${key} must be a uuid`);
  return v;
}

function requireInstant(payload: Record<string, unknown>, key: string): Date {
  const v = payload[key];
  const d = typeof v === 'string' ? new Date(v) : null;
  if (!d || Number.isNaN(d.getTime())) throw new PermanentJobError(`payload.${key} must be an ISO timestamp`);
  return d;
}

/**
 * called_at has microsecond precision in Postgres while a payload built in JS carries milliseconds, so the
 * match tolerates one second. A genuine second call of the same entry is minutes later (it needs
 * skip -> re-entry -> call), far outside that window.
 */
const CALLED_AT_TOLERANCE_MS = 1000;

export interface CallTimeoutPayload {
  queueEntryId: string;
  calledAt: string;
}

/**
 * call_timeout {queueEntryId, calledAt}: CALLED -> SKIPPED once `called_timeout_sec` (policy) passed with
 * no answer. Frees the doctor: the partial unique index only covers called / in_service entries.
 */
export const handleCallTimeout: JobHandler = async (job: JobRow, ctx: JobContext): Promise<HandlerResult> => {
  const entryId = requireUuid(job.payload, 'queueEntryId');
  const calledAt = requireInstant(job.payload, 'calledAt');

  const probe = await ctx.pool.query<{ doctor_id: string; session_id: string }>(
    `SELECT doctor_id, session_id FROM queue_entries WHERE id = $1`,
    [entryId],
  );
  const guards = probe.rows[0];
  if (!guards) {
    ctx.log.warn('call_timeout.entry_missing');
    return { cancelled: true, reason: 'queue entry not found' };
  }

  const now = ctx.now();
  return withTransaction(ctx.pool, async (tx): Promise<HandlerResult> => {
    await lockDoctor(tx, guards.doctor_id);
    await lockSession(tx, guards.session_id);

    const res = await tx.query(
      `SELECT qe.state, qe.called_at, qe.version, qe.token, qe.session_id, v.patient_id,
              pol.called_timeout_sec, pol.version AS policy_version
         FROM queue_entries qe
         JOIN visits v ON v.id = qe.visit_id
         JOIN sessions s ON s.id = qe.session_id
         JOIN queue_policies pol ON pol.id = s.policy_id
        WHERE qe.id = $1
          FOR NO KEY UPDATE OF qe`,
      [entryId],
    );
    const e = res.rows[0];
    if (!e) return { cancelled: true, reason: 'queue entry not found' };

    // State/version check: only the exact call this job was created for may be timed out.
    if (e.state !== 'called' || !e.called_at) return; // already started, skipped, completed...: nothing to do
    const entryCalledAt = new Date(e.called_at);
    if (Math.abs(entryCalledAt.getTime() - calledAt.getTime()) > CALLED_AT_TOLERANCE_MS) return; // a newer call owns its own job

    const dueAt = new Date(entryCalledAt.getTime() + e.called_timeout_sec * 1000);
    if (now < dueAt) return { retryAt: dueAt };

    assertTransition('queueEntry', 'called', 'skipped');
    const nowIso = now.toISOString();
    const upd = await tx.query<{ version: number }>(
      `UPDATE queue_entries
          SET state = 'skipped', skipped_at = $2::timestamptz, version = version + 1, updated_at = $2::timestamptz
        WHERE id = $1 AND state = 'called'
        RETURNING version`,
      [entryId, nowIso],
    );
    const newVersion = upd.rows[0]?.version;
    if (newVersion === undefined) return; // lost a race we hold the locks against; treat as already handled
    const queueVersion = await bumpQueueVersion(tx, e.session_id);
    await writeAudit(tx, {
      actorId: null,
      actorRole: 'system',
      operation: 'queue.call_timeout',
      entityType: 'queue_entry',
      entityId: entryId,
      previous: { state: 'called', version: e.version },
      next: { state: 'skipped', version: newVersion },
      reason: `No answer within ${Math.round(e.called_timeout_sec / 60)} minutes`,
      policyVersion: e.policy_version,
    });
    await writeOutbox(tx, {
      eventType: 'QueuePatientSkipped',
      entityType: 'queue_entry',
      entityId: entryId,
      entityVersion: newVersion,
      sessionId: e.session_id,
      patientId: e.patient_id,
      payload: { queueVersion, token: e.token },
    });
    ctx.log.info('call_timeout.skipped', { queueEntryId: entryId });
  });
};

export interface ReservationReleasePayload {
  appointmentId: string;
}

/**
 * reservation_release {appointmentId}: a booked appointment whose patient has not checked in by
 * scheduled_at + late_grace_min becomes 'missed' and its reserved place returns to the pool (Table 7,
 * "A missed reservation may be released after the grace rule"). Consumed allocations never reopen, so a
 * checked-in appointment is a no-op. A patient who arrives afterwards is a late admission (API side).
 */
export const handleReservationRelease: JobHandler = async (job: JobRow, ctx: JobContext): Promise<HandlerResult> => {
  const appointmentId = requireUuid(job.payload, 'appointmentId');

  const probe = await ctx.pool.query<{ doctor_id: string; session_id: string }>(
    `SELECT doctor_id, session_id FROM appointments WHERE id = $1`,
    [appointmentId],
  );
  const guards = probe.rows[0];
  if (!guards) {
    ctx.log.warn('reservation_release.appointment_missing');
    return { cancelled: true, reason: 'appointment not found' };
  }

  const now = ctx.now();
  return withTransaction(ctx.pool, async (tx): Promise<HandlerResult> => {
    await lockDoctor(tx, guards.doctor_id);
    await lockSession(tx, guards.session_id);
    await lockCapacity(tx, guards.session_id);

    const res = await tx.query(
      `SELECT a.status, a.version, a.scheduled_at, a.allocation_id, a.patient_id,
              pol.late_grace_min, pol.version AS policy_version
         FROM appointments a
         JOIN sessions s ON s.id = a.session_id
         JOIN queue_policies pol ON pol.id = s.policy_id
        WHERE a.id = $1
          FOR NO KEY UPDATE OF a`,
      [appointmentId],
    );
    const a = res.rows[0];
    if (!a) return { cancelled: true, reason: 'appointment not found' };

    // State/version check: only a still-booked appointment can be released. checked_in, cancelled,
    // rescheduled, completed or an earlier release are all no-ops.
    if (a.status !== 'booked') return;

    const dueAt = new Date(new Date(a.scheduled_at).getTime() + a.late_grace_min * 60_000);
    if (now < dueAt) return { retryAt: dueAt };

    assertTransition('appointment', 'booked', 'missed');
    const nowIso = now.toISOString();
    const upd = await tx.query<{ version: number }>(
      `UPDATE appointments
          SET status = 'missed', version = version + 1, updated_at = $2::timestamptz
        WHERE id = $1 AND status = 'booked'
        RETURNING version`,
      [appointmentId, nowIso],
    );
    const newVersion = upd.rows[0]?.version;
    if (newVersion === undefined) return;
    await releaseAllocation(tx, a.allocation_id);
    await writeAudit(tx, {
      actorId: null,
      actorRole: 'system',
      operation: 'appointment.reservation_release',
      entityType: 'appointment',
      entityId: appointmentId,
      previous: { status: 'booked', version: a.version },
      next: { status: 'missed', version: newVersion },
      reason: `Not checked in within ${a.late_grace_min} minutes of the scheduled time`,
      policyVersion: a.policy_version,
    });
    await writeOutbox(tx, {
      eventType: 'ReservationReleased',
      entityType: 'appointment',
      entityId: appointmentId,
      entityVersion: newVersion,
      sessionId: guards.session_id,
      patientId: a.patient_id,
      payload: { reason: 'timer' },
    });
    ctx.log.info('reservation_release.released', { appointmentId });
  });
};
