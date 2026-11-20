import { describe, expect, it } from 'vitest';
import type { DisplaySnapshot } from '@hqms/contracts';
import { keepNewest, keepNewestDisplay } from './monotonic';
import { AVAILABLE, uid } from './fixtures';

const column = (n: number, queueVersion: number, nowCalling: string | null): DisplaySnapshot['columns'][number] => ({
  sessionId: uid(n),
  doctorLabel: 'Dr. Meenakshi Rao, General Medicine',
  room: 'Room 12',
  status: 'open',
  availability: AVAILABLE,
  nowCalling,
  next: [],
  queueVersion,
});
const snap = (columns: DisplaySnapshot['columns']): DisplaySnapshot => ({ view: 'display', capturedAt: '2026-11-11T04:35:00.000Z', columns });

describe('keepNewest', () => {
  it('keeps the held snapshot when the incoming one is older, takes equal or newer', () => {
    expect(keepNewest({ queueVersion: 8, tag: 'held' }, { queueVersion: 6, tag: 'in' }).tag).toBe('held');
    expect(keepNewest({ queueVersion: 8, tag: 'held' }, { queueVersion: 8, tag: 'in' }).tag).toBe('in');
    expect(keepNewest({ queueVersion: 8, tag: 'held' }, { queueVersion: 9, tag: 'in' }).tag).toBe('in');
    expect(keepNewest(undefined, { queueVersion: 1, tag: 'in' }).tag).toBe('in');
  });
});

describe('keepNewestDisplay', () => {
  it('keeps a column that is newer on screen, and takes the other columns from the incoming snapshot', () => {
    const held = snap([column(1, 9, 'A-014'), column(2, 3, 'W-005')]);
    const incoming = snap([column(1, 7, 'A-012'), column(2, 4, 'W-006'), column(3, 1, null)]);
    const merged = keepNewestDisplay(held, incoming);
    expect(merged.columns.map((c) => c.nowCalling)).toEqual(['A-014', 'W-006', null]);
  });
  it('returns the incoming snapshot untouched when nothing is older', () => {
    const incoming = snap([column(1, 9, 'A-014')]);
    expect(keepNewestDisplay(snap([column(1, 9, 'A-013')]), incoming)).toBe(incoming);
  });
});
