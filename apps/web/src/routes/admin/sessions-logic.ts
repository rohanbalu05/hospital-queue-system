import { SessionOverlap, sessionLabelFor, type LocalDate, type Session } from '@hqms/contracts';
import { plainErrorMessage } from '@/components/queue/states';
import { ApiRequestError } from '@/lib/api';
import { addDays, formatLocalDate } from '@/lib/dates';
import { formatIST } from '@/lib/format';

/** A hospital-local date and clock time ("2026-11-20", "09:00") as an instant. India has no daylight saving. */
export function istInstant(date: LocalDate, hhmm: string): string {
  return `${date}T${hhmm}:00+05:30`;
}

/** The chosen date, then the next `extraDays` days. */
export function repeatDates(date: LocalDate, extraDays: number): LocalDate[] {
  return Array.from({ length: extraDays + 1 }, (_, i) => addDays(date, i));
}

const WINDOW_ENDED = (s: Pick<Session, 'endsAt'>, now: number) => new Date(s.endsAt).getTime() <= now;

/** The status column: availability words, never the raw session status. */
export function sessionStatusWords(s: Session, now: number): string {
  const a = s.availability;
  if (a) {
    switch (a.state) {
      case 'not_started':
        return 'Not started';
      case 'available':
        return 'Available';
      case 'away':
        if (a.overdue) return 'Away, back time has passed';
        return a.expectedBackAt ? `Away until ${formatIST(a.expectedBackAt)}` : 'Away';
      case 'unavailable':
        return 'Unavailable';
      case 'ended':
        return 'Ended';
    }
  }
  if (s.status === 'closed') return 'Ended';
  if (s.status === 'unavailable') return 'Unavailable';
  if (WINDOW_ENDED(s, now)) return 'Ended';
  if (s.status === 'paused') return 'Away';
  return s.status === 'open' ? 'Available' : 'Not started';
}

export interface SessionActions {
  open: boolean;
  close: boolean;
  reopen: boolean;
}

/** Which of Open, Close and Reopen make sense for a session right now. Edit capacity is always offered. */
export function sessionActions(s: Session, now: number): SessionActions {
  const ended = WINDOW_ENDED(s, now);
  return {
    open: s.status === 'scheduled' && !ended,
    close: s.status === 'open' || s.status === 'paused' || s.status === 'unavailable',
    reopen: s.status === 'unavailable' && !ended,
  };
}

const LABEL_WORD = { morning: 'Morning', afternoon: 'Afternoon', evening: 'Evening', night: 'Night' } as const;
export const labelWordFor = (startsAt: string | Date) => LABEL_WORD[sessionLabelFor(startsAt)];

/** The 409 SESSION_OVERLAP details, when an error carries them. */
export function overlapOf(err: unknown): SessionOverlap | null {
  if (!(err instanceof ApiRequestError) || err.status !== 409) return null;
  const parsed = SessionOverlap.safeParse(err.details);
  return parsed.success ? parsed.data : null;
}

/** "Dr. X already has a session from 9:00 am to 1:00 pm on Fri, 20 Nov. Choose times that do not overlap it." */
export function overlapWords(o: Pick<SessionOverlap, 'startsAt' | 'endsAt'>, doctorName: string): string {
  const day = formatIST(o.startsAt, 'weekday-date');
  return `${doctorName} already has a session from ${formatIST(o.startsAt)} to ${formatIST(o.endsAt)} on ${day}. Choose times that do not overlap it.`;
}

/** The tail of one per-day result line when a day was skipped: "overlaps Morning 9:00 am to 1:00 pm" or "not created. <why>". */
export function createFailureWords(err: unknown): string {
  const overlap = overlapOf(err);
  if (overlap) return `overlaps ${labelWordFor(overlap.startsAt)} ${formatIST(overlap.startsAt)} to ${formatIST(overlap.endsAt)}`;
  const why = err instanceof ApiRequestError ? plainErrorMessage(err) : null;
  return `not created. ${why ?? 'Something went wrong.'}`;
}

/** "Fri, 20 Nov" */
export const dayWords = (date: LocalDate) => formatLocalDate(date);
