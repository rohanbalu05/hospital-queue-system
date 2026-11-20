/* eslint-disable @typescript-eslint/no-non-null-assertion -- fixtures look up ids this file created */
import type { Page, Route } from '@playwright/test';
import { mockApi, type ApiMock } from './mocks';
import { installFakeEventSource } from './mocks-queue';
import { ME_PATIENT_ID, NOW, TODAY } from './scheduling-mocks';

/**
 * Wave 5 patient mock: doctor availability, today's visits, alternatives, one-click rebook and the notification centre.
 * Register after mockApi(); it sets /me itself and fixes the page clock at 10:05 am IST on 11 Nov 2026.
 */

const uuid = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const at = (hhmm: string, date = TODAY) => `${date}T${hhmm}:00+05:30`;

export const S_KULKARNI = uuid(0x5e01);
export const S_SIDDIQUI = uuid(0x5e02);
export const S_BHAT = uuid(0x5e03);
export const S_RAO_TOMORROW = uuid(0x5e04);
export const APPT_ID = uuid(0xb901);

export type AvailabilityState = 'not_started' | 'available' | 'away' | 'unavailable' | 'ended';

export interface Availability {
  state: AvailabilityState;
  since: string | null;
  expectedBackAt: string | null;
  overdue: boolean;
  reason: null;
}

export const AVAILABLE: Availability = { state: 'available', since: null, expectedBackAt: null, overdue: false, reason: null };
export const AWAY: Availability = { state: 'away', since: at('09:50'), expectedBackAt: at('10:45'), overdue: false, reason: null };
export const UNAVAILABLE: Availability = { state: 'unavailable', since: at('09:55'), expectedBackAt: null, overdue: false, reason: null };

export interface Appt {
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
  queueEntryId?: string | null;
  token?: string | null;
}

export interface NotificationRow {
  id: string;
  kind: string;
  body: string;
  createdAt: string;
  readAt: string | null;
  link: string | null;
  severity: 'info' | 'warning' | 'urgent';
}

export interface Alternative {
  sessionId: string;
  doctorId: string;
  doctorName: string;
  department: string;
  room: string;
  sessionDate: string;
  label: 'morning' | 'afternoon';
  startsAt: string;
  endsAt: string;
  status: 'scheduled' | 'open';
  nextSlotAt: string | null;
  bookedAvailable: number;
  walkinAvailable: number;
}

export interface TodayVisit {
  visitId: string;
  sessionId: string;
  appointmentId: string | null;
  doctorName: string;
  department: string;
  room: string;
  kind: 'appointment' | 'walkin' | 'late_admission' | 'transfer';
  visitStatus: 'open' | 'in_service';
  token: string;
  queueState: 'waiting' | 'called' | 'in_service' | 'completed' | 'skipped' | 'absent' | 'cancelled';
  checkedInAt: string;
  scheduledAt: string | null;
  availability: Availability;
}

export interface W5World {
  /** Doctor availability per session. */
  availability: Record<string, Availability>;
  doctorName: Record<string, string>;
  appointments: Appt[];
  visits: TodayVisit[];
  /** Sessions where this patient is checked in (the snapshot carries myEntry). */
  checkedIn: Record<string, { token: string; group: 'A' | 'W'; position: number; eta: Record<string, unknown> }>;
  notifications: NotificationRow[];
  alternatives: Alternative[];
  /** Make the next reschedule fail with this error code (CAPACITY_FULL = slot just taken). */
  failReschedule: 'CAPACITY_FULL' | null;
  /** The real server answers 404 for the queue of a session where the patient has no queue entry yet (booked, not arrived). */
  noSnapshotBeforeCheckIn?: boolean;
  requests: Array<{ line: string; key: string | null; body: unknown }>;
}

export const ETA_RANGE = {
  status: 'ok',
  lowMinutes: 40,
  highMinutes: 55,
  note: null,
  computedAt: NOW.toISOString(),
  estimatorMeanMinutes: 12,
  estimatorSamples: 6,
  uncertainty: 'warm',
};
export const ETA_AWAY_LONG = {
  status: 'withheld',
  lowMinutes: null,
  highMinutes: null,
  note: 'The doctor is away longer than expected',
  computedAt: NOW.toISOString(),
  estimatorMeanMinutes: 12,
  estimatorSamples: 6,
  uncertainty: null,
};

export function defaultWorld(): W5World {
  const kulkarni = uuid(0xd2);
  return {
    availability: { [S_KULKARNI]: AVAILABLE, [S_SIDDIQUI]: AVAILABLE, [S_BHAT]: AVAILABLE, [S_RAO_TOMORROW]: AVAILABLE },
    doctorName: { [S_KULKARNI]: 'Dr. Arvind Kulkarni', [S_SIDDIQUI]: 'Dr. Farah Siddiqui', [S_BHAT]: 'Dr. Pooja Bhat', [S_RAO_TOMORROW]: 'Dr. Meenakshi Rao' },
    appointments: [
      {
        id: APPT_ID,
        patientId: ME_PATIENT_ID,
        sessionId: S_KULKARNI,
        doctorId: kulkarni,
        doctorName: 'Dr. Arvind Kulkarni',
        department: 'Paediatrics',
        scheduledAt: at('10:20'),
        status: 'booked',
        rescheduledFromId: null,
        followUpTaskId: null,
        version: 2,
        createdAt: '2026-11-05T05:00:00Z',
      },
    ],
    visits: [],
    checkedIn: {},
    notifications: [],
    alternatives: [
      alt(S_SIDDIQUI, 0xd3, 'Dr. Farah Siddiqui', 'ENT', '7', TODAY, 'morning', '11:20', 4),
      alt(S_BHAT, 0xd5, 'Dr. Pooja Bhat', 'Dermatology', '3', TODAY, 'afternoon', '14:00', 7),
      alt(S_RAO_TOMORROW, 0xd1, 'Dr. Meenakshi Rao', 'General Medicine', '12', '2026-11-12', 'morning', '09:00', 1),
    ],
    failReschedule: null,
    requests: [],
  };
}

function alt(sessionId: string, doctor: number, doctorName: string, department: string, room: string, date: string, label: 'morning' | 'afternoon', slot: string, left: number): Alternative {
  return {
    sessionId,
    doctorId: uuid(doctor),
    doctorName,
    department,
    room,
    sessionDate: date,
    label,
    startsAt: at(label === 'morning' ? '09:00' : '14:00', date),
    endsAt: at(label === 'morning' ? '13:00' : '17:00', date),
    status: date === TODAY && label === 'morning' ? 'open' : 'scheduled',
    nextSlotAt: at(slot, date),
    bookedAvailable: left,
    walkinAvailable: 3,
  };
}

/** Realistic notices, newest first, as the worker writes them (D-034). */
export function sampleNotifications(): NotificationRow[] {
  const ago = (min: number) => new Date(NOW.getTime() - min * 60_000).toISOString();
  return [
    {
      id: uuid(0xc001),
      kind: 'SessionUnavailable',
      body: 'Dr. Arvind Kulkarni is not available for the rest of this session. You can rebook with another doctor or cancel your 10:20 am appointment.',
      createdAt: ago(3),
      readAt: null,
      link: `/patient/visits?rebook=${APPT_ID}`,
      severity: 'urgent',
    },
    {
      id: uuid(0xc002),
      kind: 'SessionPaused',
      body: 'Dr. Arvind Kulkarni has stepped away and is expected back about 10:45 am. Your place is kept.',
      createdAt: ago(15),
      readAt: null,
      link: `/patient/visit/${S_KULKARNI}`,
      severity: 'warning',
    },
    {
      id: uuid(0xc003),
      kind: 'AppointmentBooked',
      body: 'Your appointment with Dr. Arvind Kulkarni is booked for 10:20 am today. Arrive 10 minutes early.',
      createdAt: ago(60 * 20),
      readAt: null,
      link: '/patient',
      severity: 'info',
    },
    {
      id: uuid(0xc004),
      kind: 'SessionResumed',
      body: 'Dr. Pooja Bhat is back. Your place in the queue is unchanged.',
      createdAt: ago(60 * 28),
      readAt: ago(60 * 27),
      link: null,
      severity: 'info',
    },
  ];
}

export interface W5Mock {
  world: W5World;
  api: ApiMock;
}

/** Push a version notice over the fake SSE stream, as the server does after any queue or availability change. */
export async function emitQueueNotice(page: Page, sessionId: string, queueVersion: number): Promise<void> {
  await page.evaluate(
    ([id, version]) => {
      const w = window as unknown as { __sse: { sources: Array<{ closed: boolean; listeners: Record<string, Array<(e: MessageEvent) => void>> }> } };
      for (const src of w.__sse.sources) {
        if (src.closed) continue;
        for (const l of src.listeners['queue'] ?? []) l(new MessageEvent('queue', { data: JSON.stringify({ sessionId: id, queueVersion: version, eventType: 'queue.changed', committedAt: new Date().toISOString() }) }));
      }
    },
    [sessionId, queueVersion] as const,
  );
}

const json = (route: Route, status: number, body: unknown) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

export async function mockW5(page: Page, seed: Partial<W5World> = {}, role: 'patient' | 'reception' | 'doctor' = 'patient'): Promise<W5Mock> {
  await page.clock.setFixedTime(NOW);
  await installFakeEventSource(page);
  const api = await mockApi(page, role);
  const world: W5World = { ...defaultWorld(), ...seed };

  await page.route(
    (url) => url.pathname.startsWith('/api/'),
    async (route) => {
      const req = route.request();
      const url = new URL(req.url());
      const path = url.pathname.replace(/^\/api/, '');
      const method = req.method();
      const body = method === 'POST' ? (req.postDataJSON?.() ?? null) : null;
      const note = () => world.requests.push({ line: `${method} ${path}`, key: req.headers()['idempotency-key'] ?? null, body });

      if (method === 'GET' && path === '/appointments') return json(route, 200, world.appointments);

      if (method === 'GET' && path === '/me/visits/today') return json(route, 200, world.visits);

      const queueMatch = /^\/sessions\/([^/]+)\/queue$/.exec(path);
      if (method === 'GET' && queueMatch) {
        const id = queueMatch[1]!;
        const mine = world.checkedIn[id];
        if (!mine && world.noSnapshotBeforeCheckIn) return json(route, 404, { error: { code: 'NOT_FOUND', message: 'No visit in this session.' } });
        const availability = world.availability[id] ?? AVAILABLE;
        return json(route, 200, {
          view: 'patient',
          sessionId: id,
          status: availability.state === 'away' ? 'paused' : availability.state === 'unavailable' ? 'unavailable' : 'open',
          doctorName: world.doctorName[id] ?? 'Dr. Meenakshi Rao',
          availability,
          queueVersion: 7,
          capturedAt: NOW.toISOString(),
          myEntry: mine
            ? {
                queueEntryId: uuid(0xe010),
                token: mine.token,
                group: mine.group,
                state: 'waiting',
                position: mine.position,
                eta: mine.eta,
              }
            : null,
          nowCalling: availability.state === 'available' ? 'A-013' : null,
        });
      }

      const sessionMatch = /^\/sessions\/([^/]+)$/.exec(path);
      if (method === 'GET' && sessionMatch) {
        const id = sessionMatch[1]!;
        const availability = world.availability[id] ?? AVAILABLE;
        const own = world.appointments.find((a) => a.sessionId === id);
        const other = world.alternatives.find((a) => a.sessionId === id);
        const base = own ?? other;
        if (!base) return json(route, 404, { error: { code: 'NOT_FOUND', message: 'No such session.' } });
        return json(route, 200, {
          id,
          doctorId: own ? own.doctorId : other!.doctorId,
          doctorName: world.doctorName[id] ?? 'Dr. Meenakshi Rao',
          department: own ? own.department : other!.department,
          room: other?.room ?? '4',
          sessionDate: TODAY,
          label: 'morning',
          startsAt: at('09:00'),
          endsAt: at('13:00'),
          slotMinutes: 20,
          status: availability.state === 'away' ? 'paused' : availability.state === 'unavailable' ? 'unavailable' : 'open',
          availability,
          policyVersion: 1,
          capacity: { bookedCapacity: 10, walkinCapacity: 5, bookedReserved: 6, walkinUsed: 1, bookedAvailable: 4, walkinAvailable: 4 },
          version: 3,
        });
      }

      const altMatch = /^\/appointments\/([^/]+)\/alternatives$/.exec(path);
      if (method === 'GET' && altMatch) {
        const appt = world.appointments.find((a) => a.id === altMatch[1]);
        if (!appt) return json(route, 404, { error: { code: 'NOT_FOUND', message: 'No such appointment.' } });
        return json(route, 200, {
          appointmentId: appt.id,
          sourceAvailability: world.availability[appt.sessionId] ?? AVAILABLE,
          alternatives: world.alternatives,
        });
      }

      const reschedMatch = /^\/appointments\/([^/]+)\/reschedule$/.exec(path);
      if (method === 'POST' && reschedMatch) {
        note();
        const old = world.appointments.find((a) => a.id === reschedMatch[1])!;
        const target = world.alternatives.find((a) => a.sessionId === (body as { targetSessionId: string }).targetSessionId)!;
        if (world.failReschedule) {
          const code = world.failReschedule;
          world.failReschedule = null;
          // The slot the patient clicked is gone: it leaves the list the next fetch returns.
          world.alternatives = world.alternatives.filter((a) => a.sessionId !== target.sessionId);
          return json(route, 409, { error: { code, message: 'That session has no places left.' } });
        }
        old.status = 'rescheduled';
        const next: Appt = {
          ...old,
          id: uuid(0xb902),
          sessionId: target.sessionId,
          doctorId: target.doctorId,
          doctorName: target.doctorName,
          department: target.department,
          scheduledAt: target.nextSlotAt!,
          status: 'booked',
          rescheduledFromId: old.id,
          version: 1,
        };
        world.appointments.push(next);
        return json(route, 200, next);
      }

      const cancelMatch = /^\/appointments\/([^/]+)\/cancel$/.exec(path);
      if (method === 'POST' && cancelMatch) {
        note();
        const a = world.appointments.find((x) => x.id === cancelMatch[1])!;
        a.status = 'cancelled';
        a.version += 1;
        return json(route, 200, a);
      }

      if (method === 'GET' && path === '/notifications/unread-count') return json(route, 200, { unreadCount: world.notifications.filter((n) => !n.readAt).length });
      if (method === 'GET' && path === '/notifications') return json(route, 200, world.notifications);
      if (method === 'POST' && path === '/notifications/read-all') {
        note();
        const unread = world.notifications.filter((n) => !n.readAt);
        for (const n of unread) n.readAt = NOW.toISOString();
        return json(route, 200, { updated: unread.length });
      }
      const readMatch = /^\/notifications\/([^/]+)\/read$/.exec(path);
      if (method === 'POST' && readMatch) {
        note();
        const n = world.notifications.find((x) => x.id === readMatch[1]);
        if (n) n.readAt = n.readAt ?? NOW.toISOString();
        return route.fulfill({ status: 204 });
      }
      return route.fallback();
    },
  );

  return { world, api };
}

/** Notification routes alone, for screens that belong to other roles (reception, doctor). */
export async function mockNotifications(page: Page, rows: NotificationRow[]): Promise<NotificationRow[]> {
  await page.route(
    (url) => url.pathname.startsWith('/api/notifications'),
    async (route) => {
      const req = route.request();
      const path = new URL(req.url()).pathname.replace(/^\/api/, '');
      if (req.method() === 'GET' && path === '/notifications/unread-count') return json(route, 200, { unreadCount: rows.filter((n) => !n.readAt).length });
      if (req.method() === 'GET' && path === '/notifications') return json(route, 200, rows);
      if (req.method() === 'POST' && path === '/notifications/read-all') {
        const unread = rows.filter((n) => !n.readAt);
        for (const n of unread) n.readAt = NOW.toISOString();
        return json(route, 200, { updated: unread.length });
      }
      const m = /^\/notifications\/([^/]+)\/read$/.exec(path);
      if (req.method() === 'POST' && m) {
        const n = rows.find((x) => x.id === m[1]);
        if (n) n.readAt = n.readAt ?? NOW.toISOString();
        return route.fulfill({ status: 204 });
      }
      return route.fallback();
    },
  );
  return rows;
}

/** Notices a reception desk receives when a doctor steps away or becomes unavailable. */
export function staffNotifications(sessionId: string): NotificationRow[] {
  const ago = (min: number) => new Date(NOW.getTime() - min * 60_000).toISOString();
  return [
    {
      id: uuid(0xc101),
      kind: 'SessionPaused',
      body: 'Dr. Meenakshi Rao has stepped away and is expected back about 10:45 am. 6 patients are waiting and have been told.',
      createdAt: ago(4),
      readAt: null,
      link: `/reception?session=${sessionId}`,
      severity: 'warning',
    },
    {
      id: uuid(0xc102),
      kind: 'SessionUnavailable',
      body: 'Dr. Arvind Kulkarni is unavailable for the rest of the session. 3 booked patients and 2 checked-in patients need a new doctor.',
      createdAt: ago(35),
      readAt: null,
      link: `/reception?session=${sessionId}`,
      severity: 'urgent',
    },
    {
      id: uuid(0xc103),
      kind: 'SessionResumed',
      body: 'Dr. Pooja Bhat is back in Room 3.',
      createdAt: ago(60 * 26),
      readAt: ago(60 * 25),
      link: null,
      severity: 'info',
    },
  ];
}
