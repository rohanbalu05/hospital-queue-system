import type { Page, Route } from '@playwright/test';
import { mockApi } from './mocks';
import { installFakeEventSource, mockQueue, type QueueMock, type QueueMockOptions } from './mocks-queue';
import { NOW, mockScheduling, type SchedulingMock, type SchedulingOptions } from './scheduling-mocks';
import { routeLiveBoardToQueueMock } from './w3-mocks';

/**
 * Session 3 desk mocks: what the reception patient desk, duplicate warning, alternatives and doctor follow-up need on top of
 * the scheduling and queue mocks. Registered AFTER them, so these routes win and everything else falls back.
 */

const uuid = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const TODAY = '2026-11-11';
const ist = (hhmm: string) => new Date(`${TODAY}T${hhmm}:00+05:30`).toISOString();

/** Two more General Medicine doctors today, so "Other doctors in General Medicine today" has someone to offer. */
export const ALT_BHAT = uuid(0x5e71);
export const ALT_NAIR = uuid(0x5e72);

export interface DeskExtras {
  /** POSTs the desk made: path, body, Idempotency-Key. */
  posts: Array<{ path: string; body: Record<string, unknown>; key: string | null }>;
  /** Alternatives GET /sessions/{id}/alternatives answers. */
  alternatives: unknown[];
  /** Make POST /follow-up-tasks answer 422 once. */
  failFollowUp: boolean;
}

const alternative = (over: Record<string, unknown>) => ({
  sessionId: ALT_BHAT,
  doctorId: uuid(0xd7),
  doctorName: 'Dr. Anil Bhat',
  department: 'General Medicine',
  room: 'OPD 4',
  sessionDate: TODAY,
  label: 'morning',
  startsAt: ist('09:00'),
  endsAt: ist('13:00'),
  status: 'open',
  nextSlotAt: ist('10:24'),
  bookedAvailable: 5,
  walkinAvailable: 3,
  ...over,
});

export async function mockDeskExtras(page: Page, sched: SchedulingMock): Promise<DeskExtras> {
  const state: DeskExtras = {
    posts: [],
    alternatives: [
      alternative({}),
      alternative({
        sessionId: ALT_NAIR,
        doctorId: uuid(0xd8),
        doctorName: 'Dr. Revathi Nair',
        room: 'OPD 9',
        label: 'afternoon',
        startsAt: ist('14:00'),
        endsAt: ist('17:00'),
        status: 'scheduled',
        nextSlotAt: ist('14:00'),
        walkinAvailable: 1,
      }),
    ],
    failFollowUp: false,
  };
  const json = (route: Route, status: number, body: unknown) =>
    route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
  let seq = 400;

  await page.route(
    (url) => url.pathname.startsWith('/api/'),
    async (route) => {
      const req = route.request();
      const path = new URL(req.url()).pathname.replace(/^\/api/, '');
      const method = req.method();
      const key = req.headers()['idempotency-key'] ?? null;
      const body = method === 'POST' ? ((req.postDataJSON?.() ?? {}) as Record<string, unknown>) : {};

      if (method === 'GET' && /^\/sessions\/[^/]+\/alternatives$/.test(path))
        return json(route, 200, state.alternatives);

      if (
        method === 'POST' &&
        (path === '/appointments' || path === '/patients' || path === '/follow-up-tasks' || /\/walk-ins$/.test(path))
      ) {
        state.posts.push({ path, body, key });
      }

      // Reception books for a chosen patient.
      if (method === 'POST' && path === '/appointments' && typeof body.patientId === 'string') {
        const s = sched.sessions.find((x) => x.id === body.sessionId);
        if (!s) return json(route, 404, { error: { code: 'NOT_FOUND', message: 'Session not found.' } });
        const taken = new Set(
          sched.appointments
            .filter((a) => a.sessionId === s.id && a.status !== 'cancelled' && a.status !== 'rescheduled')
            .map((a) => new Date(a.scheduledAt).getTime()),
        );
        let t = new Date(s.startsAt).getTime();
        while (t <= NOW.getTime() || taken.has(t)) t += s.slotMinutes * 60_000;
        const patient = sched.appointments.find((a) => a.patientId === body.patientId);
        const appt = {
          id: uuid(0xb000 + seq++),
          patientId: body.patientId,
          sessionId: s.id,
          doctorId: s.doctorId,
          doctorName: s.doctorName,
          department: s.department,
          scheduledAt: new Date(t).toISOString(),
          status: 'booked' as const,
          rescheduledFromId: null,
          followUpTaskId: null,
          version: 1,
          createdAt: NOW.toISOString(),
          ...(patient
            ? { patientName: patient.patientName, patientMrn: patient.patientMrn, patientPhone: patient.patientPhone }
            : {}),
        };
        sched.appointments.push(appt);
        return json(route, 201, appt);
      }

      // Registration that looks like an existing patient: 409 until the desk confirms.
      if (method === 'POST' && path === '/patients' && body.fullName === 'Harish Gowda' && !body.confirmNew) {
        return json(route, 409, {
          error: {
            code: 'CONFLICT',
            message: 'A patient with this phone number already exists.',
            details: {
              reason: 'POSSIBLE_DUPLICATE',
              candidates: [
                {
                  id: uuid(0xa002),
                  mrn: 'BLR-000002',
                  fullName: 'Harish Gowda',
                  phone: '+91 98450 22341',
                  dateOfBirth: '1962-08-03',
                  hasLogin: false,
                  createdAt: '2026-10-01T05:00:00Z',
                },
                {
                  id: uuid(0xa0c2),
                  mrn: 'BLR-000412',
                  fullName: 'Harish Gowda',
                  phone: '+91 98450 22341',
                  dateOfBirth: null,
                  hasLogin: false,
                  createdAt: '2026-10-19T05:00:00Z',
                },
              ],
            },
          },
        });
      }

      // Walk-in into one of the made-up alternative sessions.
      const walk = /^\/sessions\/([^/]+)\/walk-ins$/.exec(path);
      if (method === 'POST' && walk && (walk[1] === ALT_BHAT || walk[1] === ALT_NAIR)) {
        return json(route, 201, {
          visitId: uuid(0xc901),
          queueEntryId: uuid(0xc902),
          token: 'W-003',
          group: 'W',
          kind: 'walkin',
          eligibleAt: NOW.toISOString(),
          queueVersion: 3,
        });
      }

      if (method === 'POST' && path === '/follow-up-tasks') {
        if (state.failFollowUp) {
          state.failFollowUp = false;
          return json(route, 422, {
            error: { code: 'VALIDATION_FAILED', message: 'The due time must be in the future.' },
          });
        }
        return json(route, 201, {
          id: uuid(0x7a01),
          patientId: body.patientId,
          patientName: 'Harish Gowda',
          sourceVisitId: body.sourceVisitId ?? null,
          sourceMessageId: null,
          kind: body.kind,
          title: body.title,
          detail: body.detail ?? null,
          ownerId: null,
          ownerName: null,
          status: 'open',
          dueAt: body.dueAt,
          overdue: false,
          acknowledgedAt: null,
          disposition: null,
          outcomeNote: null,
          resolvedAt: null,
          returnAppointmentId: null,
          version: 1,
          createdAt: NOW.toISOString(),
        });
      }
      return route.fallback();
    },
  );
  return state;
}

export interface DeskSetup {
  queue: QueueMock;
  sched: SchedulingMock;
  extras: DeskExtras;
}

export async function setupDesk(
  page: Page,
  role: 'reception' | 'doctor',
  opts: { queue?: QueueMockOptions; sched?: SchedulingOptions } = {},
): Promise<DeskSetup> {
  await installFakeEventSource(page);
  await mockApi(page, role);
  const queue = await mockQueue(page, opts.queue);
  if (role === 'doctor') {
    // The doctor console reads its sessions from the queue mock, so the scheduling mock stays out of the way.
    const none = { sessions: [], appointments: [] } as unknown as SchedulingMock;
    return { queue, sched: none, extras: await mockDeskExtras(page, none) };
  }
  const sched = await mockScheduling(page, opts.sched);
  await routeLiveBoardToQueueMock(page);
  const extras = await mockDeskExtras(page, sched);
  return { queue, sched, extras };
}
