import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { DisplaySnapshot, Eta } from '@hqms/contracts';
import { callNextBlock } from '@/routes/doctor/components/callNextBlock';
import { DisplayColumn } from '@/routes/display/DisplayColumn';
import { EtaBlock } from '@/routes/patient/visit/MyVisitPage';
import { AVAILABLE, awayAvailability, entry, staffSnapshot } from './fixtures';

describe('callNextBlock', () => {
  const open = staffSnapshot({ waiting: [entry(14)] });

  it('allows a call when the session is open, nobody is active and someone is waiting', () => {
    expect(callNextBlock(open)).toBeNull();
  });

  it.each([
    ['paused', 'away'],
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

  it('says the doctor paused the session when the estimate is withheld, without the model note', () => {
    render(<EtaBlock eta={{ ...baseEta, status: 'withheld', lowMinutes: null, highMinutes: null, uncertainty: null, note: 'Doctor paused (unknown duration). Model estimate.' }} />);
    expect(screen.getByText('Estimate paused')).toBeVisible();
    expect(screen.getByText("The doctor has paused this session. We'll show a new estimate when it resumes.")).toBeVisible();
    expect(screen.queryByText(/Model estimate/)).toBeNull();
    expect(screen.queryByText(/about/)).toBeNull();
  });

  it('shows the reason when the estimate is unsupported', () => {
    render(<EtaBlock eta={{ ...baseEta, status: 'unsupported', lowMinutes: null, highMinutes: null, uncertainty: null, note: 'Not enough data for this session' }} />);
    expect(screen.getByText('Estimate paused')).toBeVisible();
    expect(screen.getByText(/Not enough data for this session/)).toBeVisible();
  });
});

describe('DisplayColumn', () => {
  const column: DisplaySnapshot['columns'][number] = {
    sessionId: '00000000-0000-4000-8000-000000005e51',
    doctorLabel: 'Dr. Meenakshi Rao, General Medicine',
    room: 'Room 12',
    status: 'open',
    availability: AVAILABLE,
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
    render(
      <DisplayColumn
        column={{ ...column, status: 'unavailable', next: [], availability: { ...AVAILABLE, state: 'unavailable', since: '2026-11-11T05:00:00.000Z' } }}
        variant="tall"
      />,
    );
    expect(screen.queryByTestId('now-calling')).toBeNull();
    expect(screen.getByText('No calls in this session')).toBeVisible();
  });
});

describe('DisplayColumn availability banner (B2)', () => {
  const column: DisplaySnapshot['columns'][number] = {
    sessionId: '00000000-0000-4000-8000-000000005e51',
    doctorLabel: 'Dr. Meenakshi Rao, General Medicine',
    room: 'Room 12',
    status: 'paused',
    availability: awayAvailability({ reason: null }),
    nowCalling: null,
    next: ['A-015', 'W-005'],
    queueVersion: 3,
  };
  const FIVE_PAST_ELEVEN = new Date('2026-11-11T05:35:00.000Z'); // 11:05 am IST, after the 10:45 am expected return

  afterEach(() => vi.useRealTimers());

  it('says the doctor is temporarily away and when they are expected back, in the warning tone', () => {
    vi.useFakeTimers({ now: new Date('2026-11-11T04:35:00.000Z') }); // 10:05 am IST
    render(<DisplayColumn column={column} variant="tall" />);
    const banner = screen.getByTestId('display-banner');
    expect(banner).toHaveTextContent('Dr. Meenakshi Rao is temporarily away, expected back about 10:45 am');
    expect(banner).toHaveAttribute('data-state', 'away');
    expect(banner.className).toContain('border-l-walkin');
    expect(banner.className).not.toContain('priority');
    // The waiting tokens stay on screen.
    expect(screen.getAllByRole('listitem').map((li) => li.textContent)).toEqual(['A-015', 'W-005']);
  });

  it('says the doctor will be back shortly once the expected time has passed', () => {
    vi.useFakeTimers({ now: FIVE_PAST_ELEVEN });
    render(<DisplayColumn column={column} variant="tall" />);
    expect(screen.getByTestId('display-banner')).toHaveTextContent('Dr. Meenakshi Rao is away and will be back shortly');
  });

  it('says only temporarily away when no return time is known', () => {
    render(<DisplayColumn column={{ ...column, availability: awayAvailability({ expectedBackAt: null }) }} variant="tall" />);
    expect(screen.getByTestId('display-banner')).toHaveTextContent(/^Dr\. Meenakshi Rao is temporarily away$/);
  });

  it('tells patients to see reception when the doctor is unavailable for the rest of the session, in the urgent tone', () => {
    render(
      <DisplayColumn
        column={{ ...column, status: 'unavailable', next: [], availability: { state: 'unavailable', since: '2026-11-11T05:00:00.000Z', expectedBackAt: null, overdue: false, reason: null } }}
        variant="wide"
      />,
    );
    const banner = screen.getByTestId('display-banner');
    expect(banner).toHaveTextContent('Dr. Meenakshi Rao is not available for the rest of this session. Please see reception.');
    expect(banner.className).toContain('border-l-priority');
  });

  it('shows no banner for an available doctor and never prints a free-text reason', () => {
    const { container, rerender } = render(<DisplayColumn column={{ ...column, status: 'open', availability: AVAILABLE }} variant="tall" />);
    expect(screen.queryByTestId('display-banner')).toBeNull();
    rerender(<DisplayColumn column={{ ...column, availability: awayAvailability({ reason: 'Ward round' }) }} variant="tall" />);
    expect(container.textContent).not.toContain('Ward round');
  });
});
