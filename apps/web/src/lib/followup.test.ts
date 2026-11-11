import { describe, expect, it } from 'vitest';
import {
  PATIENT_DOCUMENT_STATUS,
  durationWord,
  fileSizeWord,
  isInFlight,
  reasonWord,
  shortId,
  sortTasks,
  sourceVisitWord,
  taskTiming,
  validateUpload,
} from './followup';

const NOW = new Date('2026-11-11T04:35:00Z').getTime(); // 10:05 am IST

describe('durationWord', () => {
  it.each([
    [0, '0 min'],
    [40, '40 min'],
    [59.9, '59 min'],
    [60, '1 h'],
    [26 * 60, '26 h'],
    [47 * 60, '47 h'],
    [48 * 60, '2 d'],
    [51 * 60, '2 d 3 h'],
    [-5, '0 min'],
  ])('%s minutes reads %s', (min, word) => {
    expect(durationWord(min)).toBe(word);
  });
});

describe('taskTiming', () => {
  const task = (over: Partial<Parameters<typeof taskTiming>[0]> = {}) => ({ status: 'open' as const, dueAt: '2026-11-11T14:00:00+05:30', overdue: false, ...over });

  it('says when an open task is due', () => {
    expect(taskTiming(task(), NOW)).toEqual({ overdue: false, label: 'Due in 3 h' });
  });

  it('turns overdue by the clock even if the server flag is stale', () => {
    expect(taskTiming(task({ dueAt: '2026-11-10T17:00:00+05:30' }), NOW)).toEqual({ overdue: true, label: 'Overdue 17 h' });
  });

  it('trusts the server flag too', () => {
    expect(taskTiming(task({ overdue: true }), NOW).overdue).toBe(true);
  });

  it('has no timing once resolved or cancelled', () => {
    expect(taskTiming(task({ status: 'resolved', dueAt: '2026-11-01T10:00:00+05:30', overdue: true }), NOW)).toEqual({ overdue: false, label: null });
    expect(taskTiming(task({ status: 'cancelled' }), NOW).label).toBeNull();
  });
});

describe('sortTasks', () => {
  it('lists overdue first, then by due time, with closed tasks last', () => {
    const t = (id: string, status: 'open' | 'acknowledged' | 'resolved', dueAt: string) => ({ id, status, dueAt, overdue: false });
    const sorted = sortTasks(
      [
        t('later', 'open', '2026-11-12T10:00:00+05:30'),
        t('closed', 'resolved', '2026-11-01T10:00:00+05:30'),
        t('overdue-late', 'acknowledged', '2026-11-11T08:00:00+05:30'),
        t('soon', 'open', '2026-11-11T16:00:00+05:30'),
        t('overdue-early', 'open', '2026-11-10T09:00:00+05:30'),
      ],
      NOW,
    );
    expect(sorted.map((x) => x.id)).toEqual(['overdue-early', 'overdue-late', 'soon', 'later', 'closed']);
  });
});

describe('sourceVisitWord', () => {
  const fmt = (d: string) => `on ${d}`;
  it('names the date and doctor when the API sends the visit', () => {
    expect(sourceVisitWord({ sourceVisitId: 'x', sourceVisit: { sessionDate: '2026-11-04', doctorName: 'Dr. Meenakshi Rao' } }, fmt)).toBe('on 2026-11-04, Dr. Meenakshi Rao');
  });
  it('falls back to a short reference, then to a plain phrase', () => {
    expect(sourceVisitWord({ sourceVisitId: '12345678-aaaa', sourceVisit: null }, fmt)).toBe('Visit 12345678');
    expect(sourceVisitWord({ sourceVisitId: null }, fmt)).toBe('No visit linked');
  });
});

describe('validateUpload', () => {
  const file = (type: string, size: number) => ({ name: 'scan', type, size });
  it('accepts pdf, png and jpeg up to 10 MB', () => {
    for (const type of ['application/pdf', 'image/png', 'image/jpeg']) expect(validateUpload(file(type, 10 * 1024 * 1024))).toBeNull();
  });
  it('refuses other types and says which are accepted', () => {
    expect(validateUpload(file('text/plain', 100))).toBe('This file type is not accepted. Choose a PDF, PNG or JPEG.');
    expect(validateUpload(file('image/gif', 100))).toMatch(/not accepted/);
  });
  it('refuses files over 10 MB with the size in words', () => {
    expect(validateUpload(file('application/pdf', 11 * 1024 * 1024))).toMatch(/This file is 11\.0 MB\. The limit is 10 MB/);
  });
  it('refuses an empty file', () => {
    expect(validateUpload(file('image/png', 0))).toMatch(/empty/);
  });
});

describe('documents', () => {
  it('uses the patient words for every status', () => {
    expect(PATIENT_DOCUMENT_STATUS.uploaded.word).toBe('Uploaded');
    expect(PATIENT_DOCUMENT_STATUS.processing.word).toBe('Processing');
    expect(PATIENT_DOCUMENT_STATUS.ocr_ready.word).toBe('Ready for review');
    expect(PATIENT_DOCUMENT_STATUS.verified.word).toBe('Verified');
    expect(PATIENT_DOCUMENT_STATUS.ocr_failed.word).toBe("Couldn't read — staff will review");
  });
  it('treats uploaded, accepted and processing as still being read', () => {
    expect(['uploaded', 'accepted', 'processing'].every((s) => isInFlight(s as never))).toBe(true);
    expect(isInFlight('ocr_ready')).toBe(false);
    expect(isInFlight('verified')).toBe(false);
  });
  it('writes file sizes in KB or MB', () => {
    expect(fileSizeWord(412_000)).toBe('402 KB');
    expect(fileSizeWord(2_300_000)).toBe('2.2 MB');
  });
});

describe('reasonWord and shortId', () => {
  it('names decision reasons in words and passes unknown reasons through', () => {
    expect(reasonWord('ROTATION')).toBe('Rotation');
    expect(reasonWord('CLINICAL_PRIORITY')).toBe('Clinical priority');
    expect(reasonWord('Raised walk-in places from 4 to 5')).toBe('Raised walk-in places from 4 to 5');
  });
  it('shortens ids for tables', () => {
    expect(shortId('3f2a1c9e-0b7d-4c1a-9a55-2f6e8d1b7c40')).toBe('3f2a1c9e');
    expect(shortId(null)).toBe('-');
  });
});
