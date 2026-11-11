/* eslint-disable @typescript-eslint/no-non-null-assertion, @typescript-eslint/no-dynamic-delete -- test fixtures: lookups are of ids this file created */
import type { Page, Route } from '@playwright/test';

/**
 * Stateful /api mock for booking, my visits and the reception desk (W1).
 * Register it AFTER mockApi(): later routes win, and anything not handled here falls back to mockApi.
 * All dates are derived from NOW so screenshots are stable.
 */

/** 10:05 am IST on Wed 11 Nov 2026. The page clock is fixed to this instant. */
export const NOW = new Date('2026-11-11T04:35:00Z');
export const TODAY = '2026-11-11';

const uuid = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;

const ymd = (dayOffset: number) => {
  const d = new Date(`${TODAY}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + dayOffset);
  return d.toISOString().slice(0, 10);
};
const at = (date: string, hhmm: string) => `${date}T${hhmm}:00+05:30`;

export const DOCTORS = [
  { id: uuid(0xd1), fullName: 'Dr. Meenakshi Rao', department: 'General Medicine', room: '12', active: true },
  { id: uuid(0xd2), fullName: 'Dr. Arvind Kulkarni', department: 'Paediatrics', room: '4', active: true },
  { id: uuid(0xd3), fullName: 'Dr. Farah Siddiqui', department: 'ENT', room: '7', active: true },
  { id: uuid(0xd4), fullName: 'Dr. Suresh Gowda', department: 'Orthopaedics', room: '9', active: true },
  { id: uuid(0xd5), fullName: 'Dr. Pooja Bhat', department: 'Dermatology', room: '3', active: true },
];
const D1 = DOCTORS[0]!;
const D4 = DOCTORS[3]!;

export const ME_PATIENT_ID = uuid(0xa1);

interface PatientRow {
  id: string;
  mrn: string;
  fullName: string;
  phone: string | null;
  dateOfBirth: string | null;
  hasLogin: boolean;
  createdAt: string;
}

const patient = (n: number, fullName: string, phone: string | null, dob: string | null, id = uuid(0xa000 + n)): PatientRow => ({
  id,
  mrn: `BLR-${String(n).padStart(6, '0')}`,
  fullName,
  phone,
  dateOfBirth: dob,
  hasLogin: n === 1,
  createdAt: '2026-10-01T05:00:00Z',
});

const PATIENTS: PatientRow[] = [
  patient(1, 'Ananya Iyer', '+91 98450 11234', '1991-04-12', ME_PATIENT_ID),
  patient(2, 'Harish Gowda', '+91 98450 22341', '1962-08-03'),
  patient(3, 'Lakshmi Narayanan', '+91 98450 33452', '1955-01-19'),
  patient(4, 'Sneha Kulkarni', '+91 98450 44563', '1988-11-27'),
  patient(5, 'Rohan Deshpande', '+91 98450 55674', '1979-06-09'),
  patient(6, 'Fatima Begum', '+91 98450 66785', '1971-02-14'),
  patient(7, 'Chandrashekar Murthy', '+91 98450 77896', '1950-12-30'),
  patient(8, 'Gopal Krishnan', '+91 98450 88907', '1967-09-21'),
  patient(9, 'Divya Prakash', '+91 98450 99018', '1994-03-05'),
  patient(10, 'Mohammed Irfan', '+91 98450 10129', '1983-07-16'),
  patient(11, 'Nandini Reddy', '+91 98450 21230', '2001-05-23'),
  patient(12, 'Suresh Babu', '+91 98450 32341', '1958-10-08'),
];
const patientById = (id: string) => PATIENTS.find((p) => p.id === id)!;

interface SessionRow {
  id: string;
  doctorId: string;
  doctorName: string;
  department: string;
  room: string;
  sessionDate: string;
  label: 'morning' | 'afternoon';
  startsAt: string;
  endsAt: string;
  slotMinutes: number;
  status: 'scheduled' | 'open' | 'paused' | 'unavailable' | 'closed';
  policyVersion: number;
  version: number;
  /** Bookings by other patients, not modelled as appointments. */
  baseBooked: number;
  bookedCapacity: number;
  walkinCapacity: number;
  walkinUsed: number;
}

export interface ApptRow {
  id: string;
  patientId: string;
  sessionId: string;
  doctorId: string;
  doctorName: string;
  department: string;
  scheduledAt: string;
  status: 'booked' | 'checked_in' | 'completed' | 'cancelled' | 'missed' | 'rescheduled';
  rescheduledFromId: string | null;
  followUpTaskId: string | null;
  version: number;
  createdAt: string;
  patientName?: string;
  patientMrn?: string;
  patientPhone?: string | null;
}

function buildSessions(): SessionRow[] {
  const out: SessionRow[] = [];
  DOCTORS.forEach((doc, di) => {
    for (let day = 0; day < 8; day++) {
      const date = ymd(day);
      (['morning', 'afternoon'] as const).forEach((label, li) => {
        const id = uuid(0x10000 + di * 1000 + day * 10 + li);
        out.push({
          id,
          doctorId: doc.id,
          doctorName: doc.fullName,
          department: doc.department,
          room: doc.room,
          sessionDate: date,
          label,
          startsAt: at(date, label === 'morning' ? '09:00' : '14:00'),
          endsAt: at(date, label === 'morning' ? '13:00' : '17:00'),
          slotMinutes: 20,
          status: day === 0 && label === 'morning' ? 'open' : 'scheduled',
          policyVersion: 1,
          version: 1,
          baseBooked: (di * 3 + day * 2 + li) % 6,
          bookedCapacity: 10,
          walkinCapacity: 5,
          walkinUsed: 0,
        });
      });
    }
  });
  return out;
}

export const sessionId = (doctorIdx: number, day: number, label: 'morning' | 'afternoon') => uuid(0x10000 + doctorIdx * 1000 + day * 10 + (label === 'morning' ? 0 : 1));

export interface SchedulingMock {
  sessions: SessionRow[];
  appointments: ApptRow[];
  /** "METHOD /path" for each scheduling call seen, with the Idempotency-Key header when sent. */
  requests: Array<{ line: string; key: string | null; body: unknown }>;
  /** Make the next call to this operation fail once. */
  failNext: Partial<Record<'book' | 'reschedule' | 'cancel' | 'check-in' | 'walk-in' | 'appointments', 'network' | 'capacity' | 'late' | 'server'>>;
  /** Make a session read as completely full (no places left). */
  fillSession(id: string): void;
  /** Hold GET /appointments?sessionId= for this many ms (to screenshot loading). */
  delayAppointmentsMs: number;
}

export interface SchedulingOptions {
  /** Start with no appointments in today's session (empty-state screenshot). */
  emptyToday?: boolean;
  /** Start with today's walk-in places all taken. */
  walkinFull?: boolean;
}

function lateMinutes(scheduledAt: string): number {
  return Math.floor((NOW.getTime() - new Date(scheduledAt).getTime()) / 60_000);
}

export async function mockScheduling(page: Page, options: SchedulingOptions = {}): Promise<SchedulingMock> {
  await page.clock.setFixedTime(NOW);

  const sessions = buildSessions();
  // Tomorrow's morning for Dr. Rao is full, and two days out is full all day: exercises "Full" states.
  for (const s of sessions) {
    if (s.doctorId === D1.id && s.sessionDate === ymd(1) && s.label === 'morning') s.baseBooked = 10;
    if (s.doctorId === D1.id && s.sessionDate === ymd(3)) s.baseBooked = 10;
  }
  const todayRao = sessions.find((s) => s.doctorId === D1.id && s.sessionDate === TODAY && s.label === 'morning')!;
  todayRao.baseBooked = 0;
  if (options.walkinFull) todayRao.walkinUsed = 5;

  const mk = (n: number, patientNo: number, sess: SessionRow, hhmm: string, status: ApptRow['status']): ApptRow => {
    const p = PATIENTS[patientNo - 1]!;
    return {
      id: uuid(0xb000 + n),
      patientId: p.id,
      sessionId: sess.id,
      doctorId: sess.doctorId,
      doctorName: sess.doctorName,
      department: sess.department,
      scheduledAt: at(sess.sessionDate, hhmm),
      status,
      rescheduledFromId: null,
      followUpTaskId: null,
      version: 1,
      createdAt: '2026-11-05T05:00:00Z',
      patientName: p.fullName,
      patientMrn: p.mrn,
      patientPhone: p.phone,
    };
  };

  const rao = (day: number, label: 'morning' | 'afternoon') => sessions.find((s) => s.doctorId === D1.id && s.sessionDate === ymd(day) && s.label === label)!;
  const ortho = sessions.find((s) => s.doctorId === D4.id && s.sessionDate === ymd(4) && s.label === 'morning')!;

  const appointments: ApptRow[] = options.emptyToday
    ? []
    : [
        mk(1, 2, todayRao, '09:00', 'checked_in'),
        mk(2, 3, todayRao, '09:20', 'checked_in'),
        mk(3, 10, todayRao, '09:40', 'missed'),
        mk(4, 8, todayRao, '09:35', 'booked'),
        mk(5, 4, todayRao, '10:00', 'booked'),
        mk(6, 5, todayRao, '10:10', 'booked'),
        mk(7, 6, todayRao, '10:20', 'booked'),
        mk(8, 7, todayRao, '10:30', 'booked'),
        mk(9, 9, todayRao, '09:30', 'cancelled'),
      ];

  // Ananya Iyer's own visits (patient screens).
  const mine = (n: number, sess: SessionRow, hhmm: string, status: ApptRow['status'], date?: string): ApptRow => ({
    ...mk(n, 1, sess, hhmm, status),
    scheduledAt: at(date ?? sess.sessionDate, hhmm),
  });
  const pastSession: SessionRow = { ...rao(0, 'morning'), id: uuid(0x99999) };
  appointments.push(
    mine(20, rao(1, 'afternoon'), '14:40', 'booked'),
    mine(21, ortho, '10:20', 'booked'),
    mine(22, pastSession, '09:00', 'completed', ymd(-8)),
    mine(23, pastSession, '11:20', 'cancelled', ymd(-6)),
    mine(24, pastSession, '10:00', 'missed', ymd(-15)),
  );

  const m: SchedulingMock = {
    sessions,
    appointments,
    requests: [],
    failNext: {},
    fillSession(id) {
      const s = sessions.find((x) => x.id === id);
      if (s) s.baseBooked = 10;
    },
    delayAppointmentsMs: 0,
  };

  let apptSeq = 100;
  let patientSeq = 1000;
  let tokenA = 2; // A-001, A-002 are already issued to the two checked-in arrivals
  let tokenW = 0;
  const replays = new Map<string, { status: number; body: unknown }>();

  const json = (route: Route, status: number, body: unknown) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
  const error = (route: Route, status: number, code: string, message: string, details?: unknown) =>
    json(route, status, { error: { code, message, ...(details !== undefined ? { details } : {}) } });

  const capacity = (s: SessionRow) => {
    const explicit = appointments.filter((a) => a.sessionId === s.id && (a.status === 'booked' || a.status === 'checked_in' || a.status === 'completed' || a.status === 'missed')).length;
    const bookedReserved = Math.min(s.bookedCapacity, s.baseBooked + explicit);
    return {
      bookedCapacity: s.bookedCapacity,
      walkinCapacity: s.walkinCapacity,
      bookedReserved,
      walkinUsed: s.walkinUsed,
      bookedAvailable: s.bookedCapacity - bookedReserved,
      walkinAvailable: s.walkinCapacity - s.walkinUsed,
    };
  };
  const sessionJson = (s: SessionRow) => {
    const { baseBooked: _b, bookedCapacity: _c, walkinCapacity: _w, walkinUsed: _u, ...rest } = s;
    return { ...rest, capacity: capacity(s) };
  };
  const apptJson = (a: ApptRow, staff: boolean) => {
    if (staff) return a;
    const { patientName: _n, patientMrn: _m, patientPhone: _p, ...rest } = a;
    return rest;
  };

  const nextFreeTime = (s: SessionRow): string => {
    const taken = new Set(appointments.filter((a) => a.sessionId === s.id && a.status !== 'cancelled' && a.status !== 'rescheduled').map((a) => a.scheduledAt));
    const start = new Date(s.startsAt).getTime();
    for (let i = 0; i < 12; i++) {
      const t = new Date(start + i * s.slotMinutes * 60_000);
      const iso = t.toISOString();
      const clash = [...taken].some((x) => new Date(x).getTime() === t.getTime());
      if (t.getTime() > NOW.getTime() && !clash) return iso;
    }
    return s.startsAt;
  };

  const failure = (route: Route, op: keyof SchedulingMock['failNext'], capacityMessage = 'No places are left in this session.') => {
    const f = m.failNext[op];
    if (!f) return false;
    delete m.failNext[op];
    if (f === 'network') {
      void route.abort('failed');
    } else if (f === 'capacity') {
      void error(route, 409, 'CAPACITY_FULL', capacityMessage);
    } else if (f === 'server') {
      void route.fulfill({ status: 503, body: '' });
    }
    return f !== 'late';
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
      const body = method === 'POST' ? (req.postDataJSON?.() ?? null) : null;
      const note = () => m.requests.push({ line: `${method} ${path}`, key, body });

      if (method === 'GET' && path === '/doctors') return json(route, 200, DOCTORS);

      if (method === 'GET' && path === '/sessions') {
        let list = sessions;
        const date = q.get('date');
        const from = q.get('from');
        const to = q.get('to');
        const doc = q.get('doctorId');
        const dept = q.get('department');
        if (date) list = list.filter((s) => s.sessionDate === date);
        if (from) list = list.filter((s) => s.sessionDate >= from);
        if (to) list = list.filter((s) => s.sessionDate <= to);
        if (doc) list = list.filter((s) => s.doctorId === doc);
        if (dept) list = list.filter((s) => s.department === dept);
        return json(route, 200, list.map(sessionJson));
      }

      const slotsMatch = path.match(/^\/sessions\/([^/]+)\/slots$/);
      if (method === 'GET' && slotsMatch) {
        const s = sessions.find((x) => x.id === slotsMatch[1]);
        if (!s) return error(route, 404, 'NOT_FOUND', 'Session not found.');
        const free = nextFreeTime(s);
        return json(route, 200, {
          sessionId: s.id,
          slots: [{ scheduledAt: free, available: capacity(s).bookedAvailable > 0 }],
          capacity: capacity(s),
        });
      }

      if (method === 'GET' && path === '/appointments') {
        const sid = q.get('sessionId');
        const pid = q.get('patientId');
        if (m.failNext.appointments) {
          const f = m.failNext.appointments;
          delete m.failNext.appointments;
          if (f === 'server') return route.fulfill({ status: 503, body: '' });
        }
        if (m.delayAppointmentsMs) await new Promise((r) => setTimeout(r, m.delayAppointmentsMs));
        let list = appointments;
        if (sid) list = list.filter((a) => a.sessionId === sid);
        if (pid) list = list.filter((a) => a.patientId === pid);
        return json(route, 200, list.map((a) => apptJson(a, Boolean(sid))));
      }

      if (method === 'GET' && path === '/patients') {
        const term = (q.get('q') ?? '').toLowerCase();
        const digits = term.replace(/\D/g, '');
        const hits = PATIENTS.filter(
          (p) => p.fullName.toLowerCase().includes(term) || p.mrn.toLowerCase().includes(term) || (digits.length >= 3 && (p.phone ?? '').replace(/\D/g, '').includes(digits)),
        );
        return json(route, 200, hits);
      }

      if (method === 'POST' && path === '/patients') {
        note();
        const b = body as { fullName: string; phone?: string | null; dateOfBirth?: string | null };
        const p = patient(patientSeq++, b.fullName, b.phone ?? null, b.dateOfBirth ?? null, uuid(0xa000 + patientSeq));
        PATIENTS.push(p);
        return json(route, 201, p);
      }

      // ---- state-changing scheduling calls -----------------------------------------------------
      if (method === 'POST' && path === '/appointments') {
        note();
        if (key && replays.has(`book:${key}`)) {
          const r = replays.get(`book:${key}`)!;
          return json(route, r.status, r.body);
        }
        if (failure(route, 'book')) return;
        const b = body as { sessionId: string };
        const s = sessions.find((x) => x.id === b.sessionId);
        if (!s) return error(route, 404, 'NOT_FOUND', 'Session not found.');
        if (capacity(s).bookedAvailable <= 0) return error(route, 409, 'CAPACITY_FULL', 'No places are left in this session.');
        const appt: ApptRow = {
          id: uuid(0xb000 + apptSeq++),
          patientId: ME_PATIENT_ID,
          sessionId: s.id,
          doctorId: s.doctorId,
          doctorName: s.doctorName,
          department: s.department,
          scheduledAt: nextFreeTime(s),
          status: 'booked',
          rescheduledFromId: null,
          followUpTaskId: null,
          version: 1,
          createdAt: NOW.toISOString(),
        };
        appointments.push(appt);
        const out = apptJson(appt, false);
        if (key) replays.set(`book:${key}`, { status: 201, body: out });
        return json(route, 201, out);
      }

      const cancelMatch = path.match(/^\/appointments\/([^/]+)\/cancel$/);
      if (method === 'POST' && cancelMatch) {
        note();
        if (failure(route, 'cancel')) return;
        const a = appointments.find((x) => x.id === cancelMatch[1]);
        if (!a) return error(route, 404, 'NOT_FOUND', 'Appointment not found.');
        a.status = 'cancelled';
        a.version += 1;
        return json(route, 200, apptJson(a, false));
      }

      const reschedMatch = path.match(/^\/appointments\/([^/]+)\/reschedule$/);
      if (method === 'POST' && reschedMatch) {
        note();
        if (failure(route, 'reschedule', 'That session has no places left.')) return;
        const a = appointments.find((x) => x.id === reschedMatch[1]);
        const target = sessions.find((x) => x.id === (body as { targetSessionId: string }).targetSessionId);
        if (!a || !target) return error(route, 404, 'NOT_FOUND', 'Appointment or session not found.');
        if (capacity(target).bookedAvailable <= 0) return error(route, 409, 'CAPACITY_FULL', 'That session has no places left.');
        a.status = 'rescheduled';
        const next: ApptRow = { ...a, id: uuid(0xb000 + apptSeq++), sessionId: target.id, doctorId: target.doctorId, doctorName: target.doctorName, department: target.department, scheduledAt: nextFreeTime(target), status: 'booked', rescheduledFromId: a.id, version: 1 };
        appointments.push(next);
        return json(route, 200, apptJson(next, false));
      }

      const checkInMatch = path.match(/^\/appointments\/([^/]+)\/check-in$/);
      if (method === 'POST' && checkInMatch) {
        note();
        const a = appointments.find((x) => x.id === checkInMatch[1]);
        if (!a) return error(route, 404, 'NOT_FOUND', 'Appointment not found.');
        const admitLate = Boolean((body as { admitLate?: boolean } | null)?.admitLate);
        const late = lateMinutes(a.scheduledAt);
        const forceLate = m.failNext['check-in'] === 'late';
        if (m.failNext['check-in'] && m.failNext['check-in'] !== 'late') {
          if (failure(route, 'check-in', 'No walk-in places are left in this session.')) return;
        }
        const s = sessions.find((x) => x.id === a.sessionId)!;
        if ((forceLate || late > 15) && !admitLate) {
          delete m.failNext['check-in'];
          return error(route, 409, 'LATE_ARRIVAL_REQUIRES_REVIEW', 'This arrival is after the grace period and needs review.', { minutesLate: Math.max(late, 16), graceMinutes: 15 });
        }
        if (admitLate && s.walkinUsed >= s.walkinCapacity) return error(route, 409, 'CAPACITY_FULL', 'No walk-in places are left in this session.');
        a.status = 'checked_in';
        a.version += 1;
        let token: string;
        if (admitLate) {
          s.walkinUsed += 1;
          tokenW += 1;
          token = `W-${String(tokenW).padStart(3, '0')}`;
        } else {
          tokenA += 1;
          token = `A-${String(tokenA).padStart(3, '0')}`;
        }
        return json(route, 200, {
          visitId: uuid(0xc000 + tokenA + tokenW),
          queueEntryId: uuid(0xd000 + tokenA + tokenW),
          token,
          group: admitLate ? 'W' : 'A',
          kind: admitLate ? 'late_admission' : 'appointment',
          eligibleAt: admitLate ? NOW.toISOString() : new Date(new Date(a.scheduledAt).getTime() - 10 * 60_000).toISOString(),
          queueVersion: tokenA + tokenW,
        });
      }

      const walkMatch = path.match(/^\/sessions\/([^/]+)\/walk-ins$/);
      if (method === 'POST' && walkMatch) {
        note();
        if (failure(route, 'walk-in', 'No walk-in places are left in this session.')) return;
        const s = sessions.find((x) => x.id === walkMatch[1]);
        if (!s) return error(route, 404, 'NOT_FOUND', 'Session not found.');
        if (s.walkinUsed >= s.walkinCapacity) return error(route, 409, 'CAPACITY_FULL', 'No walk-in places are left in this session.');
        const p = patientById((body as { patientId: string }).patientId);
        s.walkinUsed += 1;
        tokenW += 1;
        void p;
        return json(route, 201, {
          visitId: uuid(0xc000 + tokenA + tokenW),
          queueEntryId: uuid(0xd000 + tokenA + tokenW),
          token: `W-${String(tokenW).padStart(3, '0')}`,
          group: 'W',
          kind: 'walkin',
          eligibleAt: NOW.toISOString(),
          queueVersion: tokenA + tokenW,
        });
      }

      return route.fallback();
    },
  );

  return m;
}
