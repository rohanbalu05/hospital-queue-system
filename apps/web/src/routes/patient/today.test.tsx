import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Route, Routes } from 'react-router-dom';
import { RequireRole } from '@/components/layout/Guards';
import { Providers, availableNow, patientUser, stubApi, testQueryClient, uuid } from '@/lib/testing';
import TodayPage from './TodayPage';

afterEach(() => vi.unstubAllGlobals());
beforeAll(() => {
  Element.prototype.scrollIntoView = () => undefined;
});

const me = patientUser(1, 'Ananya Iyer');
const SESSION = uuid(0x5e1);

const walkIn = {
  visitId: uuid(0x71),
  sessionId: SESSION,
  appointmentId: null,
  doctorName: 'Dr. Arvind Kulkarni',
  department: 'Paediatrics',
  room: '4',
  kind: 'walkin',
  visitStatus: 'open',
  token: 'W-005',
  queueState: 'waiting',
  checkedInAt: new Date().toISOString(),
  scheduledAt: null,
  availability: availableNow,
};

function renderToday() {
  const qc = testQueryClient();
  render(
    <Providers qc={qc} initial={['/patient']}>
      <Routes>
        <Route element={<RequireRole roles={['patient']} />}>
          <Route path="/patient" element={<TodayPage />} />
        </Route>
      </Routes>
    </Providers>,
  );
}

describe('Today page for a walk-in patient (B4 defect)', () => {
  it("shows today's visit from /me/visits/today when there is no appointment", async () => {
    stubApi(
      ({ path }) => (path === '/me' ? { body: me } : undefined),
      ({ path }) => (path === '/appointments' ? { body: [] } : undefined),
      ({ path }) => (path === '/me/visits/today' ? { body: [walkIn] } : undefined),
    );
    renderToday();
    const card = await screen.findByTestId('today-visit');
    expect(card).toHaveTextContent('W-005');
    expect(card).toHaveTextContent('Dr. Arvind Kulkarni');
    expect(card).toHaveTextContent('Room 4');
    expect(card).toHaveTextContent('In the queue');
    expect(screen.getByRole('link', { name: 'See my place in the queue' })).toHaveAttribute('href', `/patient/visit/${SESSION}`);
    expect(screen.queryByText('No visit today')).not.toBeInTheDocument();
  });

  it('does not show a second card for a visit that belongs to an appointment already listed', async () => {
    const at = new Date().toISOString();
    const appt = {
      id: uuid(0xa91),
      patientId: me.patientId,
      sessionId: SESSION,
      doctorId: uuid(0xd2),
      doctorName: 'Dr. Arvind Kulkarni',
      department: 'Paediatrics',
      scheduledAt: at,
      status: 'checked_in',
      rescheduledFromId: null,
      followUpTaskId: null,
      version: 2,
      createdAt: at,
    };
    stubApi(
      ({ path }) => (path === '/me' ? { body: me } : undefined),
      ({ path }) => (path === '/appointments' ? { body: [appt] } : undefined),
      ({ path }) => (path === '/me/visits/today' ? { body: [{ ...walkIn, kind: 'appointment', appointmentId: appt.id, token: 'A-014' }] } : undefined),
    );
    renderToday();
    await screen.findByTestId('today-appointment');
    expect(screen.getAllByRole('link', { name: 'See my place in the queue' })).toHaveLength(1);
    expect(screen.queryByTestId('today-visit')).not.toBeInTheDocument();
  });

  it('still shows the empty state when there is neither an appointment nor a visit', async () => {
    stubApi(
      ({ path }) => (path === '/me' ? { body: me } : undefined),
      ({ path }) => (path === '/appointments' ? { body: [] } : undefined),
      ({ path }) => (path === '/me/visits/today' ? { body: [] } : undefined),
    );
    renderToday();
    expect(await screen.findByText('No visit today')).toBeInTheDocument();
  });
});
