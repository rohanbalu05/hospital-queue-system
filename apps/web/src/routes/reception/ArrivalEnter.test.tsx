/* eslint-disable @typescript-eslint/no-non-null-assertion -- fixtures index arrays this file just built */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { AuthProvider } from '@/lib/auth';
import { FakeEventSource } from '@/live/fakeEventSource';
import { AVAILABLE, SESSION_ID, DOCTOR_ID, staffSnapshot, uid } from '@/live/fixtures';
import ReceptionHome from './ReceptionHome';

/**
 * B4 defect 8: typing in the arrival search and pressing Enter quickly checked in a row that did not match
 * the current query, because the list on screen still belonged to the previous (debounced) query.
 */

beforeAll(() => {
  Element.prototype.hasPointerCapture = () => false;
  Element.prototype.setPointerCapture = () => undefined;
  Element.prototype.releasePointerCapture = () => undefined;
  Element.prototype.scrollIntoView = () => undefined;
});

const iso = (hhmm: string) => new Date(`${new Date().toISOString().slice(0, 10)}T${hhmm}:00+05:30`).toISOString();

const patients = [
  { id: uid(0xa1), mrn: 'MRN-100231', fullName: 'Harish Gowda', phone: '+919845012345' },
  { id: uid(0xa2), mrn: 'MRN-100232', fullName: 'Lakshmi Narayanan', phone: '+919880123456' },
  { id: uid(0xa3), mrn: 'MRN-100233', fullName: 'Ananya Iyer', phone: '+919900112233' },
].map((p) => ({ ...p, dateOfBirth: null, hasLogin: true, createdAt: '2026-10-01T05:00:00.000Z' }));

const appointment = (n: number, patientIndex: number, at: string) => ({
  id: uid(0xb00 + n),
  patientId: patients[patientIndex]!.id,
  sessionId: SESSION_ID,
  doctorId: DOCTOR_ID,
  doctorName: 'Dr. Meenakshi Rao',
  department: 'General Medicine',
  scheduledAt: iso(at),
  status: 'booked',
  rescheduledFromId: null,
  followUpTaskId: null,
  version: 1,
  createdAt: '2026-11-01T05:00:00.000Z',
  patientName: patients[patientIndex]!.fullName,
  patientMrn: patients[patientIndex]!.mrn,
  patientPhone: patients[patientIndex]!.phone,
});

describe('reception arrival search: Enter only acts on results for the current query', () => {
  let checkedIn: string[] = [];
  let searchDelayMs = 0;

  beforeEach(() => {
    checkedIn = [];
    searchDelayMs = 400;
    FakeEventSource.reset();
    vi.stubGlobal('EventSource', FakeEventSource);
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(String(input), 'http://localhost');
        const path = url.pathname.replace(/^\/api/, '');
        const method = init?.method ?? 'GET';
        if (path === '/me') {
          return json({ userId: uid(2), email: 'reception@hqms.test', displayName: 'Deepa Nair', role: 'reception', patientId: null, doctorId: null, assignedDoctorIds: [DOCTOR_ID] });
        }
        if (path === '/doctors') return json([{ id: DOCTOR_ID, fullName: 'Dr. Meenakshi Rao', department: 'General Medicine', room: 'Room 12', active: true }]);
        if (path === '/sessions') {
          return json([
            {
              id: SESSION_ID,
              doctorId: DOCTOR_ID,
              doctorName: 'Dr. Meenakshi Rao',
              department: 'General Medicine',
              room: 'Room 12',
              sessionDate: iso('10:00').slice(0, 10),
              label: 'morning',
              startsAt: iso('09:00'),
              endsAt: iso('13:00'),
              slotMinutes: 12,
              status: 'open',
              availability: AVAILABLE,
              policyVersion: 1,
              capacity: { bookedCapacity: 10, walkinCapacity: 5, bookedReserved: 3, walkinUsed: 0, bookedAvailable: 7, walkinAvailable: 5 },
              version: 1,
            },
          ]);
        }
        if (path === '/appointments') return json([appointment(1, 0, '10:00'), appointment(2, 1, '10:12'), appointment(3, 2, '10:24')]);
        if (path === '/patients') {
          const q = (url.searchParams.get('q') ?? '').toLowerCase();
          await new Promise((r) => setTimeout(r, searchDelayMs));
          return json(patients.filter((p) => p.fullName.toLowerCase().includes(q)));
        }
        if (path === `/sessions/${SESSION_ID}/queue`) return json(staffSnapshot());
        const check = /^\/appointments\/([^/]+)\/check-in$/.exec(path);
        if (method === 'POST' && check) {
          checkedIn.push(check[1]!);
          return json({ visitId: uid(0xc1), queueEntryId: uid(0xc2), token: 'A-017', group: 'A', kind: 'appointment', eligibleAt: iso('10:00'), queueVersion: 8 });
        }
        return json({ error: { code: 'NOT_FOUND', message: 'Not mocked.' } }, 404);
      }),
    );
  });
  afterEach(() => vi.unstubAllGlobals());

  function renderDesk() {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    return render(
      <QueryClientProvider client={client}>
        <MemoryRouter>
          <AuthProvider>
            <ReceptionHome />
          </AuthProvider>
        </MemoryRouter>
      </QueryClientProvider>,
    );
  }

  it('does not check in the first row of the old list when Enter is pressed before the new results arrive', async () => {
    const user = userEvent.setup();
    renderDesk();
    const search = await screen.findByRole('combobox', { name: 'Find an arrival' });
    // The empty-query list is on screen: Harish Gowda (10:00) is first and active.
    await screen.findByRole('option', { name: /Harish Gowda/ });

    await user.type(search, 'Ananya{Enter}');
    // Results for "Ananya" (and the debounce) are still pending: nothing may be checked in.
    expect(checkedIn).toEqual([]);

    // Once the results for "Ananya" are in, Enter checks in the row that matches it.
    await waitFor(() => expect(screen.getByRole('button', { name: /^Check in/ })).toBeEnabled(), { timeout: 3000 });
    expect(screen.queryByRole('option', { name: /Harish Gowda/ })).toBeNull();
    await user.keyboard('{Enter}');
    await waitFor(() => expect(checkedIn).toEqual([uid(0xb00 + 3)]), { timeout: 3000 });
  });

  it('keeps Check in disabled while the list on screen is for an older query', async () => {
    const user = userEvent.setup();
    renderDesk();
    const search = await screen.findByRole('combobox', { name: 'Find an arrival' });
    await screen.findByRole('option', { name: /Harish Gowda/ });
    await user.type(search, 'Ana');
    expect(screen.getByRole('button', { name: /^Check in/ })).toBeDisabled();
    await waitFor(() => expect(screen.getByRole('button', { name: /^Check in/ })).toBeEnabled(), { timeout: 3000 });
  });
});
