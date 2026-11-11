import { Inject, Injectable } from '@nestjs/common';
import type { QueueEntry } from '@hqms/contracts';
import {
  bumpQueueVersion,
  getAppointment,
  getPolicyById,
  getServiceEstimate,
  lockDoctor,
  lockSession,
  required,
  setAppointmentStatus,
  upsertServiceEstimate,
  writeAudit,
  writeOutbox,
  type IdempotentResult,
  type Pool,
} from '@hqms/db';
import { assertTransition, initialEstimator, recordConsultation } from '@hqms/domain';
import { CLOCK, DB_POOL } from '../common/tokens.js';
import type { Clock } from '../common/clock.js';
import { notFound } from '../common/errors.js';
import type { RequestCtx } from '../common/request-context.js';
import { AccessPolicy } from '../access/access-policy.service.js';
import { toDomainPolicy } from '../scheduling/shared.js';
import { assertVersion, runCommand } from './command.js';
import type { VisitActionRequestDto } from './dto.js';
import { cancelCallTimeoutJob, lockEntry, readEntry, readGuards, toQueueEntry } from './queue.repo.js';

/** A single consultation longer than this is capped before it enters the EWMA (clock faults, forgotten complete). */
export const MAX_CONSULTATION_MINUTES = 180;

@Injectable()
export class ConsultationService {
  constructor(
    @Inject(DB_POOL) private readonly pool: Pool,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(AccessPolicy) private readonly access: AccessPolicy,
  ) {}

  /** FR-08: called -> in_service. Doctor of the visit only. `expectedVersion` is the queue entry version. */
  async start(
    ctx: RequestCtx,
    visitId: string,
    body: VisitActionRequestDto,
    key: string | undefined,
  ): Promise<IdempotentResult<QueueEntry>> {
    const guards = await readGuards(this.pool, visitId, 'visit');
    if (!guards) throw notFound('Visit');
    this.access.assertDoctorScope(ctx.user, guards.doctorId);

    return runCommand(this.pool, ctx, 'consultation.start', key, { visitId, body }, async (tx) => {
      await lockDoctor(tx, guards.doctorId);
      const session = await lockSession(tx, guards.sessionId);
      const policy = toDomainPolicy(required(await getPolicyById(tx, session.policyId), 'policy'));
      const entry = await lockEntry(tx, visitId, 'visit'); // re-read under the locks
      assertVersion(body.expectedVersion, entry.version, 'The queue entry');
      assertTransition('queueEntry', entry.state, 'in_service');
      assertTransition('visit', entry.visitStatus as 'open', 'in_service');
      const now = this.clock.now();

      await tx.query(`UPDATE queue_entries SET state = 'in_service', version = version + 1, updated_at = $2 WHERE id = $1`, [
        entry.id,
        now,
      ]);
      await tx.query(
        `UPDATE visits SET status = 'in_service', started_at = $2, version = version + 1, updated_at = $2 WHERE id = $1`,
        [entry.visitId, now],
      );
      await cancelCallTimeoutJob(tx, entry.id, entry.callCount);
      const queueVersion = await bumpQueueVersion(tx, session.id);
      await writeAudit(tx, {
        actorId: ctx.user.userId,
        actorRole: ctx.user.role,
        operation: 'consultation.start',
        entityType: 'visit',
        entityId: entry.visitId,
        previous: { visitStatus: 'open', entryState: 'called' },
        next: { visitStatus: 'in_service', entryState: 'in_service', startedAt: now.toISOString(), queueVersion },
        policyVersion: policy.version,
        correlationId: ctx.correlationId,
      });
      await writeOutbox(tx, {
        eventType: 'ConsultationStarted',
        entityType: 'visit',
        entityId: entry.visitId,
        entityVersion: entry.visitVersion + 1,
        sessionId: session.id,
        patientId: entry.patientId,
        payload: { queueVersion, token: entry.token },
      });
      return { status: 200, body: toQueueEntry(required(await readEntry(tx, entry.id), 'queue entry')) };
    });
  }

  /**
   * FR-08: in_service -> completed. The visit and the appointment (if any) complete together; the
   * allocation stays consumed (consumed places never reopen). The consultation duration feeds the EWMA.
   */
  async complete(
    ctx: RequestCtx,
    visitId: string,
    body: VisitActionRequestDto,
    key: string | undefined,
  ): Promise<IdempotentResult<QueueEntry>> {
    const guards = await readGuards(this.pool, visitId, 'visit');
    if (!guards) throw notFound('Visit');
    this.access.assertDoctorScope(ctx.user, guards.doctorId);

    return runCommand(this.pool, ctx, 'consultation.complete', key, { visitId, body }, async (tx) => {
      await lockDoctor(tx, guards.doctorId);
      const session = await lockSession(tx, guards.sessionId);
      const policy = toDomainPolicy(required(await getPolicyById(tx, session.policyId), 'policy'));
      const entry = await lockEntry(tx, visitId, 'visit');
      assertVersion(body.expectedVersion, entry.version, 'The queue entry');
      assertTransition('queueEntry', entry.state, 'completed');
      assertTransition('visit', entry.visitStatus as 'in_service', 'completed');
      const now = this.clock.now();

      await tx.query(`UPDATE queue_entries SET state = 'completed', version = version + 1, updated_at = $2 WHERE id = $1`, [
        entry.id,
        now,
      ]);
      await tx.query(
        `UPDATE visits SET status = 'completed', completed_at = $2, version = version + 1, updated_at = $2 WHERE id = $1`,
        [entry.visitId, now],
      );
      if (entry.appointmentId) {
        const appt = await getAppointment(tx, entry.appointmentId);
        if (appt) {
          assertTransition('appointment', appt.status, 'completed');
          await setAppointmentStatus(tx, appt.id, 'completed');
        }
      }

      // EWMA (FR-10): duration in minutes, sanitised (> 0, capped), folded in with the session policy's alpha.
      let estimate: { meanMinutes: number; samples: number } | null = null;
      let durationMin: number | null = null;
      if (entry.startedAt) {
        const raw = (now.getTime() - new Date(entry.startedAt).getTime()) / 60_000;
        if (Number.isFinite(raw) && raw > 0) {
          durationMin = Math.min(raw, MAX_CONSULTATION_MINUTES);
          const stored = await getServiceEstimate(tx, entry.doctorId);
          const current = stored ? { meanMinutes: stored.meanMinutes, samples: stored.samples } : initialEstimator(policy);
          const next = recordConsultation(current, durationMin, policy);
          await upsertServiceEstimate(tx, { doctorId: entry.doctorId, ...next });
          estimate = next;
        }
      }

      const queueVersion = await bumpQueueVersion(tx, session.id);
      await writeAudit(tx, {
        actorId: ctx.user.userId,
        actorRole: ctx.user.role,
        operation: 'consultation.complete',
        entityType: 'visit',
        entityId: entry.visitId,
        previous: { visitStatus: 'in_service', entryState: 'in_service' },
        next: {
          visitStatus: 'completed',
          entryState: 'completed',
          completedAt: now.toISOString(),
          durationMinutes: durationMin,
          estimatorMeanMinutes: estimate?.meanMinutes ?? null,
          queueVersion,
        },
        policyVersion: policy.version,
        correlationId: ctx.correlationId,
      });
      await writeOutbox(tx, {
        eventType: 'ConsultationCompleted',
        entityType: 'visit',
        entityId: entry.visitId,
        entityVersion: entry.visitVersion + 1,
        sessionId: session.id,
        patientId: entry.patientId,
        payload: { queueVersion, token: entry.token },
      });
      return { status: 200, body: toQueueEntry(required(await readEntry(tx, entry.id), 'queue entry')) };
    });
  }
}
