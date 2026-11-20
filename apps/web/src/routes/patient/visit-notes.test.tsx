import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes } from 'react-router-dom';
import { RequireRole } from '@/components/layout/Guards';
import { istDate } from '@/lib/dates';
import { Providers, patientUser, stubApi, testQueryClient, uuid, type Handler } from '@/lib/testing';
import TodayPage from './TodayPage';
import VisitsPage from './VisitsPage';

afterEach(() => vi.unstubAllGlobals());
beforeAll(() => {
  Element.prototype.scrollIntoView = () => undefined;
  Element.prototype.hasPointerCapture = () => false;
  Element.prototype.setPointerCapture = () => undefined;
  Element.prototype.releasePointerCapture = () => undefined;
});

const me = patientUser(1, 'Ananya Iyer');
const today = istDate();
const slot = (hhmm: string) => `${today}T${hhmm}:00+05:30`;

const appt = (n: number, over: Record<string, unknown> = {}) => ({
  id: uuid(0xa90 + n),
  patientId: me.patientId,
  sessionId: uuid(0x5e1),
  doctorId: uuid(0xd2),
  doctorName: 'Dr. Meenakshi Hegde',
  department: 'General Medicine',
  scheduledAt: slot('09:00'),
  status: 'completed',
  rescheduledFromId: null,
  followUpTaskId: null,
  version: 3,
  createdAt: slot('08:00'),
  ...over,
});

const unavailableSession = {
  id: uuid(0x5e1),
  doctorId: uuid(0xd2),
  doctorName: 'Dr. Meenakshi Hegde',
  department: 'General Medicine',
  room: '4',
  sessionDate: today,
  label: 'morning',
  startsAt: slot('09:00'),
  endsAt: slot('13:00'),
  slotMinutes: 20,
  status: 'unavailable',
  availability: { state: 'unavailable', since: slot('09:55'), expectedBackAt: null, overdue: false, reason: null },
  policyVersion: 1,
  capacity: { bookedCapacity: 10, walkinCapacity: 5, bookedReserved: 6, walkinUsed: 1, bookedAvailable: 4, walkinAvailable: 4 },
  version: 3,
};

function renderAt(path: string, handler: Handler) {
  stubApi(({ path: p }) => (p === '/me' ? { body: me } : undefined), ({ path: p }) => (p === '/me/visits/today' ? { body: [] } : undefined), handler);
  render(
    <Providers qc={testQueryClient()} initial={[path]}>
      <Routes>
        <Route element={<RequireRole roles={['patient']} />}>
          <Route path="/patient" element={<TodayPage />} />
          <Route path="/patient/visits" element={<VisitsPage />} />
        </Route>
      </Routes>
    </Providers>,
  );
}

describe('Today after a completed visit (PR-15)', () => {
  it('says the visit was completed instead of "No visit today", and links to Follow-ups', async () => {
    renderAt('/patient', ({ path }) => (path === '/appointments' ? { body: [appt(1)] } : undefined));
    const card = await screen.findByTestId('today-completed');
    expect(card).toHaveTextContent('Visit completed at 9:00 am with Dr. Meenakshi Hegde');
    expect(within(card).getByRole('link', { name: /follow-ups/i })).toHaveAttribute('href', '/patient/follow-ups');
    expect(screen.queryByText('No visit today')).toBeNull();
  });

  it('still says "No visit today" when nothing happened today', async () => {
    renderAt('/patient', ({ path }) => (path === '/appointments' ? { body: [appt(1, { scheduledAt: '2020-01-02T09:00:00+05:30' })] } : undefined));
    expect(await screen.findByText('No visit today')).toBeVisible();
    expect(screen.queryByTestId('today-completed')).toBeNull();
  });

  it('labels a return appointment created from a follow-up task on Today', async () => {
    const ret = appt(2, { status: 'booked', scheduledAt: slot('23:30'), followUpTaskId: uuid(0x7a1) });
    renderAt('/patient', ({ path }) => (path === '/appointments' ? { body: [ret] } : undefined));
    const card = await screen.findByTestId('today-appointment');
    expect(card).toHaveTextContent('Return visit');
  });

  it('labels it on My visits too, and not on ordinary appointments', async () => {
    const ret = appt(2, { status: 'booked', scheduledAt: slot('23:30'), followUpTaskId: uuid(0x7a1) });
    const plain = appt(3, { status: 'booked', scheduledAt: slot('23:50') });
    renderAt('/patient/visits', ({ path }) => (path === '/appointments' ? { body: [ret, plain] } : undefined));
    const items = await screen.findAllByTestId('visit-line');
    expect(items[0]).toHaveTextContent('Return visit');
    expect(items[1]).not.toHaveTextContent('Return visit');
  });
});

describe('after cancelling (PR-19)', () => {
  it.each(['/patient', '/patient/visits'])('offers "Book a new time" on %s', async (path) => {
    let status = 'booked';
    renderAt(path, ({ method, path: p }) => {
      if (p === '/appointments') return { body: [appt(4, { status, scheduledAt: slot('23:30') })] };
      if (method === 'GET' && p === `/sessions/${uuid(0x5e1)}`) return { body: unavailableSession };
      if (method === 'POST' && p === `/appointments/${uuid(0xa94)}/cancel`) {
        status = 'cancelled';
        return { body: appt(4, { status, scheduledAt: slot('23:30'), version: 4 }) };
      }
      return undefined;
    });
    const user = userEvent.setup();
    await user.click((await screen.findAllByRole('button', { name: 'Cancel appointment' }))[0] as HTMLElement);
    await user.click(await screen.findByRole('button', { name: 'Cancel appointment' }));
    const notice = await screen.findByTestId('cancelled-notice');
    expect(notice).toHaveTextContent('Appointment cancelled');
    expect(within(notice).getByRole('link', { name: 'Book a new time' })).toHaveAttribute('href', '/patient/book');
  });
});
