import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { Route, Routes } from 'react-router-dom';
import { RequireRole } from '@/components/layout/Guards';
import { FakeEventSource } from '@/live/fakeEventSource';
import { Providers, patientUser, stubApi, testQueryClient, uuid, type Handler } from '@/lib/testing';
import MyVisitPage from './visit/MyVisitPage';
import TodayPage from './TodayPage';
import VisitsPage from './VisitsPage';

beforeEach(() => {
  FakeEventSource.reset();
  vi.stubGlobal('EventSource', FakeEventSource);
});
afterEach(() => vi.unstubAllGlobals());
beforeAll(() => {
  Element.prototype.scrollIntoView = () => undefined;
});

const me = patientUser(1, 'Ananya Iyer');
const SESSION = uuid(0x5e1);
const APPT = uuid(0xa91);
const today = new Date().toISOString().slice(0, 10);
const at = (hhmm: string) => `${today}T${hhmm}:00+05:30`;
const iso = (hhmm: string) => new Date(at(hhmm)).toISOString();

const availability = (state: string, over: Record<string, unknown> = {}) => ({ state, since: iso('09:50'), expectedBackAt: null, overdue: false, reason: null, ...over });
const AWAY = availability('away', { expectedBackAt: iso('10:45') });
const GONE = availability('unavailable');
const FINE = availability('available', { since: null });

const eta = (over: Record<string, unknown> = {}) => ({
  status: 'ok',
  lowMinutes: 40,
  highMinutes: 55,
  note: null,
  computedAt: iso('10:05'),
  estimatorMeanMinutes: 12,
  estimatorSamples: 5,
  uncertainty: 'warm',
  ...over,
});

const snapshot = (av: unknown, position: number | null = 1, etaOver: Record<string, unknown> = {}) => ({
  view: 'patient',
  sessionId: SESSION,
  status: 'open',
  availability: av,
  doctorName: 'Dr. Arvind Kulkarni',
  queueVersion: 7,
  capturedAt: iso('10:05'),
  myEntry: position === null ? null : { queueEntryId: uuid(0xe1), token: 'A-016', group: 'A', state: 'waiting', position, eta: eta(etaOver) },
  nowCalling: null,
});

const session = (av: unknown) => ({
  id: SESSION,
  doctorId: uuid(0xd2),
  doctorName: 'Dr. Arvind Kulkarni',
  department: 'Paediatrics',
  room: '4',
  sessionDate: today,
  label: 'morning',
  startsAt: iso('09:00'),
  endsAt: iso('13:00'),
  slotMinutes: 20,
  status: 'open',
  availability: av,
  policyVersion: 1,
  capacity: { bookedCapacity: 10, walkinCapacity: 5, bookedReserved: 6, walkinUsed: 1, bookedAvailable: 4, walkinAvailable: 4 },
  version: 3,
});

const appointment = (status: string) => ({
  id: APPT,
  patientId: me.patientId,
  sessionId: SESSION,
  doctorId: uuid(0xd2),
  doctorName: 'Dr. Arvind Kulkarni',
  department: 'Paediatrics',
  scheduledAt: at('10:20'),
  status,
  rescheduledFromId: null,
  followUpTaskId: null,
  version: 2,
  createdAt: at('08:00'),
});

const notFound = { status: 404, body: { error: { code: 'NOT_FOUND', message: 'No visit in this session.' } } };

function server(opts: { snapshot: unknown | 'missing'; session?: unknown; appointment?: string | null }): Handler[] {
  return [
    ({ path }) => (path === '/me' ? { body: me } : undefined),
    ({ path }) => (path === '/appointments' ? { body: opts.appointment ? [appointment(opts.appointment)] : [] } : undefined),
    ({ path }) => (path === '/me/visits/today' ? { body: [] } : undefined),
    ({ path }) => (path === `/sessions/${SESSION}/queue` ? (opts.snapshot === 'missing' ? notFound : { body: opts.snapshot }) : undefined),
    ({ path }) => (path === `/sessions/${SESSION}` ? (opts.session ? { body: opts.session } : notFound) : undefined),
    ({ path }) => (path.startsWith('/notifications') ? { body: path.endsWith('count') ? { unreadCount: 0 } : [] } : undefined),
  ];
}

function renderAt(url: string) {
  render(
    <Providers qc={testQueryClient()} initial={[url]}>
      <Routes>
        <Route element={<RequireRole roles={['patient']} />}>
          <Route path="/patient" element={<TodayPage />} />
          <Route path="/patient/visits" element={<VisitsPage />} />
          <Route path="/patient/visit/:sessionId" element={<MyVisitPage />} />
        </Route>
      </Routes>
    </Providers>,
  );
}

describe('My visit while the doctor is unavailable (PR-11)', () => {
  it('shows one consistent message set: see reception, with no "next", position or paused estimate', async () => {
    stubApi(...server({ snapshot: snapshot(GONE, 1), appointment: 'checked_in' }));
    renderAt(`/patient/visit/${SESSION}`);
    const banner = await screen.findByTestId('availability-banner');
    expect(banner).toHaveTextContent('Dr. Arvind Kulkarni is not available for the rest of this session');
    expect(banner).toHaveTextContent('Please see reception: they will move you to another doctor.');
    expect(screen.queryByText(/You are next/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Number 1/)).not.toBeInTheDocument();
    expect(screen.queryByText(/You are in the queue/)).not.toBeInTheDocument();
    expect(screen.queryByTestId('eta')).not.toBeInTheDocument();
    expect(screen.queryByText(/Estimate paused/)).not.toBeInTheDocument();
    // The token stays: it is how reception finds the patient.
    expect(screen.getByText('A-016')).toBeInTheDocument();
  });
});

describe('My visit while the doctor is away (PR-10, PR-11)', () => {
  it('says when the doctor is expected back, keeps the place and shows the updated wait once', async () => {
    stubApi(...server({ snapshot: snapshot(AWAY, 1), appointment: 'checked_in' }));
    renderAt(`/patient/visit/${SESSION}`);
    const banner = await screen.findByTestId('availability-banner');
    expect(banner).toHaveTextContent('expected back about 10:45 am');
    expect(banner).toHaveTextContent('Your place in the queue is kept.');
    expect(banner).toHaveTextContent('Updated wait: about 40–55 min');
    expect(screen.queryByText(/You are next/)).not.toBeInTheDocument();
    expect(screen.queryByTestId('eta')).not.toBeInTheDocument();
    expect(screen.getByTestId('position')).toHaveTextContent('Number 1');
  });

  it('shows the ETA note instead of a range when the estimate is withheld, and never "paused this session"', async () => {
    stubApi(...server({ snapshot: snapshot(AWAY, 2, { status: 'withheld', lowMinutes: null, highMinutes: null, note: 'The doctor is away longer than expected' }), appointment: 'checked_in' }));
    renderAt(`/patient/visit/${SESSION}`);
    const banner = await screen.findByTestId('availability-banner');
    expect(banner).toHaveTextContent('The doctor is away longer than expected');
    expect(screen.queryByText(/paused this session/)).not.toBeInTheDocument();
  });
});

describe('My visit before check-in (PR-08, PR-12)', () => {
  it('shows a friendly not-checked-in state, not an error, when the server has no visit for this patient', async () => {
    stubApi(...server({ snapshot: 'missing', session: session(FINE), appointment: 'booked' }));
    renderAt(`/patient/visit/${SESSION}`);
    expect(await screen.findByText('You have not checked in yet')).toBeInTheDocument();
    expect(screen.getByText(/Check in at reception when you arrive/)).toBeInTheDocument();
    expect(screen.queryByText('We could not find your visit in this session')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Try again' })).not.toBeInTheDocument();
  });

  it('adds the urgent banner with Rebook and Cancel when the doctor is unavailable', async () => {
    stubApi(...server({ snapshot: 'missing', session: session(GONE), appointment: 'booked' }));
    renderAt(`/patient/visit/${SESSION}`);
    const banner = await screen.findByTestId('availability-banner');
    expect(banner).toHaveAttribute('role', 'alert');
    expect(within(banner).getByRole('link', { name: 'Rebook with another doctor' })).toHaveAttribute('href', `/patient/visits?rebook=${APPT}`);
    expect(within(banner).getByRole('button', { name: 'Cancel appointment' })).toBeInTheDocument();
    expect(screen.getByText('You have not checked in yet')).toBeInTheDocument();
  });

  it('a patient with no appointment in the session still gets the plain error', async () => {
    stubApi(...server({ snapshot: 'missing', appointment: null }));
    renderAt(`/patient/visit/${SESSION}`);
    expect(await screen.findByText('We could not find your visit in this session')).toBeInTheDocument();
  });
});

describe('Today for a booked appointment that has not been checked in (PR-08, PR-12)', () => {
  it('has no queue link, and flags an unavailable doctor with Rebook and Cancel', async () => {
    stubApi(...server({ snapshot: 'missing', session: session(GONE), appointment: 'booked' }));
    renderAt('/patient');
    const card = await screen.findByTestId('today-appointment');
    const banner = await within(card).findByTestId('availability-banner');
    expect(banner).toHaveTextContent('not available for the rest of this session');
    expect(within(banner).getByRole('link', { name: 'Rebook with another doctor' })).toBeInTheDocument();
    expect(within(banner).getByRole('button', { name: 'Cancel appointment' })).toBeInTheDocument();
    expect(within(card).queryByRole('link', { name: 'See my place in the queue' })).not.toBeInTheDocument();
    expect(card).toHaveTextContent('Check in at reception when you arrive');
  });

  it('keeps the queue link once the patient is checked in', async () => {
    stubApi(...server({ snapshot: snapshot(FINE, 3), session: session(FINE), appointment: 'checked_in' }));
    renderAt('/patient');
    const card = await screen.findByTestId('today-appointment');
    expect(within(card).getByRole('link', { name: 'See my place in the queue' })).toBeInTheDocument();
  });
});

describe('My visits list for a booked appointment (PR-12)', () => {
  it('flags an away or unavailable doctor on the row, and shows no queue link before check-in', async () => {
    stubApi(...server({ snapshot: 'missing', session: session(GONE), appointment: 'booked' }));
    renderAt('/patient/visits');
    const banner = await screen.findByTestId('availability-banner');
    expect(banner).toHaveTextContent('not available for the rest of this session');
    expect(within(banner).getByRole('link', { name: 'Rebook with another doctor' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'See my place in the queue' })).not.toBeInTheDocument();
  });

  it('says the doctor has stepped away, with the return time, on a booked row', async () => {
    stubApi(...server({ snapshot: 'missing', session: session(AWAY), appointment: 'booked' }));
    renderAt('/patient/visits');
    const banner = await screen.findByTestId('availability-banner');
    expect(banner).toHaveTextContent('has stepped away and is expected back about 10:45 am');
    expect(banner).toHaveTextContent('Your appointment is kept.');
  });
});
