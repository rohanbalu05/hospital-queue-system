import { describe, expect, it } from 'vitest';
import { entityLabel, operationSentence, roleWord } from './audit';

describe('audit wording', () => {
  it('turns operation codes into sentences', () => {
    expect(operationSentence('queue.call_next')).toBe('Called next patient');
    expect(operationSentence('queue.priority')).toBe('Set clinical priority');
    expect(operationSentence('appointment.book')).toBe('Booked appointment');
    expect(operationSentence('follow_up.return_booking')).toBe('Booked return visit');
  });

  it('falls back to the code for an operation it does not know', () => {
    expect(operationSentence('billing.adjust')).toBe('billing.adjust');
  });

  it('labels entities and roles, and passes unknown ones through', () => {
    expect(entityLabel('queue_entry')).toBe('Queue entry');
    expect(entityLabel('follow_up_task')).toBe('Follow-up task');
    expect(entityLabel('ledger')).toBe('ledger');
    expect(roleWord('followup')).toBe('Follow-up');
    expect(roleWord('porter')).toBe('porter');
  });
});
