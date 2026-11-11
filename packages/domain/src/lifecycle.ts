/**
 * Lifecycle state machines (report Figure 9: separate lifecycles connected by explicit domain
 * operations). Each machine is a transition table; invalid transitions are rejected.
 */

export type AppointmentStatus = 'booked' | 'checked_in' | 'completed' | 'cancelled' | 'missed' | 'rescheduled';
export type VisitStatus = 'open' | 'in_service' | 'completed' | 'left';
export type QueueEntryStatus =
  | 'waiting'
  | 'called'
  | 'in_service'
  | 'completed'
  | 'skipped'
  | 'absent'
  | 'cancelled';
export type FollowUpStatus = 'open' | 'acknowledged' | 'resolved' | 'cancelled';
export type DocumentStatus =
  | 'uploaded'
  | 'accepted'
  | 'processing'
  | 'ocr_ready'
  | 'ocr_failed'
  | 'verified'
  | 'rejected';

export interface MachineStates {
  appointment: AppointmentStatus;
  visit: VisitStatus;
  queueEntry: QueueEntryStatus;
  followUpTask: FollowUpStatus;
  document: DocumentStatus;
}

export type MachineName = keyof MachineStates;

type Table<S extends string> = { readonly [K in S]: readonly S[] };

export const TRANSITIONS: { readonly [M in MachineName]: Table<MachineStates[M]> } = {
  appointment: {
    booked: ['checked_in', 'cancelled', 'missed', 'rescheduled'],
    checked_in: ['completed'],
    completed: [],
    cancelled: [],
    // missed -> checked_in is the late-admission path only (staff confirmed capacity; walk-in ordering).
    missed: ['checked_in'],
    rescheduled: [],
  },
  visit: {
    open: ['in_service', 'left'],
    in_service: ['completed'],
    completed: [],
    left: [],
  },
  queueEntry: {
    waiting: ['called', 'absent', 'cancelled'],
    // called -> skipped covers both the 2-minute timeout and a manual skip.
    called: ['in_service', 'skipped'],
    in_service: ['completed'],
    // skipped / absent -> waiting is the re-entry (same entry, fresh eligibility, history kept).
    skipped: ['waiting', 'cancelled'],
    absent: ['waiting', 'cancelled'],
    completed: [],
    cancelled: [],
  },
  followUpTask: {
    open: ['acknowledged', 'resolved', 'cancelled'],
    acknowledged: ['resolved', 'cancelled'],
    resolved: [],
    cancelled: [],
  },
  document: {
    uploaded: ['accepted', 'rejected'],
    accepted: ['processing'],
    processing: ['ocr_ready', 'ocr_failed'],
    // ocr_failed -> processing is the controlled retry; -> verified is manual transcription.
    ocr_failed: ['processing', 'verified'],
    ocr_ready: ['verified'],
    verified: [],
    rejected: [],
  },
};

export class InvalidTransitionError extends Error {
  readonly machine: MachineName;
  readonly from: string;
  readonly to: string;

  constructor(machine: MachineName, from: string, to: string) {
    super(`Invalid ${machine} transition: ${from} -> ${to}`);
    this.name = 'InvalidTransitionError';
    this.machine = machine;
    this.from = from;
    this.to = to;
  }
}

function targets(machine: MachineName, from: string): readonly string[] {
  const table = TRANSITIONS[machine] as Readonly<Record<string, readonly string[]>>;
  return Object.hasOwn(table, from) ? (table[from] as readonly string[]) : [];
}

/** Legal next states from `from` (empty for terminal or unknown states). */
export function allowedTransitions<M extends MachineName>(machine: M, from: MachineStates[M]): readonly MachineStates[M][] {
  return targets(machine, from) as readonly MachineStates[M][];
}

export function canTransition<M extends MachineName>(machine: M, from: MachineStates[M], to: MachineStates[M]): boolean {
  return targets(machine, from).includes(to);
}

/** Throws InvalidTransitionError unless `from -> to` is legal. */
export function assertTransition<M extends MachineName>(machine: M, from: MachineStates[M], to: MachineStates[M]): void {
  if (!canTransition(machine, from, to)) throw new InvalidTransitionError(machine, from, to);
}

/** A state with no outgoing transitions. Unknown states are not terminal. */
export function isTerminal<M extends MachineName>(machine: M, state: MachineStates[M]): boolean {
  const table = TRANSITIONS[machine] as Readonly<Record<string, readonly string[]>>;
  return Object.hasOwn(table, state) && (table[state] as readonly string[]).length === 0;
}
