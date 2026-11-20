import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes } from 'react-router-dom';
import { RequireRole } from '@/components/layout/Guards';
import { Providers, patientUser, stubApi, testQueryClient, uuid, type Handler } from '@/lib/testing';
import { bookLabel } from './RebookPanel';
import VisitsPage from './VisitsPage';

afterEach(() => vi.unstubAllGlobals());
beforeAll(() => {
  Element.prototype.scrollIntoView = () => undefined;
  Element.prototype.hasPointerCapture = () => false;
  Element.prototype.setPointerCapture = () => undefined;
  Element.prototype.releasePointerCapture = () => undefined;
});

const me = patientUser(1, 'Ananya Iyer');
const APPT = uuid(0xa91);
const today = new Date().toISOString().slice(0, 10);
const slot = (hhmm: string) => `${today}T${hhmm}:00+05:30`;

const appointment = (over: Record<string, unknown> = {}) => ({
  id: APPT,
  patientId: me.patientId,
  sessionId: uuid(0x5e1),
  doctorId: uuid(0xd2),
  doctorName: 'Dr. Arvind Kulkarni',
  department: 'Paediatrics',
  scheduledAt: slot('11:00'),
  status: 'booked',
  rescheduledFromId: null,
  followUpTaskId: null,
  version: 3,
  createdAt: slot('08:00'),
  ...over,
});

const option = (n: number, doctor: string, hhmm: string | null, left: number) => ({
  sessionId: uuid(0x6e0 + n),
  doctorId: uuid(0xe0 + n),
  doctorName: doctor,
  department: 'Paediatrics',
  room: `${n + 3}`,
  sessionDate: today,
  label: 'morning',
  startsAt: slot('09:00'),
  endsAt: slot('13:00'),
  status: 'open',
  nextSlotAt: hhmm ? slot(hhmm) : null,
  bookedAvailable: left,
  walkinAvailable: 2,
});

const unavailable = { state: 'unavailable', since: new Date().toISOString(), expectedBackAt: null, overdue: false, reason: null };

function server(options: unknown[], extra?: Handler) {
  const seen = { reschedule: [] as Array<{ body: unknown; key: string | null }>, cancel: 0 };
  const handler: Handler = ({ method, path, body, headers }) => {
    if (path === '/me') return { body: me };
    if (method === 'GET' && path === '/appointments') return { body: [appointment()] };
    if (method === 'GET' && path === `/appointments/${APPT}/alternatives`) return { body: { appointmentId: APPT, sourceAvailability: unavailable, alternatives: options } };
    if (method === 'POST' && path === `/appointments/${APPT}/reschedule`) {
      seen.reschedule.push({ body, key: headers.get('Idempotency-Key') });
      const target = options.find((o) => (o as { sessionId: string }).sessionId === (body as { targetSessionId: string }).targetSessionId) as ReturnType<typeof option>;
      return { body: appointment({ id: uuid(0xa92), doctorName: target.doctorName, scheduledAt: target.nextSlotAt, version: 1, rescheduledFromId: APPT }) };
    }
    if (method === 'POST' && path === `/appointments/${APPT}/cancel`) {
      seen.cancel += 1;
      return { body: appointment({ status: 'cancelled', version: 4 }) };
    }
    return extra?.({ method, path, body, headers, search: new URLSearchParams() });
  };
  return { seen, handler };
}

function renderRebook() {
  render(
    <Providers qc={testQueryClient()} initial={[`/patient/visits?rebook=${APPT}`]}>
      <Routes>
        <Route element={<RequireRole roles={['patient']} />}>
          <Route path="/patient/visits" element={<VisitsPage />} />
        </Route>
      </Routes>
    </Providers>,
  );
}

describe('rebook flow', () => {
  it('labels the primary button with the slot time and doctor', () => {
    expect(bookLabel({ nextSlotAt: slot('11:20'), doctorName: 'Dr. Farah Siddiqui' })).toBe('Book 11:20 am with Dr. Farah Siddiqui');
  });

  it('lists the options and books one with a single click: expectedVersion and an Idempotency-Key are sent', async () => {
    const { seen, handler } = server([option(1, 'Dr. Farah Siddiqui', '11:20', 4), option(2, 'Dr. Pooja Bhat', '11:40', 1)]);
    stubApi(handler);
    renderRebook();
    expect(await screen.findByRole('heading', { name: 'Rebook with another doctor' })).toBeInTheDocument();
    const rows = await screen.findAllByTestId('rebook-option');
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent('Dr. Farah Siddiqui');
    expect(rows[0]).toHaveTextContent('Room 4');
    expect(rows[0]).toHaveTextContent('4 places left');
    expect(rows[1]).toHaveTextContent('1 place left');
    expect(screen.getByText(/Dr. Arvind Kulkarni is not available for the rest of this session/)).toBeInTheDocument();

    await userEvent.setup().click(within(rows[0] as HTMLElement).getByRole('button', { name: 'Book 11:20 am with Dr. Farah Siddiqui' }));
    const done = await screen.findByTestId('rebook-done');
    expect(done).toHaveTextContent('11:20 am');
    expect(done).toHaveTextContent('Dr. Farah Siddiqui');
    expect(seen.reschedule).toHaveLength(1);
    expect(seen.reschedule[0]?.body).toEqual({ targetSessionId: uuid(0x6e1), expectedVersion: 3 });
    expect(seen.reschedule[0]?.key).toMatch(/.{8,}/);
  });

  it('books by keyboard alone', async () => {
    const { seen, handler } = server([option(1, 'Dr. Farah Siddiqui', '11:20', 4)]);
    stubApi(handler);
    renderRebook();
    const button = await screen.findByRole('button', { name: 'Book 11:20 am with Dr. Farah Siddiqui' });
    button.focus();
    await userEvent.setup().keyboard('{Enter}');
    await screen.findByTestId('rebook-done');
    expect(seen.reschedule).toHaveLength(1);
  });

  it('shows at most six options', async () => {
    const six = Array.from({ length: 8 }, (_, i) => option(i + 1, `Dr. Option ${i + 1}`, '11:20', 2));
    stubApi(server(six).handler);
    renderRebook();
    expect(await screen.findAllByTestId('rebook-option')).toHaveLength(6);
  });

  it('says plainly when the slot was just taken and refreshes the list', async () => {
    let alternativesFetches = 0;
    const { handler } = server([option(1, 'Dr. Farah Siddiqui', '11:20', 1)]);
    stubApi(({ method, path, ...rest }) => {
      if (method === 'POST' && path === `/appointments/${APPT}/reschedule`) return { status: 409, body: { error: { code: 'CAPACITY_FULL', message: 'That session has no places left.' } } };
      if (path === `/appointments/${APPT}/alternatives`) alternativesFetches += 1;
      return handler({ method, path, ...rest });
    });
    renderRebook();
    await userEvent.setup().click(await screen.findByRole('button', { name: 'Book 11:20 am with Dr. Farah Siddiqui' }));
    expect(await screen.findByText('That slot was just taken')).toBeInTheDocument();
    expect(screen.getByText(/Your original appointment is unchanged/)).toBeInTheDocument();
    await waitFor(() => expect(alternativesFetches).toBeGreaterThanOrEqual(2));
    expect(screen.queryByTestId('rebook-done')).not.toBeInTheDocument();
  });

  it('with no options says so and offers cancel and the front desk number', async () => {
    stubApi(server([]).handler);
    renderRebook();
    const empty = await screen.findByTestId('rebook-empty');
    expect(empty).toHaveTextContent('No other doctor has a free slot in the next 7 days');
    expect(empty).toHaveTextContent('call the hospital front desk');
    expect(within(screen.getByTestId('rebook-panel')).getByRole('button', { name: 'Cancel appointment' })).toBeInTheDocument();
  });

  it('cancels after a confirmation', async () => {
    const { seen, handler } = server([]);
    stubApi(handler);
    renderRebook();
    const user = userEvent.setup();
    await user.click(await within(await screen.findByTestId('rebook-panel')).findByRole('button', { name: 'Cancel appointment' }));
    const dialog = await screen.findByRole('dialog', { name: 'Cancel this appointment?' });
    expect(seen.cancel).toBe(0);
    await user.click(within(dialog).getByRole('button', { name: 'Cancel appointment' }));
    expect(await screen.findByRole('heading', { name: 'Appointment cancelled' })).toBeInTheDocument();
    expect(seen.cancel).toBe(1);
  });

  it('tells the patient when the appointment cannot be rebooked any more', async () => {
    stubApi(({ method, path }) => (method === 'GET' && path === '/appointments' ? { body: [appointment({ status: 'completed' })] } : undefined), server([]).handler);
    renderRebook();
    expect(await screen.findByText('This appointment can no longer be rebooked here.')).toBeInTheDocument();
  });
});
