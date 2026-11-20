/* eslint-disable @typescript-eslint/no-non-null-assertion -- fixtures look up ids this file created */
import type { Page, Route } from '@playwright/test';
import { DOCTORS, NOW, TODAY, type SchedulingMock } from './scheduling-mocks';

/**
 * Admin additions (D-038, PR-02/30/40/41/42): session create/open/close/reopen with overlap refusal, availability on
 * session reads, the staff lifecycle with one-time temporary passwords, and GET /admin/system. Register it AFTER
 * setupW3(): later routes win and anything not handled here falls back to the earlier mocks.
 * All names, counts and times are fixtures for screenshots, not measurements.
 */

const uuid = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const ADMIN_ID = uuid(1);
export const TEMP_PASSWORD = 'Marigold-7281-Tiger';

type Json = Record<string, unknown>;

export interface StaffRow extends Json {
  userId: string;
  displayName: string;
  email: string;
  role: 'reception' | 'doctor' | 'followup' | 'admin';
  doctorIds: string[];
  active: boolean;
  doctorId: string | null;
}

export interface AdminMock {
  staff: StaffRow[];
  /** Worker and backlog numbers served by GET /admin/system. */
  system: Json;
  requests: Array<{ line: string; key: string | null; body: unknown }>;
  /** Pause until these instants (away sessions), by session id. */
  awayUntil: Map<string, string>;
  /** Fail the next GET /admin/system with a 503. */
  failSystem: boolean;
}

export const SYSTEM_FINE = {
  checkedAt: NOW.toISOString(),
  worker: {
    status: 'up',
    lastSeenAt: '2026-11-11T10:04:41+05:30',
    instances: [{ workerId: 'worker-1', jobTypes: ['ocr', 'notify', 'timers'], dispatchOutbox: true, startedAt: '2026-11-11T08:00:00+05:30', lastSeenAt: '2026-11-11T10:04:41+05:30', up: true }],
  },
  jobs: { overdue: 0, oldestOverdueSeconds: null, running: 0, deadLast24h: 0, byType: [] },
  outbox: { undispatched: 0, oldestSeconds: null },
  notifications: { queued: 0, failedLast24h: 0 },
};

export const SYSTEM_DOWN = {
  ...SYSTEM_FINE,
  worker: { status: 'down', lastSeenAt: '2026-11-11T09:12:30+05:30', instances: [] },
  jobs: { overdue: 14, oldestOverdueSeconds: 3150, running: 0, deadLast24h: 2, byType: [{ jobType: 'ocr', overdue: 6, dead24h: 2 }] },
  outbox: { undispatched: 9, oldestSeconds: 3010 },
  notifications: { queued: 11, failedLast24h: 3 },
};

const D = DOCTORS;

function buildStaff(): StaffRow[] {
  return [
    { userId: ADMIN_ID, displayName: 'Vikram Shetty', email: 'admin@hqms.test', role: 'admin', doctorIds: [], active: true, doctorId: null },
    { userId: uuid(2), displayName: 'Deepa Nair', email: 'deepa.nair@hospital.example', role: 'reception', doctorIds: [D[0]!.id, D[1]!.id], active: true, doctorId: null },
    { userId: uuid(0x45), displayName: 'Lata Menon', email: 'lata.menon@hospital.example', role: 'reception', doctorIds: [D[3]!.id, D[4]!.id], active: true, doctorId: null },
    { userId: uuid(3), displayName: 'Dr. Meenakshi Rao', email: 'meenakshi.rao@hospital.example', role: 'doctor', doctorIds: [], active: true, doctorId: D[0]!.id },
    { userId: uuid(4), displayName: 'Sunita Hegde', email: 'sunita.hegde@hospital.example', role: 'followup', doctorIds: [D[0]!.id, D[2]!.id, D[3]!.id], active: true, doctorId: null },
    { userId: uuid(0x44), displayName: 'Rakesh Pai', email: 'rakesh.pai@hospital.example', role: 'followup', doctorIds: [D[0]!.id], active: false, doctorId: null },
  ];
}

const minutes = (iso: string) => new Date(iso).getTime();

export async function applyW6Admin(page: Page, sched: SchedulingMock): Promise<AdminMock> {
  const m: AdminMock = { staff: buildStaff(), system: structuredClone(SYSTEM_FINE), requests: [], awayUntil: new Map(), failSystem: false };

  // Today's board: one doctor stepped away, one marked unavailable, one session not started.
  const today = (doctorIdx: number, label: string) => sched.sessions.find((s) => s.doctorId === D[doctorIdx]!.id && s.sessionDate === TODAY && s.label === label)!;
  const away = today(2, 'morning');
  away.status = 'paused';
  m.awayUntil.set(away.id, '2026-11-11T10:35:00+05:30');
  today(1, 'morning').status = 'unavailable';
  today(3, 'morning').status = 'open';
  let seq = 0;
  // A private copy: creating a doctor must not leak into other tests through the shared fixture array.
  const doctors = [...D];

  const json = (route: Route, status: number, body: unknown) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
  const error = (route: Route, status: number, code: string, message: string, details?: unknown) =>
    json(route, status, { error: { code, message, ...(details !== undefined ? { details } : {}) } });

  const availability = (s: (typeof sched.sessions)[number]) => {
    const ended = minutes(s.endsAt) <= NOW.getTime();
    const base = { since: null, expectedBackAt: null, overdue: false, reason: null };
    if (s.status === 'closed') return { state: 'ended', ...base };
    if (s.status === 'unavailable') return { state: 'unavailable', ...base, since: '2026-11-11T09:20:00+05:30', reason: 'Called away for an emergency in the ward' };
    if (s.status === 'paused') return { state: 'away', ...base, since: '2026-11-11T10:00:00+05:30', expectedBackAt: m.awayUntil.get(s.id) ?? null };
    if (s.status === 'open') return { state: ended ? 'ended' : 'available', ...base };
    return { state: ended ? 'ended' : 'not_started', ...base };
  };
  const view = (s: (typeof sched.sessions)[number]) => {
    const { baseBooked, bookedCapacity, walkinCapacity, walkinUsed, ...rest } = s;
    const reserved = Math.min(bookedCapacity, baseBooked);
    return {
      ...rest,
      availability: availability(s),
      capacity: { bookedCapacity, walkinCapacity, bookedReserved: reserved, walkinUsed, bookedAvailable: bookedCapacity - reserved, walkinAvailable: walkinCapacity - walkinUsed },
    };
  };

  await page.route(
    (url) => url.pathname.startsWith('/api/'),
    async (route) => {
      const req = route.request();
      const url = new URL(req.url());
      const path = url.pathname.replace(/^\/api/, '');
      const method = req.method();
      const q = url.searchParams;
      const key = req.headers()['idempotency-key'] ?? null;
      const isJson = (req.headers()['content-type'] ?? '').includes('json');
      const body = method !== 'GET' && isJson ? (req.postDataJSON?.() ?? null) : null;
      const note = () => m.requests.push({ line: `${method} ${path}`, key, body });

      if (method === 'GET' && path === '/doctors') return json(route, 200, doctors);

      // ---- sessions -------------------------------------------------------------------------------------
      if (method === 'GET' && path === '/sessions') {
        let list = sched.sessions;
        if (q.get('date')) list = list.filter((s) => s.sessionDate === q.get('date'));
        if (q.get('from')) list = list.filter((s) => s.sessionDate >= q.get('from')!);
        if (q.get('to')) list = list.filter((s) => s.sessionDate <= q.get('to')!);
        if (q.get('doctorId')) list = list.filter((s) => s.doctorId === q.get('doctorId'));
        return json(route, 200, list.map(view));
      }
      if (method === 'POST' && path === '/sessions') {
        note();
        const b = body as { doctorId: string; sessionDate: string; label: 'morning' | 'afternoon'; startsAt: string; endsAt: string; bookedCapacity?: number; walkinCapacity?: number };
        const doc = doctors.find((d) => d.id === b.doctorId);
        if (!doc) return error(route, 404, 'NOT_FOUND', 'Doctor not found.');
        const clash = sched.sessions.find(
          (s) => s.doctorId === b.doctorId && s.status !== 'closed' && minutes(s.startsAt) < minutes(b.endsAt) && minutes(b.startsAt) < minutes(s.endsAt),
        );
        if (clash) {
          return error(route, 409, 'CONFLICT', 'This doctor already has a session at that time.', {
            reason: 'SESSION_OVERLAP',
            overlappingSessionId: clash.id,
            startsAt: clash.startsAt,
            endsAt: clash.endsAt,
          });
        }
        const row = {
          id: uuid(0x30000 + seq++),
          doctorId: doc.id,
          doctorName: doc.fullName,
          department: doc.department,
          room: doc.room,
          sessionDate: b.sessionDate,
          label: b.label,
          startsAt: b.startsAt,
          endsAt: b.endsAt,
          slotMinutes: 20,
          status: 'scheduled' as const,
          policyVersion: 1,
          version: 1,
          baseBooked: 0,
          bookedCapacity: b.bookedCapacity ?? 10,
          walkinCapacity: b.walkinCapacity ?? 5,
          walkinUsed: 0,
        };
        sched.sessions.push(row as never);
        return json(route, 201, view(row as never));
      }
      const cmd = path.match(/^\/sessions\/([^/]+)\/(open|close|reopen)$/);
      if (method === 'POST' && cmd) {
        note();
        const s = sched.sessions.find((x) => x.id === cmd[1]);
        if (!s) return error(route, 404, 'NOT_FOUND', 'Session not found.');
        if (cmd[2] === 'open') s.status = 'open';
        if (cmd[2] === 'close') s.status = 'closed';
        if (cmd[2] === 'reopen') {
          if (s.status !== 'unavailable') return error(route, 409, 'INVALID_TRANSITION', 'Only an unavailable session can be reopened.');
          s.status = 'open';
        }
        s.version += 1;
        return json(route, 200, view(s));
      }

      // ---- system ---------------------------------------------------------------------------------------
      if (method === 'GET' && path === '/admin/system') {
        if (m.failSystem) return route.fulfill({ status: 503, body: '' });
        return json(route, 200, m.system);
      }

      // ---- staff ----------------------------------------------------------------------------------------
      if (method === 'GET' && path === '/admin/staff') return json(route, 200, m.staff);
      if (method === 'POST' && path === '/admin/staff') {
        note();
        const b = body as { displayName: string; email: string; role: StaffRow['role']; doctorId?: string; newDoctor?: { department: string; room: string }; doctorIds?: string[] };
        if (m.staff.some((s) => s.email === b.email)) return error(route, 409, 'CONFLICT', 'That email address is already in use.');
        let doctorId: string | null = b.doctorId ?? null;
        if (b.newDoctor) {
          doctorId = uuid(0xd9);
          doctors.push({ id: doctorId, fullName: b.displayName, department: b.newDoctor.department, room: b.newDoctor.room, active: true });
        }
        const member: StaffRow = { userId: uuid(0x60 + seq++), displayName: b.displayName, email: b.email, role: b.role, doctorIds: b.doctorIds ?? [], active: true, doctorId };
        m.staff.push(member);
        return json(route, 201, { member, temporaryPassword: TEMP_PASSWORD });
      }
      const status = path.match(/^\/admin\/staff\/([^/]+)\/(deactivate|activate|reset-password)$/);
      if (method === 'POST' && status) {
        note();
        const s = m.staff.find((x) => x.userId === status[1]);
        if (!s) return error(route, 404, 'NOT_FOUND', 'Staff member not found.');
        if (status[2] === 'deactivate') {
          if (s.userId === ADMIN_ID) return error(route, 409, 'CONFLICT', 'An admin cannot deactivate themself.');
          s.active = false;
        }
        if (status[2] === 'activate') s.active = true;
        if (status[2] === 'reset-password') return json(route, 200, { member: s, temporaryPassword: TEMP_PASSWORD });
        return json(route, 200, s);
      }
      const assign = path.match(/^\/admin\/staff\/([^/]+)\/assignments$/);
      if (method === 'PUT' && assign) {
        note();
        const s = m.staff.find((x) => x.userId === assign[1]);
        if (!s) return error(route, 404, 'NOT_FOUND', 'Staff member not found.');
        s.doctorIds = (body as { doctorIds: string[] }).doctorIds;
        return json(route, 200, { userId: s.userId, doctorIds: s.doctorIds });
      }

      return route.fallback();
    },
  );
  return m;
}

/** Only GET /admin/system, for older admin specs that do not need the rest: the Background work panel then reads all fine. */
export async function mockSystemFine(page: Page): Promise<void> {
  await page.route(
    (url) => url.pathname === '/api/admin/system',
    (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(SYSTEM_FINE) }),
  );
}
