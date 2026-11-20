import type { Session } from '@hqms/contracts';

/** Slot start times: starts_at, then every slot_minutes while the whole slot fits before ends_at. */
export function slotTimes(session: Pick<Session, 'startsAt' | 'endsAt' | 'slotMinutes'>): string[] {
  const start = new Date(session.startsAt).getTime();
  const end = new Date(session.endsAt).getTime();
  const step = session.slotMinutes * 60_000;
  const out: string[] = [];
  for (let t = start; t + step <= end; t += step) out.push(new Date(t).toISOString());
  return out;
}

/**
 * D-035: a slot is worth assigning only if the patient still has `minArrivalWindowMin` minutes to arrive before
 * the slot's late-grace window closes (`slot + lateGraceMin >= now + minArrivalWindowMin`). One definition for
 * booking, reschedule, return booking, bulk move, alternatives and the slots read.
 */
export function isSlotAssignable(
  slotAt: string | Date,
  now: Date,
  lateGraceMin: number,
  minArrivalWindowMin: number,
): boolean {
  return new Date(slotAt).getTime() + lateGraceMin * 60_000 >= now.getTime() + minArrivalWindowMin * 60_000;
}
