import { Inject, Injectable } from '@nestjs/common';
import type { Pool, Queryable } from '@hqms/db';
import type { Clock } from '../common/clock.js';
import { notFound } from '../common/errors.js';
import type { AuthUser } from '../common/request-context.js';
import { CLOCK, DB_POOL } from '../common/tokens.js';
import { AccessPolicy } from './access-policy.service.js';

/** A link between a patient and a doctor only counts for this long after the appointment or visit. */
export const LINK_WINDOW_DAYS = 180;

/**
 * SQL predicate "patient `p` is linked to one of the doctors in array `d` as of `n`" (bind the three expressions).
 * A link is an appointment that is booked, checked in or completed (a cancelled, missed or rescheduled one grants
 * nothing) scheduled within the window, or a visit within the window.
 */
export function linkedToDoctorsSql(p: string, d: string, n: string): string {
  return `(EXISTS (SELECT 1 FROM appointments a
                    WHERE a.patient_id = ${p} AND a.doctor_id = ANY(${d}::uuid[])
                      AND a.status IN ('booked','checked_in','completed')
                      AND a.scheduled_at > ${n}::timestamptz - interval '${LINK_WINDOW_DAYS} days')
        OR EXISTS (SELECT 1 FROM visits v
                    WHERE v.patient_id = ${p} AND v.doctor_id = ANY(${d}::uuid[])
                      AND v.checked_in_at > ${n}::timestamptz - interval '${LINK_WINDOW_DAYS} days'))`;
}

/**
 * Patient-level scope for the follow-up, document and assistant modules (FR-01, NFR-06).
 *
 *  - patient: only their own record; everything else answers 404 (existence is not disclosed).
 *  - admin: every patient.
 *  - doctor / reception / followup: a patient is in scope when linked to a doctor in the caller's scope by a
 *    current appointment (booked / checked in / completed) or a visit, within the last 180 days. A doctor or
 *    follow-up user also sees a patient while an open follow-up task of that patient is OWNED by them (an
 *    escalation for a patient with no doctor link must still reach its owner). Out of scope answers 404, like
 *    a patient would get, so a staff member cannot probe for the existence of a patient they are not caring for.
 */
@Injectable()
export class PatientScope {
  constructor(
    @Inject(DB_POOL) private readonly pool: Pool,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(AccessPolicy) private readonly access: AccessPolicy,
  ) {}

  /** Doctors (ids) this patient is currently linked to by an appointment or a visit. */
  async linkedDoctorIds(patientId: string, db: Queryable = this.pool): Promise<string[]> {
    const res = await db.query<{ doctor_id: string }>(
      `SELECT doctor_id FROM appointments
        WHERE patient_id = $1 AND status IN ('booked','checked_in','completed')
          AND scheduled_at > $2::timestamptz - interval '${LINK_WINDOW_DAYS} days'
       UNION
       SELECT doctor_id FROM visits WHERE patient_id = $1 AND checked_in_at > $2::timestamptz - interval '${LINK_WINDOW_DAYS} days'`,
      [patientId, this.clock.now()],
    );
    return res.rows.map((r) => r.doctor_id);
  }

  /** The linked doctors that are also in the caller's scope (all linked doctors for an admin). */
  async scopedDoctorIds(user: AuthUser, patientId: string, db: Queryable = this.pool): Promise<string[]> {
    const linked = await this.linkedDoctorIds(patientId, db);
    const scope = this.access.doctorScope(user);
    return scope === null ? linked : linked.filter((d) => scope.includes(d));
  }

  /** An open or acknowledged follow-up task of this patient that the staff user owns. */
  private async ownsOpenTask(user: AuthUser, patientId: string, db: Queryable): Promise<boolean> {
    if (user.role !== 'doctor' && user.role !== 'followup') return false;
    const res = await db.query(
      `SELECT 1 FROM follow_up_tasks WHERE patient_id = $1 AND owner_id = $2 AND status IN ('open','acknowledged') LIMIT 1`,
      [patientId, user.userId],
    );
    return (res.rowCount ?? 0) > 0;
  }

  async canAccess(user: AuthUser, patientId: string, db: Queryable = this.pool): Promise<boolean> {
    if (user.role === 'patient') return user.patientId === patientId;
    if (user.role === 'admin') return true;
    if ((await this.scopedDoctorIds(user, patientId, db)).length > 0) return true;
    return this.ownsOpenTask(user, patientId, db);
  }

  /** 404 unless the caller may see this patient's data. */
  async assertAccess(user: AuthUser, patientId: string, db: Queryable = this.pool): Promise<void> {
    if (!(await this.canAccess(user, patientId, db))) throw notFound('Patient');
  }
}
