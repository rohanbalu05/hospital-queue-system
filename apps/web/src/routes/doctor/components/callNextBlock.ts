import type { StaffQueueSnapshot } from '@hqms/contracts';

/**
 * Why Call next is unavailable right now, in plain words, or null when it can be used.
 * The server still has the last word (409 DOCTOR_OCCUPIED / SESSION_NOT_CALLABLE); this only explains the common cases.
 */
export function callNextBlock(s: Pick<StaffQueueSnapshot, 'status' | 'active' | 'waiting'>): string | null {
  switch (s.status) {
    case 'paused':
      return "You are away, so no one can be called. Press I'm back to call the next patient.";
    case 'unavailable':
      return 'You are unavailable for the rest of this session, so no one can be called.';
    case 'closed':
      return 'The session is closed.';
    case 'scheduled':
      return 'The session has not started yet.';
    case 'open':
      break;
  }
  if (s.active) {
    return s.active.state === 'called'
      ? `${s.active.token} has been called. Start the visit when they arrive, or skip them, before calling the next patient.`
      : `${s.active.token} is in service. Complete the visit before calling the next patient.`;
  }
  if (s.waiting.length === 0) return 'No one is waiting. Patients appear here once they check in.';
  return null;
}
