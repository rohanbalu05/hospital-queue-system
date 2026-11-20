/* eslint-disable @typescript-eslint/no-non-null-assertion -- fixtures index arrays this file just built */
import { beforeAll, vi } from 'vitest';
import { render } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { AuthProvider } from '@/lib/auth';
import { istDate, addDays } from '@/lib/dates';
import { FakeEventSource } from '@/live/fakeEventSource';
import { AVAILABLE, staffSnapshot, uid } from '@/live/fixtures';
import ReceptionHome from './ReceptionHome';

/** Shared fixtures and a routed fetch stub for the reception desk tests (session 3). Not a test file itself. */

export function polyfillRadix() {
  beforeAll(() => {
    Element.prototype.hasPointerCapture = () => false;
    Element.prototype.setPointerCapture = () => undefined;
    Element.prototype.releasePointerCapture = () => undefined;
    Element.prototype.scrollIntoView = () => undefined;
  });
}

export const TODAY = istDate();
export const TOMORROW = addDays(TODAY, 1);
/** An instant at hh:mm IST on a hospital-local day. */
export const at = (hhmm: string, day: string = TODAY) => new Date(`${day}T${hhmm}:00+05:30`).toISOString();

export const DOC_RAO = { id: uid(0xd1), fullName: 'Dr. Meenakshi Rao', department: 'General Medicine', room: 'Room 12', active: true };
export const DOC_KULKARNI = { id: uid(0xd2), fullName: 'Dr. Shweta Kulkarni', department: 'General Medicine', room: 'Room 14', active: true };
export const DOC_SHETTY = { id: uid(0xd3), fullName: 'Dr. Ramesh Shetty', department: 'ENT', room: 'Room 3', active: true };

export const capacity = (over: Partial<{ bookedReserved: number; walkinUsed: number }> = {}) => {
  const bookedReserved = over.bookedReserved ?? 3;
  const walkinUsed = over.walkinUsed ?? 0;
  return { bookedCapacity: 10, walkinCapacity: 5, bookedReserved, walkinUsed, bookedAvailable: 10 - bookedReserved, walkinAvailable: 5 - walkinUsed };
};

export function makeSession(
  n: number,
  doctor: typeof DOC_RAO,
  over: { day?: string; start?: string; end?: string; label?: string; status?: string; cap?: ReturnType<typeof capacity> } = {},
) {
  const day = over.day ?? TODAY;
  return {
    id: uid(0x5e00 + n),
    doctorId: doctor.id,
    doctorName: doctor.fullName,
    department: doctor.department,
    room: doctor.room,
    sessionDate: day,
    label: over.label ?? 'morning',
    startsAt: at(over.start ?? '00:01', day),
    endsAt: at(over.end ?? '23:59', day),
    slotMinutes: 12,
    status: over.status ?? 'open',
    availability: AVAILABLE,
    policyVersion: 1,
    capacity: over.cap ?? capacity(),
    version: 1,
  };
}

export const patient = (n: number, fullName: string, phone: string | null, over: Record<string, unknown> = {}) => ({
  id: uid(0xa000 + n),
  mrn: `BLR-00${1000 + n}`,
  fullName,
  phone,
  dateOfBirth: null,
  hasLogin: false,
  createdAt: '2026-10-01T05:00:00.000Z',
  ...over,
});

export const HARISH = patient(1, 'Harish Gowda', '+919845012345', { dateOfBirth: '1978-03-14' });
export const LAKSHMI = patient(2, 'Lakshmi Narayanan', '+919880123456');

export function appointment(n: number, p: ReturnType<typeof patient>, s: ReturnType<typeof makeSession>, scheduledAt: string, over: Record<string, unknown> = {}) {
  return {
    id: uid(0xb00 + n),
    patientId: p.id,
    sessionId: s.id,
    doctorId: s.doctorId,
    doctorName: s.doctorName,
    department: s.department,
    scheduledAt,
    status: 'booked',
    rescheduledFromId: null,
    followUpTaskId: null,
    version: 2,
    createdAt: '2026-11-01T05:00:00.000Z',
    patientName: p.fullName,
    patientMrn: p.mrn,
    patientPhone: p.phone,
    ...over,
  };
}

export interface DeskWorld {
  sessions: ReturnType<typeof makeSession>[];
  doctors: Array<typeof DOC_RAO>;
  appointments: ReturnType<typeof appointment>[];
  patients: ReturnType<typeof patient>[];
  alternatives: unknown[];
  /** Answer POST /patients with this instead of creating the patient. */
  registerReply?: (body: Record<string, unknown>, calls: number) => { status: number; body: unknown };
  snapshotStatus?: string;
  /** Extra fields for the staff queue snapshot (waiting, skipped, active ...). */
  snapshot?: Record<string, unknown>;
  /** GET /appointments?patientId= answers 500 while this is true. */
  failPatientAppointments?: boolean;
}

export interface PostRecord {
  path: string;
  body: Record<string, unknown>;
  key: string | null;
}

/** Install the fetch stub and EventSource fake for a desk test. Returns the POSTs the app sent. */
export function installDesk(world: DeskWorld) {
  FakeEventSource.reset();
  vi.stubGlobal('EventSource', FakeEventSource);
  const posts: PostRecord[] = [];
  let registerCalls = 0;
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), 'http://localhost');
      const path = url.pathname.replace(/^\/api/, '');
      const method = init?.method ?? 'GET';
      const q = url.searchParams;
      const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : {};
      if (method === 'POST') posts.push({ path, body, key: new Headers(init?.headers).get('Idempotency-Key') });

      if (path === '/me') {
        return json({ userId: uid(2), email: 'reception@hqms.test', displayName: 'Deepa Nair', role: 'reception', patientId: null, doctorId: null, assignedDoctorIds: [DOC_RAO.id] });
      }
      if (path === '/doctors') return json(world.doctors);
      if (path === '/sessions' && method === 'GET') {
        return json(
          world.sessions.filter(
            (s) =>
              (!q.get('date') || s.sessionDate === q.get('date')) &&
              (!q.get('doctorId') || s.doctorId === q.get('doctorId')) &&
              (!q.get('department') || s.department === q.get('department')) &&
              (!q.get('from') || s.sessionDate >= q.get('from')!) &&
              (!q.get('to') || s.sessionDate <= q.get('to')!),
          ),
        );
      }
      let m = /^\/sessions\/([^/]+)\/queue$/.exec(path);
      if (m) {
        const s = world.sessions.find((x) => x.id === m![1]);
        return json(staffSnapshot({ sessionId: m[1]!, status: (world.snapshotStatus ?? s?.status ?? 'open') as 'open', ...(world.snapshot ?? {}) }));
      }
      m = /^\/sessions\/([^/]+)\/slots$/.exec(path);
      if (m) {
        const s = world.sessions.find((x) => x.id === m![1])!;
        return json({
          sessionId: s.id,
          slots: [
            { scheduledAt: at('10:00', s.sessionDate), available: false },
            { scheduledAt: at('10:12', s.sessionDate), available: true },
            { scheduledAt: at('10:24', s.sessionDate), available: true },
          ],
          capacity: s.capacity,
        });
      }
      m = /^\/sessions\/([^/]+)\/alternatives$/.exec(path);
      if (m) return json(world.alternatives);
      if (path === '/appointments' && method === 'GET') {
        if (world.failPatientAppointments && q.get('patientId')) return json({ error: { code: 'INTERNAL', message: 'Database is busy.' } }, 500);
        return json(
          world.appointments.filter((a) => (!q.get('sessionId') || a.sessionId === q.get('sessionId')) && (!q.get('patientId') || a.patientId === q.get('patientId'))),
        );
      }
      if (path === '/patients' && method === 'GET') {
        const term = (q.get('q') ?? '').toLowerCase();
        return json(world.patients.filter((p) => `${p.fullName} ${p.mrn} ${p.phone ?? ''}`.toLowerCase().includes(term)));
      }
      if (path === '/patients' && method === 'POST') {
        registerCalls += 1;
        if (world.registerReply) {
          const r = world.registerReply(body, registerCalls);
          return json(r.body, r.status);
        }
        return json(patient(90, String(body.fullName), (body.phone as string | null) ?? null), 201);
      }
      if (method === 'POST' && /^\/sessions\/[^/]+\/walk-ins$/.test(path)) {
        return json({ visitId: uid(0xc1), queueEntryId: uid(0xc2), token: 'W-004', group: 'W', kind: 'walkin', eligibleAt: at('10:00'), queueVersion: 8 });
      }
      if (method === 'POST' && path === '/appointments') {
        const s = world.sessions.find((x) => x.id === body.sessionId)!;
        return json(appointment(50, HARISH, s, at('10:12', s.sessionDate), { patientId: body.patientId }), 201);
      }
      m = /^\/appointments\/([^/]+)\/(cancel|reschedule)$/.exec(path);
      if (method === 'POST' && m) {
        const a = world.appointments.find((x) => x.id === m![1])!;
        return json({ ...a, status: m[2] === 'cancel' ? 'cancelled' : 'rescheduled', version: a.version + 1 });
      }
      if (method === 'POST' && /^\/queue-entries\/[^/]+\/(absent|re-enter)$/.test(path)) return json({});
      return json({ error: { code: 'NOT_FOUND', message: 'Not mocked.' } }, 404);
    }),
  );
  return { posts };
}

export function renderDesk() {
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
