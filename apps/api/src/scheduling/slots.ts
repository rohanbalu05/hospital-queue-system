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
