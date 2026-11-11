import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { DisplaySnapshot, Eta } from '@hqms/contracts';
import { callNextBlock } from '@/routes/doctor/components/callNextBlock';
import { DisplayColumn } from '@/routes/display/DisplayColumn';
import { EtaBlock } from '@/routes/patient/visit/MyVisitPage';
import { entry, staffSnapshot } from './fixtures';

describe('callNextBlock', () => {
  const open = staffSnapshot({ waiting: [entry(14)] });

  it('allows a call when the session is open, nobody is active and someone is waiting', () => {
    expect(callNextBlock(open)).toBeNull();
  });

  it.each([
    ['paused', 'paused'],
    ['unavailable', 'unavailable'],
    ['closed', 'closed'],
    ['scheduled', 'not started'],
  ] as const)('explains a %s session', (status, word) => {
    expect(callNextBlock({ ...open, status })).toContain(word);
  });

  it('names the patient who must be finished first', () => {
    expect(callNextBlock({ ...open, active: entry(9, { state: 'called' }) })).toContain('A-009 has been called');
    expect(callNextBlock({ ...open, active: entry(9, { state: 'in_service' }) })).toContain('A-009 is in service');
  });

  it('explains an empty waiting list', () => {
    expect(callNextBlock({ ...open, waiting: [] })).toContain('No one is waiting');
  });
});

const baseEta: Eta = {
  status: 'ok',
  lowMinutes: 25,
  highMinutes: 40,
  note: null,
  computedAt: '2026-11-11T04:35:00.000Z',
  estimatorMeanMinutes: 12,
  estimatorSamples: 3,
  uncertainty: 'cold_start',
};

describe('EtaBlock', () => {
  it('shows a range with the cold-start words', () => {
    render(<EtaBlock eta={baseEta} />);
    expect(screen.getByText('about 25–40 min')).toBeVisible();
    expect(screen.getByText(/Early estimate: few consultations recorded yet/)).toBeVisible();
  });

  it('says the range was widened for an overrun', () => {
    render(<EtaBlock eta={{ ...baseEta, uncertainty: 'widened_overrun' }} />);
    expect(screen.getByText(/currently running longer|current consultation is running longer/i)).toBeVisible();
  });

  it.each(['withheld', 'unsupported'] as const)('shows "Estimate paused" and the note when %s', (status) => {
    render(<EtaBlock eta={{ ...baseEta, status, lowMinutes: null, highMinutes: null, uncertainty: null, note: 'Doctor paused (unknown duration)' }} />);
    expect(screen.getByText('Estimate paused')).toBeVisible();
    expect(screen.getByText(/Doctor paused \(unknown duration\)/)).toBeVisible();
    expect(screen.queryByText(/about/)).toBeNull();
  });
});

describe('DisplayColumn', () => {
  const column: DisplaySnapshot['columns'][number] = {
    sessionId: '00000000-0000-4000-8000-000000005e51',
    doctorLabel: 'Dr. Meenakshi Rao, General Medicine',
    room: 'Room 12',
    status: 'open',
    nowCalling: 'A-014',
    next: ['W-005', 'A-015', 'A-016'],
    queueVersion: 3,
  };

  it('shows the room, the token and the next three, and nothing else about patients', () => {
    const { container } = render(<DisplayColumn column={column} variant="tall" />);
    expect(screen.getByText('Room 12')).toBeVisible();
    expect(screen.getByTestId('now-calling')).toHaveTextContent('A-014');
    expect(screen.getAllByRole('listitem').map((li) => li.textContent)).toEqual(['W-005', 'A-015', 'A-016']);
    expect(container.textContent).not.toMatch(/Harish|Gowda|\+91/);
  });

  it('shows words instead of a token when the doctor is unavailable', () => {
    render(<DisplayColumn column={{ ...column, status: 'unavailable', next: [] }} variant="tall" />);
    expect(screen.queryByTestId('now-calling')).toBeNull();
    expect(screen.getByText('Doctor is unavailable')).toBeVisible();
  });
});
