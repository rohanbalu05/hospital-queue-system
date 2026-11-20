import type { Session } from '@hqms/contracts';

/**
 * The session the doctor console opens on when the link names none. In order:
 * 1. the session whose time window covers now, whatever its status (an unavailable current session beats an earlier closed one);
 * 2. the first open or paused session;
 * 3. the next upcoming session;
 * 4. the latest session of the day.
 */
export function pickDefaultSession(sessions: Session[], now: number): Session | null {
  if (sessions.length === 0) return null;
  const byStart = [...sessions].sort((a, b) => a.startsAt.localeCompare(b.startsAt));
  const t = (iso: string) => new Date(iso).getTime();
  const covering = byStart.filter((s) => t(s.startsAt) <= now && now < t(s.endsAt));
  return (
    covering.find((s) => s.status === 'open' || s.status === 'paused') ??
    covering[0] ??
    byStart.find((s) => s.status === 'open' || s.status === 'paused') ??
    byStart.find((s) => t(s.startsAt) > now) ??
    byStart[byStart.length - 1] ??
    null
  );
}
