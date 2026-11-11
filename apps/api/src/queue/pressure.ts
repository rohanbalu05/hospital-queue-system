import type { QueuePressure } from '@hqms/contracts';
import { MINUTE_MS, simulatePolicyOrder, type Candidate, type Policy } from '@hqms/domain';

export interface PressureInput {
  /** Waiting entries of the session. */
  entries: readonly Candidate[];
  rotationPointer: number;
  policy: Policy;
  /** When the doctor is next free (the same start the ETA projection uses), epoch ms. */
  startMs: number;
  /** Average consultation minutes (the estimator mean the ETA uses). */
  serviceMin: number;
  nowMs: number;
  sessionEndsAtMs: number;
  sessionStatus: 'scheduled' | 'open' | 'paused' | 'unavailable' | 'closed';
  capacity: { walkinCapacity: number; walkinUsed: number };
}

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

/**
 * Workload pressure of one session (report 6.6 "Demand exceeds capacity: expose workload pressure"; 6.4 records
 * priority starvation). Derived from the same simulated order as the ETA, so the pressure and the waiting-time
 * estimates always agree. Pure.
 *
 *  - overloaded: the last waiting patient is projected to finish after the session ends, or someone has
 *    waited past the aging trigger but clinical priority keeps taking the turns (aging is blocked);
 *  - high: anyone waiting past the aging trigger, or the walk-in places are full with people waiting;
 *  - normal: none of those.
 */
export function computePressure(i: PressureInput): QueuePressure {
  if (i.sessionStatus === 'closed' || i.entries.length === 0) return { level: 'normal', reasons: [] };
  const reasons: string[] = [];
  let overloaded = false;
  let high = false;

  // 1. Projected finish of the last waiting patient versus the session end.
  const steps = simulatePolicyOrder({ entries: i.entries, rotationPointer: i.rotationPointer }, i.policy, i.startMs, i.serviceMin);
  const last = steps[steps.length - 1];
  if (last) {
    const finishMs = last.startAtMs + i.serviceMin * MINUTE_MS;
    if (finishMs > i.sessionEndsAtMs) {
      const over = Math.ceil((finishMs - i.sessionEndsAtMs) / MINUTE_MS);
      reasons.push(`The last waiting patient is projected to finish about ${plural(over, 'minute', 'minutes')} after the session ends.`);
      overloaded = true;
    }
  }

  // 2. Waiting past the aging trigger (eligible wait, the same measure the selector uses).
  const triggerMs = i.policy.agingTriggerMin * MINUTE_MS;
  const waitMs = (e: Candidate): number => i.nowMs - new Date(e.eligibleAt).getTime();
  const aged = i.entries.filter((e) => waitMs(e) >= triggerMs);
  if (aged.length > 0) {
    const longest = Math.floor(Math.max(...aged.map(waitMs)) / MINUTE_MS);
    reasons.push(
      `${plural(aged.length, 'patient has', 'patients have')} waited longer than the ${i.policy.agingTriggerMin}-minute aging trigger (longest ${longest} minutes).`,
    );
    high = true;

    // 3. Aging blocked by clinical priority: an aged patient without a priority class while a priority candidate exists.
    const priorityWaiting = i.entries.some((e) => e.priorityClass !== null && waitMs(e) >= 0);
    const blocked = aged.filter((e) => e.priorityClass === null);
    if (priorityWaiting && blocked.length > 0) {
      reasons.push(
        `Clinical priority is being called first, so ${plural(blocked.length, 'patient who has', 'patients who have')} waited past the aging trigger cannot be called by aging yet.`,
      );
      overloaded = true;
    }
  }

  // 4. Walk-in places used up while people are still waiting.
  if (i.capacity.walkinUsed >= i.capacity.walkinCapacity) {
    reasons.push(
      `Walk-in places are full (${i.capacity.walkinUsed} of ${i.capacity.walkinCapacity}) and ${plural(i.entries.length, 'patient is', 'patients are')} still waiting.`,
    );
    high = true;
  }

  return { level: overloaded ? 'overloaded' : high ? 'high' : 'normal', reasons };
}
