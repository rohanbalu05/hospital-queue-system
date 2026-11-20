import { z } from 'zod';
import { Instant } from './common.js';

// ---------------------------------------------------------------------------
// Doctor availability lifecycle (B1, D-032)
// ---------------------------------------------------------------------------

/**
 * What patients, reception and the display are told about the doctor of one session. Derived from the
 * session status, never stored separately (D-032):
 *   scheduled             -> not_started
 *   open                  -> available
 *   paused                -> away          ("Step away"; "I'm back" returns to available)
 *   unavailable           -> unavailable   (for the rest of the session; one-way, confirmed)
 *   closed / ended window -> ended
 */
export const AvailabilityState = z.enum(['not_started', 'available', 'away', 'unavailable', 'ended']);
export type AvailabilityState = z.infer<typeof AvailabilityState>;

export const SessionAvailability = z.object({
  state: AvailabilityState,
  /** When the current away/unavailable state began (sessions.paused_at). Null otherwise. */
  since: Instant.nullable(),
  /** Away only: when the doctor expects to be back. Null when not given (ETA withheld, FR-10-a). */
  expectedBackAt: Instant.nullable(),
  /** Away and expectedBackAt has passed: "taking longer than expected". */
  overdue: z.boolean(),
  /** Free-text reason. STAFF reads only; always null on patient and display reads. */
  reason: z.string().nullable(),
});
export type SessionAvailability = z.infer<typeof SessionAvailability>;

/** Preset expected-return choices offered by the Step away dialog (minutes from now); "custom" takes a time. */
export const STEP_AWAY_PRESETS_MIN = [10, 15, 30, 60] as const;

/**
 * POST /sessions/{id}/pause  ("Step away"; doctor for own session, reception in scope, admin). Idempotency-Key.
 * Allowed from `open`, and from `paused` to update the expected return (re-notifies). Rejected:
 *  - 409 DOCTOR_OCCUPIED when this doctor's patient is `called` but not started (start or skip first);
 *  - 400 when `until` is not in the future or is after the session end (mark unavailable instead).
 * Call-next is blocked while away (409 SESSION_NOT_CALLABLE); queue order and the rotation pointer are kept.
 */
export const StepAwayRequest = z.object({
  /** Expected return. The UI always sends one (10/15/30/60 min or a custom time); omitted = unknown. */
  until: Instant.optional(),
  reason: z.string().trim().min(3).max(300).optional(),
});
export type StepAwayRequest = z.infer<typeof StepAwayRequest>;

/** The session columns availability is derived from (sessions row; instants as ISO strings or Dates). */
export interface AvailabilitySource {
  status: 'scheduled' | 'open' | 'paused' | 'unavailable' | 'closed';
  endsAt: string | Date;
  pausedAt: string | Date | null;
  pauseUntil: string | Date | null;
  pauseReason: string | null;
}

const iso = (v: string | Date | null): string | null => (v === null ? null : new Date(v).toISOString());

/**
 * Pure mapping from session state to SessionAvailability (D-032). The single definition shared by the API
 * (snapshots, display, session reads, today's visits) so every screen says the same thing.
 * `includeReason` is true only for staff reads; patients and the display never see the free-text reason.
 */
export function deriveAvailability(
  s: AvailabilitySource,
  now: Date,
  opts: { includeReason: boolean },
): SessionAvailability {
  const ended = new Date(s.endsAt).getTime() <= now.getTime();
  const base = { since: null, expectedBackAt: null, overdue: false, reason: null };
  switch (s.status) {
    case 'closed':
      return { state: 'ended', ...base };
    case 'unavailable':
      return { ...base, state: 'unavailable', since: iso(s.pausedAt), reason: opts.includeReason ? s.pauseReason : null };
    case 'paused': {
      const until = iso(s.pauseUntil);
      return {
        state: 'away',
        since: iso(s.pausedAt),
        expectedBackAt: until,
        overdue: until !== null && new Date(until).getTime() <= now.getTime(),
        reason: opts.includeReason ? s.pauseReason : null,
      };
    }
    case 'scheduled':
      return { state: ended ? 'ended' : 'not_started', ...base };
    case 'open':
      return { state: ended ? 'ended' : 'available', ...base };
  }
}
