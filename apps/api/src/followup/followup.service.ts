import { Inject, Injectable } from '@nestjs/common';
import type { CreateFollowUpTaskRequest, FollowUpTask, ResolveTaskRequest } from '@hqms/contracts';
import { getPatient, writeAudit, writeOutbox, type IdempotentResult, type Pool, type Tx } from '@hqms/db';
import { assertTransition } from '@hqms/domain';
import { AccessPolicy } from '../access/access-policy.service.js';
import { PatientScope } from '../access/patient-scope.service.js';
import type { Clock } from '../common/clock.js';
import { forbidden, notFound, validationFailed, conflict } from '../common/errors.js';
import type { RequestCtx } from '../common/request-context.js';
import { CLOCK, DB_POOL } from '../common/tokens.js';
import { assertVersion, runCommand } from '../queue/command.js';
import type { AcknowledgeTaskRequestDto, CancelTaskRequestDto, FollowUpListQueryDto, PatientFollowUp } from './dto.js';
import { listTasks, listTasksOfPatient, lockTask, readTask } from './followup.repo.js';

const KIND_SUMMARY: Record<string, string> = {
  post_visit: 'The care team will follow up with you after your visit.',
  assistant_escalation: 'The care team will answer your question.',
  document_review: 'The care team is reviewing a document you shared.',
  return_visit: 'The care team will arrange a return visit with you.',
};

/**
 * FR-11 owned follow-up: a task has an owner, a due time, a status and a recorded outcome. It is closed only by a
 * documented disposition (resolve) or a documented cancellation. Overdue is derived from the clock and never
 * changes the status: overdue tasks stay open and listed.
 *
 * A completed consultation does NOT create a task by itself: the doctor (or follow-up staff) creates it
 * explicitly with POST /follow-up-tasks, naming a due time and optionally an owner.
 */
@Injectable()
export class FollowUpService {
  constructor(
    @Inject(DB_POOL) private readonly pool: Pool,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(AccessPolicy) private readonly access: AccessPolicy,
    @Inject(PatientScope) private readonly scope: PatientScope,
  ) {}

  async create(
    ctx: RequestCtx,
    body: CreateFollowUpTaskRequest,
    key: string | undefined,
  ): Promise<IdempotentResult<FollowUpTask>> {
    const { user } = ctx;
    if (body.kind === 'assistant_escalation') {
      throw validationFailed('assistant_escalation tasks are created by the assistant only');
    }
    if (!(await getPatient(this.pool, body.patientId))) throw notFound('Patient');
    await this.scope.assertAccess(user, body.patientId);

    // The doctors this task is "about": the source visit's doctor, else the patient's doctors in the caller's scope.
    let relevantDoctors: string[];
    if (body.sourceVisitId) {
      const v = await this.pool.query<{ patient_id: string; doctor_id: string }>(
        `SELECT patient_id, doctor_id FROM visits WHERE id = $1`,
        [body.sourceVisitId],
      );
      const visit = v.rows[0];
      if (!visit || visit.patient_id !== body.patientId) throw validationFailed('The source visit is not a visit of this patient');
      if (!this.access.canActOnDoctor(user, visit.doctor_id)) throw notFound('Visit');
      relevantDoctors = [visit.doctor_id];
    } else {
      relevantDoctors = await this.scope.scopedDoctorIds(user, body.patientId);
    }
    if (body.ownerId) await this.assertValidOwner(body.ownerId, relevantDoctors);

    return runCommand(this.pool, ctx, 'follow_up.create', key, body, async (tx) => {
      const ins = await tx.query<{ id: string }>(
        `INSERT INTO follow_up_tasks (patient_id, source_visit_id, kind, title, detail, owner_id, due_at, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
        [
          body.patientId,
          body.sourceVisitId ?? null,
          body.kind,
          body.title.trim(),
          body.detail?.trim() || null,
          body.ownerId ?? null,
          body.dueAt,
          user.userId,
        ],
      );
      const id = ins.rows[0]?.id as string;
      await writeAudit(tx, {
        actorId: user.userId,
        actorRole: user.role,
        operation: 'follow_up.create',
        entityType: 'follow_up_task',
        entityId: id,
        next: { status: 'open', kind: body.kind, ownerId: body.ownerId ?? null, dueAt: body.dueAt },
        correlationId: ctx.correlationId,
      });
      await writeOutbox(tx, {
        eventType: 'FollowUpOpened',
        entityType: 'follow_up_task',
        entityId: id,
        entityVersion: 1,
        patientId: body.patientId,
        payload: { kind: body.kind, ownerId: body.ownerId ?? null },
      });
      const task = await readTask(tx, id, this.clock.now());
      if (!task) throw notFound('Follow-up task');
      return { status: 201, body: task };
    });
  }

  /** Staff lists, scoped: followup -> their doctors' patients; doctor -> their patients; admin -> all. */
  async list(ctx: RequestCtx, q: FollowUpListQueryDto): Promise<FollowUpTask[]> {
    const { user } = ctx;
    if (q.patientId) await this.scope.assertAccess(user, q.patientId);
    return listTasks(this.pool, this.clock.now(), {
      scopeDoctors: this.access.doctorScope(user),
      owner: q.owner,
      userId: user.userId,
      status: q.status,
      overdue: q.overdue,
      patientId: q.patientId,
    });
  }

  /** GET /me/follow-ups: the patient's own tasks without staff notes. */
  async listOwn(ctx: RequestCtx): Promise<PatientFollowUp[]> {
    const { user } = ctx;
    if (!user.patientId) throw notFound('Patient');
    const tasks = await listTasksOfPatient(this.pool, user.patientId, this.clock.now());
    return tasks.map((t) => ({
      id: t.id,
      kind: t.kind,
      summary: KIND_SUMMARY[t.kind] ?? 'The care team will follow up with you.',
      status: t.status,
      dueAt: t.dueAt,
      disposition: t.disposition,
      returnAppointmentId: t.returnAppointmentId,
      createdAt: t.createdAt,
      resolvedAt: t.resolvedAt,
    }));
  }

  async get(ctx: RequestCtx, id: string): Promise<FollowUpTask> {
    const task = await readTask(this.pool, id, this.clock.now());
    if (!task) throw notFound('Follow-up task');
    await this.scope.assertAccess(ctx.user, task.patientId);
    return task;
  }

  /** open -> acknowledged; the caller takes ownership of an unowned task. */
  async acknowledge(
    ctx: RequestCtx,
    id: string,
    body: AcknowledgeTaskRequestDto,
    key: string | undefined,
  ): Promise<IdempotentResult<FollowUpTask>> {
    const { user } = ctx;
    await this.get(ctx, id);
    return runCommand(this.pool, ctx, 'follow_up.acknowledge', key, { id, body }, async (tx) => {
      const now = this.clock.now();
      const task = await lockTask(tx, id, now);
      assertVersion(body.expectedVersion, task.version, 'The task');
      assertTransition('followUpTask', task.status, 'acknowledged');
      if (task.ownerId && task.ownerId !== user.userId && user.role !== 'admin') {
        throw forbidden('This task is owned by another staff member');
      }
      const ownerId = task.ownerId ?? user.userId;
      await tx.query(
        `UPDATE follow_up_tasks
            SET status = 'acknowledged', owner_id = $2, acknowledged_at = $3, version = version + 1, updated_at = $3
          WHERE id = $1`,
        [id, ownerId, now],
      );
      await writeAudit(tx, {
        actorId: user.userId,
        actorRole: user.role,
        operation: 'follow_up.acknowledge',
        entityType: 'follow_up_task',
        entityId: id,
        previous: { status: task.status, ownerId: task.ownerId },
        next: { status: 'acknowledged', ownerId },
        correlationId: ctx.correlationId,
      });
      await writeOutbox(tx, {
        eventType: 'FollowUpAcknowledged',
        entityType: 'follow_up_task',
        entityId: id,
        entityVersion: task.version + 1,
        patientId: task.patientId,
        payload: { ownerId },
      });
      return { status: 200, body: await this.reread(tx, id) };
    });
  }

  /** open | acknowledged -> resolved with a documented disposition. return_booked needs a linked return appointment. */
  async resolve(
    ctx: RequestCtx,
    id: string,
    body: ResolveTaskRequest,
    key: string | undefined,
  ): Promise<IdempotentResult<FollowUpTask>> {
    const { user } = ctx;
    await this.get(ctx, id);
    if (body.disposition !== 'return_booked' && body.returnAppointmentId) {
      throw validationFailed('returnAppointmentId is only valid with disposition return_booked');
    }
    if (body.disposition === 'return_booked' && !body.returnAppointmentId) {
      throw validationFailed('returnAppointmentId is required when disposition is return_booked');
    }
    return runCommand(this.pool, ctx, 'follow_up.resolve', key, { id, body }, async (tx) => {
      const now = this.clock.now();
      const task = await lockTask(tx, id, now);
      assertVersion(body.expectedVersion, task.version, 'The task');
      assertTransition('followUpTask', task.status, 'resolved');
      let returnAppointmentId = task.returnAppointmentId;
      if (body.disposition === 'return_booked') {
        const appt = await tx.query<{ status: string; follow_up_task_id: string | null }>(
          `SELECT status, follow_up_task_id FROM appointments WHERE id = $1`,
          [body.returnAppointmentId],
        );
        const a = appt.rows[0];
        if (!a || a.follow_up_task_id !== id) {
          throw validationFailed('returnAppointmentId is not an appointment booked from this task');
        }
        if (!['booked', 'checked_in', 'completed'].includes(a.status)) {
          throw conflict('CONFLICT', 'The return appointment is no longer active; book another before resolving', {
            appointmentStatus: a.status,
          });
        }
        returnAppointmentId = body.returnAppointmentId as string;
      }
      await tx.query(
        `UPDATE follow_up_tasks
            SET status = 'resolved', disposition = $2, outcome_note = $3, resolved_at = $4, resolved_by = $5,
                owner_id = COALESCE(owner_id, $5), return_appointment_id = $6, version = version + 1, updated_at = $4
          WHERE id = $1`,
        [id, body.disposition, body.outcomeNote.trim(), now, user.userId, returnAppointmentId],
      );
      await writeAudit(tx, {
        actorId: user.userId,
        actorRole: user.role,
        operation: 'follow_up.resolve',
        entityType: 'follow_up_task',
        entityId: id,
        previous: { status: task.status },
        next: { status: 'resolved', disposition: body.disposition, returnAppointmentId },
        reason: body.outcomeNote.trim(),
        correlationId: ctx.correlationId,
      });
      await writeOutbox(tx, {
        eventType: 'FollowUpResolved',
        entityType: 'follow_up_task',
        entityId: id,
        entityVersion: task.version + 1,
        patientId: task.patientId,
        payload: { disposition: body.disposition },
      });
      return { status: 200, body: await this.reread(tx, id) };
    });
  }

  /** open | acknowledged -> cancelled with a documented reason (kept in outcomeNote and the audit row). */
  async cancel(
    ctx: RequestCtx,
    id: string,
    body: CancelTaskRequestDto,
    key: string | undefined,
  ): Promise<IdempotentResult<FollowUpTask>> {
    const { user } = ctx;
    await this.get(ctx, id);
    return runCommand(this.pool, ctx, 'follow_up.cancel', key, { id, body }, async (tx) => {
      const now = this.clock.now();
      const task = await lockTask(tx, id, now);
      assertVersion(body.expectedVersion, task.version, 'The task');
      assertTransition('followUpTask', task.status, 'cancelled');
      await tx.query(
        `UPDATE follow_up_tasks
            SET status = 'cancelled', outcome_note = $2, version = version + 1, updated_at = $3
          WHERE id = $1`,
        [id, body.reason.trim(), now],
      );
      await writeAudit(tx, {
        actorId: user.userId,
        actorRole: user.role,
        operation: 'follow_up.cancel',
        entityType: 'follow_up_task',
        entityId: id,
        previous: { status: task.status },
        next: { status: 'cancelled' },
        reason: body.reason.trim(),
        correlationId: ctx.correlationId,
      });
      await writeOutbox(tx, {
        eventType: 'FollowUpResolved',
        entityType: 'follow_up_task',
        entityId: id,
        entityVersion: task.version + 1,
        patientId: task.patientId,
        payload: { cancelled: true },
      });
      return { status: 200, body: await this.reread(tx, id) };
    });
  }

  private async reread(tx: Tx, id: string): Promise<FollowUpTask> {
    const task = await readTask(tx, id, this.clock.now());
    if (!task) throw notFound('Follow-up task');
    return task;
  }

  /** The owner must be an active follow-up user assigned to one of the doctors, or one of those doctors. */
  private async assertValidOwner(ownerId: string, doctors: string[]): Promise<void> {
    const res = await this.pool.query<{ role: string; doctor_id: string | null; assigned: boolean }>(
      `SELECT u.role, u.doctor_id,
              EXISTS (SELECT 1 FROM staff_assignments sa WHERE sa.user_id = u.id AND sa.doctor_id = ANY($2::uuid[])) AS assigned
         FROM users u WHERE u.id = $1 AND u.active`,
      [ownerId, doctors],
    );
    const o = res.rows[0];
    const ok =
      o !== undefined &&
      ((o.role === 'followup' && o.assigned) || (o.role === 'doctor' && o.doctor_id !== null && doctors.includes(o.doctor_id)));
    if (!ok) throw validationFailed('The owner must be a follow-up user assigned to this patient’s doctor, or the doctor');
  }
}
