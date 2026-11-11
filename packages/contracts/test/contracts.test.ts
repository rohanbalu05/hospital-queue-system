import { describe, expect, it } from 'vitest';
import { ApiError, BookAppointmentRequest, DisplaySnapshot, QueueSnapshot, Token } from '../src/index.js';

describe('contracts', () => {
  it('accepts display tokens and rejects others', () => {
    expect(Token.safeParse('A-014').success).toBe(true);
    expect(Token.safeParse('P-001').success).toBe(false);
  });
  it('display snapshot carries no patient fields', () => {
    const keys = Object.keys(DisplaySnapshot.shape.columns.element.shape);
    expect(keys).not.toContain('patientName');
    expect(keys).not.toContain('patientId');
  });
  it('parses error envelope', () => {
    expect(ApiError.parse({ error: { code: 'CAPACITY_FULL', message: 'Session is full' } }).error.code).toBe('CAPACITY_FULL');
  });
  it('book request requires session id', () => {
    expect(BookAppointmentRequest.safeParse({}).success).toBe(false);
  });
  it('snapshot union discriminates on view', () => {
    expect(QueueSnapshot.safeParse({ view: 'display', capturedAt: '2026-11-11T09:00:00+05:30', columns: [] }).success).toBe(true);
  });
});
