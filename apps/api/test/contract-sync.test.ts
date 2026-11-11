import { describe, expect, it } from 'vitest';
import { AppointmentStatus, DecisionReason, QueueEntryState, QueueGroup, SessionStatus } from '@hqms/contracts';
import { TRANSITIONS } from '@hqms/domain';

/** D-004: @hqms/domain re-declares its literals; this keeps them in step with the contracts. */
describe('domain literals match contracts', () => {
  it('appointment, queue entry and session states', () => {
    expect(Object.keys(TRANSITIONS.appointment).sort()).toEqual([...AppointmentStatus.options].sort());
    expect(Object.keys(TRANSITIONS.queueEntry).sort()).toEqual([...QueueEntryState.options].sort());
    expect(QueueGroup.options).toEqual(['A', 'W']);
    expect(SessionStatus.options.length).toBe(5);
    expect(DecisionReason.options).toEqual(['CLINICAL_PRIORITY', 'AGING', 'ROTATION', 'NO_ALLOCATION']);
  });
});
