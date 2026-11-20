import type { Eta, SessionAvailability } from '@hqms/contracts';
import { formatIST, formatMinuteRange } from './format';

export type Placement = 'booked' | 'in_queue';

export interface AvailabilityWords {
  tone: 'info' | 'warning' | 'urgent';
  /** The bold first line. */
  title: string;
  /** Plain sentences under it. */
  lines: string[];
}

/** Wait sentence for a patient who is already in the queue while the doctor is away. */
export function awayWaitLine(eta: Eta | null | undefined): string | null {
  if (!eta) return null;
  if (eta.status === 'ok' && eta.lowMinutes !== null && eta.highMinutes !== null) {
    return `Updated wait: ${formatMinuteRange(eta.lowMinutes, eta.highMinutes)} from ${formatIST(eta.computedAt)}.`;
  }
  return eta.note ?? 'We will show a new estimate when the doctor is back.';
}

/**
 * What the patient is told about the doctor of their session (D-032). Away keeps the place; unavailable says what to do next.
 * Returns null when there is nothing to say (available, not started, ended).
 */
export function availabilityWords(
  availability: SessionAvailability,
  doctorName: string,
  placement: Placement,
  eta?: Eta | null,
): AvailabilityWords | null {
  switch (availability.state) {
    case 'away': {
      const place = placement === 'in_queue' ? 'Your place in the queue is kept.' : 'Your appointment is kept.';
      const lead = availability.overdue
        ? `${doctorName} has stepped away and is taking longer than expected to return.`
        : availability.expectedBackAt
          ? `${doctorName} has stepped away and is expected back about ${formatIST(availability.expectedBackAt)}.`
          : `${doctorName} has stepped away. There is no return time yet.`;
      const wait = placement === 'in_queue' ? awayWaitLine(eta) : null;
      return { tone: 'warning', title: 'The doctor has stepped away', lines: [`${lead} ${place}`, ...(wait ? [wait] : [])] };
    }
    case 'unavailable':
      return {
        tone: 'urgent',
        title: `${doctorName} is not available for the rest of this session`,
        lines:
          placement === 'in_queue'
            ? ['Please see reception: they will move you to another doctor.']
            : ['Choose another doctor for today or another day, or cancel this appointment.'],
      };
    default:
      return null;
  }
}
