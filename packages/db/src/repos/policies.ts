import type { QueuePolicy } from '@hqms/contracts';
import { maybeOne, type Queryable, type QueryResultRow } from '../pool.js';

const COLS = `id, version, rotation, early_eligibility_min, late_grace_min, aging_trigger_min, called_timeout_sec,
              ewma_alpha, initial_estimate_min, default_booked_capacity, default_walkin_capacity, created_at`;

const mapPolicy = (r: QueryResultRow): QueuePolicy => ({
  id: r.id,
  version: r.version,
  rotation: r.rotation,
  earlyEligibilityMin: r.early_eligibility_min,
  lateGraceMin: r.late_grace_min,
  agingTriggerMin: r.aging_trigger_min,
  calledTimeoutSec: r.called_timeout_sec,
  ewmaAlpha: r.ewma_alpha,
  initialEstimateMin: r.initial_estimate_min,
  defaultBookedCapacity: r.default_booked_capacity,
  defaultWalkinCapacity: r.default_walkin_capacity,
  createdAt: r.created_at,
});

export async function getPolicyById(db: Queryable, id: string): Promise<QueuePolicy | null> {
  const r = await maybeOne(db, `SELECT ${COLS} FROM queue_policies WHERE id = $1`, [id]);
  return r ? mapPolicy(r) : null;
}

export async function getPolicyByVersion(db: Queryable, version: number): Promise<QueuePolicy | null> {
  const r = await maybeOne(db, `SELECT ${COLS} FROM queue_policies WHERE version = $1`, [version]);
  return r ? mapPolicy(r) : null;
}

/** Highest policy version (what new sessions are created with). */
export async function getLatestPolicy(db: Queryable): Promise<QueuePolicy | null> {
  const r = await maybeOne(db, `SELECT ${COLS} FROM queue_policies ORDER BY version DESC LIMIT 1`);
  return r ? mapPolicy(r) : null;
}
