import type { SessionAvailability } from '@hqms/contracts';
import { ApiRequestError } from '@/lib/api';
import { formatIST } from '@/lib/format';
import { istInstant } from '@/live/date';

/** Why a doctor steps away. "Other" asks for free text. */
export const AWAY_REASONS = ['Ward round / emergency', 'Break', 'Meeting', 'Other'] as const;
export type AwayReason = (typeof AWAY_REASONS)[number];

/** Expected-return presets in minutes, as the Step away dialog offers them (StepAwayRequest, D-032). */
export const RETURN_PRESETS = [10, 15, 30, 60] as const;

export const MIN_REASON_LENGTH = 3;

/** "10:45 am" for an instant, Bengaluru time. */
export const clock = (iso: string | Date | null | undefined): string => formatIST(iso, 'time');

/** "Back about 10:45 am", shown live in the dialog as the doctor picks a return time. */
export function backAboutText(until: Date | string | null): string {
  return until === null ? 'No return time set' : `Back about ${clock(until)}`;
}

/** The instant N minutes after `now`, with seconds dropped so "Back about 10:45 am" and the sent value agree. */
export function returnAfter(now: Date, minutes: number): Date {
  const d = new Date(now.getTime() + minutes * 60_000);
  d.setSeconds(0, 0);
  return d;
}

/** A custom "HH:MM" return time on the session's IST date. Null when the text is not a time. */
export function returnAtTime(sessionDate: string, hhmm: string): Date | null {
  const iso = istInstant(sessionDate, hhmm);
  return iso === null ? null : new Date(iso);
}

export type ReturnProblem = 'not_future' | 'after_end';

/** Same two refusals the server makes (400), caught early so the doctor can fix the time before sending. */
export function returnProblem(until: Date, now: Date, sessionEndsAt: string): ReturnProblem | null {
  if (until.getTime() <= now.getTime()) return 'not_future';
  if (until.getTime() > new Date(sessionEndsAt).getTime()) return 'after_end';
  return null;
}

/** The reason text sent to the server: a choice, or the typed text for "Other". */
export function reasonText(choice: AwayReason, other: string): string {
  return choice === 'Other' ? other.trim() : choice;
}

/** Valid when a choice other than Other is picked, or the typed text is long enough. */
export function reasonProblem(choice: AwayReason, other: string): string | null {
  if (choice !== 'Other') return null;
  return other.trim().length >= MIN_REASON_LENGTH ? null : 'Write the reason, at least 3 characters.';
}

/** First part of "Dr. Meenakshi Rao, General Medicine" or "Dr. Hegde \u00b7 General Medicine": the display names doctors, never patients. */
export function doctorNameOnly(label: string): string {
  return label.split(/[,\u00b7]/)[0]?.trim() || label;
}

/**
 * Overdue as the server said it, or because the expected return has passed since the snapshot was taken.
 * A screen left open past the expected time turns "expected back about 10:45 am" into "longer than expected" by itself.
 */
export function isOverdue(av: SessionAvailability, now: number): boolean {
  if (av.state !== 'away') return false;
  return av.overdue || (av.expectedBackAt !== null && new Date(av.expectedBackAt).getTime() <= now);
}

export interface AvailabilityWords {
  /** Short headline: who is away or unavailable. */
  headline: string;
  /** "since 10:30 am" */
  since: string | null;
  /** "expected back about 10:45 am", "longer than expected" or "no return time set". */
  expected: string | null;
}

/**
 * Staff words for an away or unavailable doctor. `who` is "You" on the doctor's own screen, otherwise the doctor's name.
 * Always words, never colour alone.
 */
export function availabilityWords(av: SessionAvailability, who: string, now: number = Date.now()): AvailabilityWords {
  const self = who === 'You';
  const since = av.since ? `since ${clock(av.since)}` : null;
  if (av.state === 'unavailable') {
    return {
      headline: self ? 'You are unavailable for the rest of this session' : `${who} is unavailable for the rest of this session`,
      since,
      expected: null,
    };
  }
  const headline = self ? 'You are away' : `${who} is away`;
  if (isOverdue(av, now)) return { headline, since, expected: 'longer than expected' };
  if (av.expectedBackAt) return { headline, since, expected: `expected back about ${clock(av.expectedBackAt)}` };
  return { headline, since, expected: 'no return time set' };
}

/** One line: "You are away · since 10:30 am · expected back about 10:45 am". */
export function availabilityLine(av: SessionAvailability, who: string, now: number = Date.now()): string {
  const w = availabilityWords(av, who, now);
  return [w.headline, w.since, w.expected].filter(Boolean).join(' · ');
}

/** The sentence on the waiting-room display, from the doctor's name and the availability the display snapshot carries. */
export function displayBannerText(av: SessionAvailability, doctor: string, now: number = Date.now()): string | null {
  if (av.state === 'unavailable') return `${doctor} is not available for the rest of this session. Please see reception.`;
  if (av.state !== 'away') return null;
  if (isOverdue(av, now)) return `${doctor} is away and will be back shortly`;
  if (av.expectedBackAt) return `${doctor} is temporarily away, expected back about ${clock(av.expectedBackAt)}`;
  return `${doctor} is temporarily away`;
}

/** Plain words for the errors Step away, I'm back and Unavailable can return. */
export function availabilityError(err: unknown, action: 'step-away' | 'back' | 'unavailable', who: 'doctor' | 'reception' = 'doctor'): string {
  if (!(err instanceof ApiRequestError)) return 'Something went wrong. Nothing was changed. Try again.';
  if (err.code === 'DOCTOR_OCCUPIED') {
    return who === 'doctor'
      ? 'A patient has been called and has not started yet. Start that visit or skip the patient first, then step away.'
      : 'A patient has been called and has not started yet. The doctor needs to start the visit or skip the patient before stepping away.';
  }
  if (err.code === 'NETWORK') return 'Cannot reach the server. Nothing was changed. Check the connection and try again.';
  if (err.code === 'FORBIDDEN') return 'You do not have permission to do this for this session.';
  if (err.code === 'CONFLICT' || err.code === 'INVALID_TRANSITION') {
    return 'The session changed while you were acting. The screen now shows the latest state. Check it and try again.';
  }
  if (action === 'step-away' && err.status === 400) {
    return 'That return time is not allowed. It must be later than now and before the session ends. Choose another time, or mark the doctor unavailable for the rest of the session.';
  }
  return err.message;
}
