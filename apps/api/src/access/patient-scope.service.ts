import { Inject, Injectable } from '@nestjs/common';
import type { Pool, Queryable } from '@hqms/db';
import { notFound } from '../common/errors.js';
import type { AuthUser } from '../common/request-context.js';
import { DB_POOL } from '../common/tokens.js';
import { AccessPolicy } from './access-policy.service.js';

/**
 * Patient-level scope for the follow-up, document and assistant modules (FR-01, NFR-06).
 *
 *  - patient: only their own record; everything else answers 404 (existence is not disclosed).
 *  - admin: every patient.
 *  - doctor / reception / followup: a patient is in scope when linked by an appointment or a visit to a doctor
 *    in the caller's scope (own doctor, or the assigned doctors). Out of scope answers 404, like a patient would
 *    get, so a staff member cannot probe for the existence of a patient they are not caring for.
 */
@Injectable()
export class PatientScope {
  constructor(
    @Inject(DB_POOL) private readonly pool: Pool,
    @Inject(AccessPolicy) private readonly access: AccessPolicy,
  ) {}

  /** Doctors (ids) this patient is linked to by an appointment or a visit. */
  async linkedDoctorIds(patientId: string, db: Queryable = this.pool): Promise<string[]> {
    const res = await db.query<{ doctor_id: string }>(
      `SELECT doctor_id FROM appointments WHERE patient_id = $1
       UNION SELECT doctor_id FROM visits WHERE patient_id = $1`,
      [patientId],
    );
    return res.rows.map((r) => r.doctor_id);
  }

  /** The linked doctors that are also in the caller's scope (all linked doctors for an admin). */
  async scopedDoctorIds(user: AuthUser, patientId: string, db: Queryable = this.pool): Promise<string[]> {
    const linked = await this.linkedDoctorIds(patientId, db);
    const scope = this.access.doctorScope(user);
    return scope === null ? linked : linked.filter((d) => scope.includes(d));
  }

  async canAccess(user: AuthUser, patientId: string, db: Queryable = this.pool): Promise<boolean> {
    if (user.role === 'patient') return user.patientId === patientId;
    if (user.role === 'admin') return true;
    return (await this.scopedDoctorIds(user, patientId, db)).length > 0;
  }

  /** 404 unless the caller may see this patient's data. */
  async assertAccess(user: AuthUser, patientId: string, db: Queryable = this.pool): Promise<void> {
    if (!(await this.canAccess(user, patientId, db))) throw notFound('Patient');
  }
}
