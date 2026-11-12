import { firstRow, maybeOne, type Queryable, type QueryResultRow } from '../pool.js';
import type { Tx } from '../tx.js';

/** EWMA state per doctor (DECISIONS D-009). The estimator maths lives in @hqms/domain. */
export interface ServiceEstimate {
  doctorId: string;
  meanMinutes: number;
  samples: number;
  updatedAt: string;
}

const mapEstimate = (r: QueryResultRow): ServiceEstimate => ({
  doctorId: r.doctor_id,
  meanMinutes: r.mean_minutes,
  samples: r.samples,
  updatedAt: r.updated_at,
});

/** null when no consultation has completed yet: use the policy's initial estimate. */
export async function getServiceEstimate(db: Queryable, doctorId: string): Promise<ServiceEstimate | null> {
  const r = await maybeOne(
    db,
    `SELECT doctor_id, mean_minutes, samples, updated_at FROM service_estimates WHERE doctor_id = $1`,
    [doctorId],
  );
  return r ? mapEstimate(r) : null;
}

export async function upsertServiceEstimate(
  tx: Tx,
  e: { doctorId: string; meanMinutes: number; samples: number },
): Promise<ServiceEstimate> {
  const res = await tx.query(
    `INSERT INTO service_estimates (doctor_id, mean_minutes, samples) VALUES ($1, $2, $3)
     ON CONFLICT (doctor_id) DO UPDATE SET mean_minutes = EXCLUDED.mean_minutes, samples = EXCLUDED.samples, updated_at = now()
     RETURNING doctor_id, mean_minutes, samples, updated_at`,
    [e.doctorId, e.meanMinutes, e.samples],
  );
  return mapEstimate(firstRow(res, 'service_estimate'));
}
