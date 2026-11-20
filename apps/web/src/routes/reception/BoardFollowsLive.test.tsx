import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import type { StaffQueueSnapshot } from '@hqms/contracts';
import { AuthProvider } from '@/lib/auth';
import { FakeEventSource } from '@/live/fakeEventSource';
import { AVAILABLE, DOCTOR_ID, SESSION_ID, awayAvailability, staffSnapshot, uid } from '@/live/fixtures';
import ReceptionHome from './ReceptionHome';

/**
 * PR-24: after the doctor went unavailable, an already-open reception board kept the header chip "Open" and an enabled
 * "Check in" until a reload, because both came from the session list (polled) instead of the live snapshot.
 */

beforeAll(() => {
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  Element.prototype.hasPointerCapture = () => false;
  Element.prototype.setPointerCapture = () => undefined;
  Element.prototype.releasePointerCapture = () => undefined;
  Element.prototype.scrollIntoView = () => undefined;
});

const AFTERNOON_ID = uid(0x5e52);
const today = new Date().toISOString().slice(0, 10);
const at = (hhmm: string) => new Date(`${today}T${hhmm}:00+05:30`).toISOString();

describe('reception board follows the live session state', () => {
  let live: Partial<StaffQueueSnapshot> = {};

  beforeEach(() => {
    live = {};
    FakeEventSource.reset();
    vi.stubGlobal('EventSource', FakeEventSource);
    const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const path = new URL(String(input), 'http://localhost').pathname.replace(/^\/api/, '');
        if (path === '/me') return json({ userId: uid(2), email: 'reception@hqms.test', displayName: 'Deepa Nair', role: 'reception', patientId: null, doctorId: null, assignedDoctorIds: [DOCTOR_ID] });
        if (path === '/doctors') return json([{ id: DOCTOR_ID, fullName: 'Dr. Meenakshi Rao', department: 'General Medicine', room: 'Room 12', active: true }]);
        if (path === '/sessions') {
          // The session list is polled and still says open: the board must not trust it over the live snapshot.
          return json([
            { id: AFTERNOON_ID, doctorId: DOCTOR_ID, doctorName: 'Dr. Meenakshi Rao', department: 'General Medicine', room: 'Room 12', sessionDate: today, label: 'afternoon', startsAt: at('14:00'), endsAt: at('17:00'), slotMinutes: 12, status: 'scheduled', policyVersion: 1, capacity: { bookedCapacity: 10, walkinCapacity: 5, bookedReserved: 0, walkinUsed: 0, bookedAvailable: 10, walkinAvailable: 5 }, version: 1 },
            { id: SESSION_ID, doctorId: DOCTOR_ID, doctorName: 'Dr. Meenakshi Rao', department: 'General Medicine', room: 'Room 12', sessionDate: today, label: 'morning', startsAt: at('09:00'), endsAt: at('13:00'), slotMinutes: 12, status: 'open', policyVersion: 1, capacity: { bookedCapacity: 10, walkinCapacity: 5, bookedReserved: 3, walkinUsed: 0, bookedAvailable: 7, walkinAvailable: 5 }, version: 1 },
          ]);
        }
        if (path === '/appointments') {
          return json([
            { id: uid(0xb01), patientId: uid(0xa1), sessionId: SESSION_ID, doctorId: DOCTOR_ID, doctorName: 'Dr. Meenakshi Rao', department: 'General Medicine', scheduledAt: at('10:00'), status: 'booked', rescheduledFromId: null, followUpTaskId: null, version: 1, createdAt: '2026-11-01T05:00:00.000Z', patientName: 'Harish Gowda', patientMrn: 'MRN-100231', patientPhone: '+919845012345' },
          ]);
        }
        if (path === '/patients') return json([]);
        if (path === `/sessions/${SESSION_ID}/queue`) return json(staffSnapshot(live));
        if (path === `/sessions/${SESSION_ID}/affected`) return json({ sessionId: SESSION_ID, doctorName: 'Dr. Meenakshi Rao', department: 'General Medicine', availability: AVAILABLE, notArrived: [], inQueue: [], alternatives: [] });
        return json({ error: { code: 'NOT_FOUND', message: 'Not mocked.' } }, 404);
      }),
    );
  });
  afterEach(() => vi.unstubAllGlobals());

  const renderDesk = (url = '/reception') =>
    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })}>
        <MemoryRouter initialEntries={[url]}>
          <AuthProvider>
            <ReceptionHome />
          </AuthProvider>
        </MemoryRouter>
      </QueryClientProvider>,
    );

  const notice = (queueVersion: number) => ({ sessionId: SESSION_ID, queueVersion, eventType: 'queue.changed', committedAt: at('10:31') });

  it('shows Doctor unavailable and disables Check in, pointing to Affected patients, without a reload', async () => {
    renderDesk();
    const checkIn = await screen.findByRole('button', { name: /^Check in/ });
    await waitFor(() => expect(checkIn).toBeEnabled());
    expect(screen.getAllByText('Open').length).toBeGreaterThan(0);
    act(() => FakeEventSource.last.open());

    live = { status: 'unavailable', queueVersion: 8, availability: { state: 'unavailable', since: at('10:30'), expectedBackAt: null, overdue: false, reason: 'Called to emergency theatre' } };
    act(() => FakeEventSource.last.emit('queue', notice(8)));

    await waitFor(() => expect(screen.getAllByText('Doctor unavailable').length).toBeGreaterThan(0));
    expect(screen.queryByText('Open')).toBeNull();
    expect(screen.getByRole('button', { name: /^Check in/ })).toBeDisabled();
    expect(screen.getByText(/unavailable for the rest of this session.*Affected patients/s)).toBeVisible();
  });

  it('shows Doctor away in the header chip when the doctor steps away', async () => {
    renderDesk();
    await screen.findByRole('button', { name: /^Check in/ });
    act(() => FakeEventSource.last.open());
    live = { status: 'paused', queueVersion: 8, availability: awayAvailability() };
    act(() => FakeEventSource.last.emit('queue', notice(8)));
    await waitFor(() => expect(screen.getAllByText('Doctor away').length).toBeGreaterThan(0));
    expect(screen.queryByText('Open')).toBeNull();
  });

  it('opens the session named in a notification link (?session=) instead of the default one', async () => {
    renderDesk(`/reception?session=${AFTERNOON_ID}`);
    const afternoon = await screen.findByRole('tab', { name: /Afternoon/ });
    await waitFor(() => expect(afternoon).toHaveAttribute('aria-selected', 'true'));
  });

  it('keeps the default session when the linked session is not one the desk can see', async () => {
    renderDesk(`/reception?session=${uid(0x9999)}`);
    const morning = await screen.findByRole('tab', { name: /Morning/ });
    await waitFor(() => expect(morning).toHaveAttribute('aria-selected', 'true'));
  });
});
