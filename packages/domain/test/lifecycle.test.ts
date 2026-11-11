import { describe, expect, it } from 'vitest';
import {
  InvalidTransitionError,
  TRANSITIONS,
  allowedTransitions,
  assertTransition,
  canTransition,
  isTerminal,
} from '../src/index.js';
import type { MachineName, MachineStates } from '../src/index.js';

type Edge = readonly [string, string];

/** The complete set of legal edges per machine, written out independently of the implementation. */
const LEGAL: { [M in MachineName]: readonly Edge[] } = {
  appointment: [
    ['booked', 'checked_in'],
    ['booked', 'cancelled'],
    ['booked', 'missed'],
    ['booked', 'rescheduled'],
    ['checked_in', 'completed'],
  ],
  visit: [
    ['open', 'in_service'],
    ['open', 'left'],
    ['in_service', 'completed'],
  ],
  queueEntry: [
    ['waiting', 'called'],
    ['waiting', 'absent'],
    ['waiting', 'cancelled'],
    ['called', 'in_service'],
    ['called', 'skipped'],
    ['in_service', 'completed'],
    ['skipped', 'waiting'],
    ['skipped', 'cancelled'],
    ['absent', 'waiting'],
    ['absent', 'cancelled'],
  ],
  followUpTask: [
    ['open', 'acknowledged'],
    ['open', 'resolved'],
    ['open', 'cancelled'],
    ['acknowledged', 'resolved'],
    ['acknowledged', 'cancelled'],
  ],
  document: [
    ['uploaded', 'accepted'],
    ['uploaded', 'rejected'],
    ['accepted', 'processing'],
    ['processing', 'ocr_ready'],
    ['processing', 'ocr_failed'],
    ['ocr_failed', 'processing'],
    ['ocr_failed', 'verified'],
    ['ocr_ready', 'verified'],
  ],
};

const MACHINES = Object.keys(LEGAL) as MachineName[];

describe.each(MACHINES)('%s state machine', (machine) => {
  const states = Object.keys(TRANSITIONS[machine]);

  it('accepts exactly the legal edges and rejects every other pair', () => {
    const legal = new Set(LEGAL[machine].map(([f, t]) => `${f}>${t}`));
    for (const from of states) {
      for (const to of states) {
        const expected = legal.has(`${from}>${to}`);
        expect(canTransition(machine, from as never, to as never), `${from} -> ${to}`).toBe(expected);
        if (expected) {
          expect(() => assertTransition(machine, from as never, to as never)).not.toThrow();
        } else {
          expect(() => assertTransition(machine, from as never, to as never)).toThrow(InvalidTransitionError);
        }
      }
    }
  });

  it('every legal edge names known states', () => {
    for (const [from, to] of LEGAL[machine]) {
      expect(states).toContain(from);
      expect(states).toContain(to);
    }
  });

  it('allowedTransitions lists the targets of each state', () => {
    for (const from of states) {
      const expected = LEGAL[machine].filter(([f]) => f === from).map(([, t]) => t);
      expect([...allowedTransitions(machine, from as never)].sort()).toEqual([...expected].sort());
    }
  });

  it('rejects unknown states without throwing from canTransition', () => {
    expect(canTransition(machine, 'nonsense' as never, states[0] as never)).toBe(false);
    expect(canTransition(machine, states[0] as never, 'nonsense' as never)).toBe(false);
    expect(canTransition(machine, 'toString' as never, 'constructor' as never)).toBe(false);
    expect(allowedTransitions(machine, '__proto__' as never)).toEqual([]);
    expect(isTerminal(machine, 'nonsense' as never)).toBe(false);
  });
});

describe('InvalidTransitionError', () => {
  it('carries machine, from and to', () => {
    try {
      assertTransition('queueEntry', 'completed', 'waiting');
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(InvalidTransitionError);
      expect(e).toBeInstanceOf(Error);
      const err = e as InvalidTransitionError;
      expect(err.name).toBe('InvalidTransitionError');
      expect(err.machine).toBe('queueEntry');
      expect(err.from).toBe('completed');
      expect(err.to).toBe('waiting');
      expect(err.message).toBe('Invalid queueEntry transition: completed -> waiting');
    }
  });
});

describe('selected rules from the report', () => {
  it('a skipped or absent entry re-enters as waiting (same entry, new eligibility)', () => {
    expect(canTransition('queueEntry', 'skipped', 'waiting')).toBe(true);
    expect(canTransition('queueEntry', 'absent', 'waiting')).toBe(true);
  });

  it('a called entry cannot return to waiting or be cancelled directly', () => {
    expect(canTransition('queueEntry', 'called', 'waiting')).toBe(false);
    expect(canTransition('queueEntry', 'called', 'cancelled')).toBe(false);
  });

  it('a waiting entry cannot start service without being called', () => {
    expect(canTransition('queueEntry', 'waiting', 'in_service')).toBe(false);
  });

  it('completed consultations cannot be reopened', () => {
    expect(canTransition('visit', 'completed', 'in_service')).toBe(false);
    expect(canTransition('appointment', 'completed', 'checked_in')).toBe(false);
  });

  it('terminal states have no exits', () => {
    const terminals: [MachineName, string][] = [
      ['appointment', 'completed'],
      ['appointment', 'cancelled'],
      ['appointment', 'missed'],
      ['appointment', 'rescheduled'],
      ['visit', 'completed'],
      ['visit', 'left'],
      ['queueEntry', 'completed'],
      ['queueEntry', 'cancelled'],
      ['followUpTask', 'resolved'],
      ['followUpTask', 'cancelled'],
      ['document', 'verified'],
      ['document', 'rejected'],
    ];
    for (const [machine, state] of terminals) {
      expect(isTerminal(machine, state as MachineStates[typeof machine] as never), `${machine}.${state}`).toBe(true);
    }
    expect(isTerminal('queueEntry', 'waiting')).toBe(false);
  });

  it('OCR failure allows a controlled retry or manual transcription, but not skipping verification', () => {
    expect(canTransition('document', 'ocr_failed', 'processing')).toBe(true);
    expect(canTransition('document', 'ocr_failed', 'verified')).toBe(true);
    expect(canTransition('document', 'accepted', 'verified')).toBe(false);
    expect(canTransition('document', 'uploaded', 'ocr_ready')).toBe(false);
  });
});
