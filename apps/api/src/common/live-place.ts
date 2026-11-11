import type { Queryable } from '@hqms/db';

/**
 * Does this patient already hold a place in the session? A place is a queue entry that is live (waiting,
 * called, in service) OR parked and re-enterable (skipped, absent) while its visit is still open: a parked
 * patient keeps the capacity place they consumed (D-023) and can come back with re-entry, so a second
 * admission would give them two places. Completed, cancelled and left entries do not count.
 *
 * `excludeEntryId` ignores one entry (the one being re-entered). Call under the doctor -> session locks.
 * The partial unique index visits_one_open_per_patient_session_uq (migration 0007) is the DB backstop.
 */
export async function hasLivePlace(
  db: Queryable,
  sessionId: string,
  patientId: string,
  excludeEntryId?: string,
): Promise<boolean> {
  const res = await db.query(
    `SELECT 1
       FROM queue_entries qe JOIN visits v ON v.id = qe.visit_id
      WHERE qe.session_id = $1 AND v.patient_id = $2
        AND ($3::uuid IS NULL OR qe.id <> $3::uuid)
        AND (qe.state IN ('waiting','called','in_service')
             OR (qe.state IN ('skipped','absent') AND v.status IN ('open','in_service')))
      LIMIT 1`,
    [sessionId, patientId, excludeEntryId ?? null],
  );
  return (res.rowCount ?? 0) > 0;
}
