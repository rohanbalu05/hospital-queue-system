import { Inject, Injectable } from '@nestjs/common';
import type {
  DisplaySnapshot,
  PatientQueueSnapshot,
  QueueDecision,
  StaffQueueSnapshot,
} from '@hqms/contracts';
import { getServiceEstimate, withTransaction, type Pool, type Queryable } from '@hqms/db';
import {
  initialEstimator,
  projectEta,
  projectOrder,
  type Estimator,
} from '@hqms/domain';
import { APP_CONFIG, CLOCK, DB_POOL } from '../common/tokens.js';
import type { AppConfig } from '../common/config.js';
import type { Clock } from '../common/clock.js';
import { notFound } from '../common/errors.js';
import { localDate } from '../common/http.js';
import type { RequestCtx } from '../common/request-context.js';
import { AccessPolicy } from '../access/access-policy.service.js';
import {
  readActiveForDoctor,
  readDecisions,
  readEntriesInStates,
  readLastDecision,
  readSessionState,
  readWaiting,
  toCandidate,
  toQueueEntry,
  type EntryRow,
  type SessionState,
} from './queue.repo.js';

/** Everything a snapshot is computed from, read inside one REPEATABLE READ transaction. */
interface QueueState {
  session: SessionState;
  waiting: EntryRow[];
  active: EntryRow | null;
  estimator: Estimator;
}

async function loadState(db: Queryable, sessionId: string): Promise<QueueState | null> {
  const session = await readSessionState(db, sessionId);
  if (!session) return null;
  // Sequential: one transaction is one connection, which runs one query at a time.
  const waiting = await readWaiting(db, sessionId);
  const active = await readActiveForDoctor(db, session.doctorId);
  const est = await getServiceEstimate(db, session.doctorId);
  return {
    session,
    waiting,
    active,
    estimator: est ? { meanMinutes: est.meanMinutes, samples: est.samples } : initialEstimator(session.policy),
  };
}

/**
 * Minutes until the doctor is free, mirroring the ETA model: the residual of an in-service
 * consultation (never negative), or the rest of the call timeout plus one consultation for a patient
 * who is called but has not started.
 */
function residualMinutes(state: QueueState, now: Date): number {
  const { active, estimator, session } = state;
  if (!active) return 0;
  const m = estimator.meanMinutes;
  if (active.state === 'in_service' && active.startedAt) {
    return Math.max(0, m - Math.max(0, now.getTime() - new Date(active.startedAt).getTime()) / 60_000);
  }
  if (active.calledAt) {
    const timeoutAt = new Date(active.calledAt).getTime() + session.policy.calledTimeoutSec * 1000;
    return Math.max(0, timeoutAt - now.getTime()) / 60_000 + m;
  }
  return m;
}

/** Waiting ids in projected policy order, starting when the doctor is next free (and any known pause is over). */
function projectedOrder(state: QueueState, now: Date): string[] {
  if (state.waiting.length === 0) return [];
  let startMs = now.getTime() + residualMinutes(state, now) * 60_000;
  if (state.session.status === 'paused' && state.session.pauseUntil) {
    startMs = Math.max(startMs, new Date(state.session.pauseUntil).getTime());
  }
  return projectOrder(
    { entries: state.waiting.map(toCandidate), rotationPointer: state.session.rotationPointer },
    state.session.policy,
    startMs,
    state.estimator.meanMinutes,
  );
}

/** "Dr. Suresh Hegde" -> "Dr. Hegde". */
export function doctorLabel(fullName: string, department: string): string {
  const parts = fullName.replace(/^dr\.?\s+/i, '').trim().split(/\s+/);
  return `Dr. ${parts[parts.length - 1] ?? fullName} · ${department}`;
}

@Injectable()
export class SnapshotService {
  constructor(
    @Inject(DB_POOL) private readonly pool: Pool,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(AccessPolicy) private readonly access: AccessPolicy,
  ) {}

  /** Run reads against one consistent snapshot so `queueVersion` always matches the rows returned. */
  private readConsistent<T>(fn: (db: Queryable) => Promise<T>): Promise<T> {
    return withTransaction(this.pool, (tx) => fn(tx), { isolation: 'repeatable read' });
  }

  /** GET /sessions/{id}/queue: staff in scope get the full view, a patient with an entry only their own. */
  async forSession(ctx: RequestCtx, sessionId: string): Promise<StaffQueueSnapshot | PatientQueueSnapshot> {
    const { user } = ctx;
    return this.readConsistent(async (db) => {
      const now = this.clock.now();
      const state = await loadState(db, sessionId);
      if (!state) throw notFound('Session');
      const order = projectedOrder(state, now);
      const positionOf = new Map(order.map((id, i) => [id, i + 1]));

      if (user.role === 'patient') {
        if (!user.patientId) throw notFound('Queue');
        const mine = await db.query(
          `SELECT qe.id, qe.token, qe.queue_group, qe.state
             FROM queue_entries qe JOIN visits v ON v.id = qe.visit_id
            WHERE qe.session_id = $1 AND v.patient_id = $2
            ORDER BY (qe.state IN ('waiting','called','in_service')) DESC, qe.seq DESC LIMIT 1`,
          [sessionId, user.patientId],
        );
        const row = mine.rows[0];
        if (!row) throw notFound('Queue'); // no entry in this session: nothing to disclose
        const eta = projectEta({
          targetEntryId: row.id,
          entries: state.waiting.map(toCandidate),
          rotationPointer: state.session.rotationPointer,
          active: state.active
            ? {
                startedAt: state.active.startedAt === null ? null : new Date(state.active.startedAt),
                calledAt: state.active.calledAt === null ? null : new Date(state.active.calledAt),
              }
            : null,
          session: {
            status: state.session.status,
            pauseUntil: state.session.pauseUntil === null ? null : new Date(state.session.pauseUntil),
          },
          estimator: state.estimator,
          policy: state.session.policy,
          now,
        });
        const calling = state.active && state.active.state === 'called' && state.active.sessionId === sessionId;
        return {
          view: 'patient',
          sessionId,
          status: state.session.status,
          queueVersion: state.session.queueVersion,
          capturedAt: now.toISOString(),
          myEntry: {
            queueEntryId: row.id,
            token: row.token,
            group: row.queue_group,
            state: row.state,
            position: positionOf.get(row.id) ?? null,
            eta,
          },
          nowCalling: calling && state.active ? state.active.token : null,
        } satisfies PatientQueueSnapshot;
      }

      this.access.assertDoctorScope(user, state.session.doctorId);
      const skipped = await readEntriesInStates(db, sessionId, ['skipped', 'absent']);
      const completed = await db.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM queue_entries WHERE session_id = $1 AND state = 'completed'`,
        [sessionId],
      );
      const lastDecision = await readLastDecision(db, sessionId);
      const byId = new Map(state.waiting.map((e) => [e.id, e]));
      const waiting = order.flatMap((id) => {
        const e = byId.get(id);
        return e ? [toQueueEntry(e, { now, projectedPosition: positionOf.get(id) ?? null })] : [];
      });
      return {
        view: 'staff',
        sessionId,
        doctorId: state.session.doctorId,
        status: state.session.status,
        pauseUntil: state.session.pauseUntil,
        policyVersion: state.session.policy.version,
        rotationPointer: state.session.rotationPointer,
        rotation: [...state.session.policy.rotation],
        queueVersion: state.session.queueVersion,
        capturedAt: now.toISOString(),
        active: state.active ? toQueueEntry(state.active, { now }) : null,
        waiting,
        skipped: skipped.map((e) => toQueueEntry(e, { now })),
        completedCount: completed.rows[0]?.n ?? 0,
        lastDecision,
        capacity: state.session.capacity,
      } satisfies StaffQueueSnapshot;
    });
  }

  /** GET /display/sessions: today's open or paused sessions, tokens only. No names, no patient ids, nothing clinical. */
  async display(date?: string): Promise<DisplaySnapshot> {
    return this.readConsistent(async (db) => {
      const now = this.clock.now();
      const day = date ?? localDate(now, this.config.hospitalTz);
      const ids = await db.query<{ id: string }>(
        `SELECT s.id FROM sessions s JOIN doctors d ON d.id = s.doctor_id
          WHERE s.session_date = $1 AND s.status IN ('open','paused')
          ORDER BY s.starts_at, d.full_name`,
        [day],
      );
      const columns: DisplaySnapshot['columns'] = [];
      for (const { id } of ids.rows) {
        const state = await loadState(db, id);
        if (!state) continue;
        const order = projectedOrder(state, now);
        const byId = new Map(state.waiting.map((e) => [e.id, e]));
        const calling = state.active && state.active.state === 'called' && state.active.sessionId === id;
        columns.push({
          sessionId: id,
          doctorLabel: doctorLabel(state.session.doctorName, state.session.department),
          room: state.session.room,
          status: state.session.status,
          nowCalling: calling && state.active ? state.active.token : null,
          next: order.slice(0, 3).flatMap((e) => {
            const row = byId.get(e);
            return row ? [row.token] : [];
          }),
          queueVersion: state.session.queueVersion,
        });
      }
      return { view: 'display', capturedAt: now.toISOString(), columns };
    });
  }

  /** GET /sessions/{id}/decisions (staff in scope): the explainable decision log, newest first. */
  async decisions(ctx: RequestCtx, sessionId: string, limit: number): Promise<QueueDecision[]> {
    const session = await readSessionState(this.pool, sessionId);
    if (!session) throw notFound('Session');
    this.access.assertDoctorScope(ctx.user, session.doctorId);
    return readDecisions(this.pool, sessionId, limit);
  }
}
