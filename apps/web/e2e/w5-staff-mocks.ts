/* eslint-disable @typescript-eslint/no-non-null-assertion -- fixtures look up ids this file created */
import type { Page, Route } from '@playwright/test';
import { mockApi } from './mocks';
import { SESSION_ID, installFakeEventSource, mockQueue, type QueueMock, type QueueMockOptions } from './mocks-queue';
import { mockScheduling } from './scheduling-mocks';
import { routeLiveBoardToQueueMock } from './w3-mocks';

/** Staff screens for the doctor availability lifecycle (W5): reception board with the affected-patients move. */

const uuid = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const ist = (hhmm: string) => new Date(`2026-11-11T${hhmm}:00+05:30`).toISOString();

export const TARGET_FULL_WALKIN = uuid(0x5e61);
export const TARGET_ROOMY = uuid(0x5e62);

const BOOKED = [
  { id: uuid(0xb101), patientId: uuid(0xa301), name: 'Ananya Iyer', mrn: 'MRN-100233', phone: '+919900112233', at: '10:36', hasLogin: true },
  { id: uuid(0xb102), patientId: uuid(0xa302), name: 'Imran Pasha', mrn: 'MRN-100250', phone: '+919845098765', at: '10:48', hasLogin: false },
  { id: uuid(0xb103), patientId: uuid(0xa303), name: 'Kavya Nambiar', mrn: 'MRN-100261', phone: '+919880554433', at: '11:00', hasLogin: true },
];

export interface AffectedMock {
  moves: Array<{ key: string | null; body: { targetSessionId: string; appointmentIds: string[]; queueEntryIds: string[] } }>;
  /** Source ids already moved; they drop out of later reads. */
  moved: Set<string>;
  /** Make GET /affected fail while true. */
  fail: boolean;
}

/**
 * GET /sessions/{id}/affected and POST /sessions/{id}/affected/move for whatever session id the page asks about.
 * The first alternative has booked places but no walk-in place; the second has room for everyone, so a mixed move
 * to the first shows "moved" and "not moved" rows.
 */
export async function mockAffected(page: Page, queue: QueueMock): Promise<AffectedMock> {
  const state: AffectedMock = { moves: [], moved: new Set(), fail: false };
  const json = (route: Route, status: number, body: unknown) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

  const alternatives = () => [
    { sessionId: TARGET_FULL_WALKIN, doctorId: uuid(0xd2), doctorName: 'Dr. Farah Siddiqui', department: 'General Medicine', room: 'OPD 7', sessionDate: '2026-11-11', label: 'morning', startsAt: ist('09:00'), endsAt: ist('13:00'), status: 'open', nextSlotAt: ist('10:36'), bookedAvailable: 4, walkinAvailable: 0 },
    { sessionId: TARGET_ROOMY, doctorId: uuid(0xd3), doctorName: 'Dr. Arvind Kulkarni', department: 'General Medicine', room: 'OPD 4', sessionDate: '2026-11-11', label: 'afternoon', startsAt: ist('14:00'), endsAt: ist('17:00'), status: 'scheduled', nextSlotAt: ist('14:00'), bookedAvailable: 10, walkinAvailable: 5 },
  ];

  await page.route(/\/api\/sessions\/[^/]+\/affected(\/move)?$/, async (route) => {
    const req = route.request();
    const isMove = req.url().endsWith('/move');
    if (!isMove && req.method() === 'GET') {
      if (state.fail) {
        return json(route, 500, { error: { code: 'INTERNAL', message: 'The server had a problem.' } });
      }
      const w = queue.world;
      const waiting = [...w.waiting, ...w.skipped];
      return json(route, 200, {
        sessionId: SESSION_ID,
        doctorName: 'Dr. Meenakshi Rao',
        department: 'General Medicine',
        availability: {
          state: w.status === 'unavailable' ? 'unavailable' : 'away',
          since: w.pausedAt,
          expectedBackAt: w.pauseUntil,
          overdue: false,
          reason: w.pauseReason,
        },
        notArrived: BOOKED.filter((b) => !state.moved.has(b.id)).map((b) => ({
          appointmentId: b.id,
          patientId: b.patientId,
          patientName: b.name,
          patientMrn: b.mrn,
          patientPhone: b.phone,
          scheduledAt: ist(b.at),
          status: 'booked',
          version: 1,
          hasLogin: b.hasLogin,
        })),
        inQueue: waiting
          .filter((e) => !state.moved.has(e.id))
          .map((e) => ({
            queueEntryId: e.id,
            visitId: e.visitId,
            patientId: e.patientId,
            patientName: e.patientName,
            patientMrn: `MRN-${e.patientId.slice(-6)}`,
            token: e.token,
            group: e.group,
            state: e.state === 'skipped' || e.state === 'absent' ? e.state : 'waiting',
            checkedInAt: e.checkedInAt,
            version: e.version,
          })),
        alternatives: alternatives(),
      });
    }
    if (isMove && req.method() === 'POST') {
      const body = req.postDataJSON() as AffectedMock['moves'][number]['body'];
      state.moves.push({ key: req.headers()['idempotency-key'] ?? null, body });
      const walkinFull = body.targetSessionId === TARGET_FULL_WALKIN;
      const results: unknown[] = [];
      let n = 20;
      for (const id of body.queueEntryIds) {
        const entry = [...queue.world.waiting, ...queue.world.skipped].find((e) => e.id === id)!;
        if (entry.group === 'W' && walkinFull) {
          results.push({ kind: 'queue_entry', sourceId: id, outcome: 'skipped', code: 'CAPACITY_FULL', message: 'No walk-in place left in this session.', newAppointmentId: null, newQueueEntryId: null, token: null, scheduledAt: null });
          continue;
        }
        state.moved.add(id);
        results.push({ kind: 'queue_entry', sourceId: id, outcome: 'moved', code: null, message: null, newAppointmentId: null, newQueueEntryId: uuid(0xe900 + n), token: `${entry.group}-0${n++}`, scheduledAt: null });
      }
      let minutes = 10 * 60 + 36;
      for (const id of body.appointmentIds) {
        state.moved.add(id);
        const hhmm = `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, '0')}`;
        results.push({ kind: 'appointment', sourceId: id, outcome: 'moved', code: null, message: null, newAppointmentId: uuid(0xb900 + minutes), newQueueEntryId: null, token: null, scheduledAt: ist(hhmm) });
        minutes += 12;
      }
      const moved = results.filter((r) => (r as { outcome: string }).outcome === 'moved').length;
      return json(route, 200, { sourceSessionId: SESSION_ID, targetSessionId: body.targetSessionId, moved, skipped: results.length - moved, results });
    }
    return route.fallback();
  });
  return state;
}

/** Reception's session id comes from the scheduling mock; the availability commands are answered by the queue mock's session. */
async function routeSessionCommandsToQueueMock(page: Page): Promise<void> {
  await page.route(
    (url) => /^\/api\/sessions\/[^/]+\/(pause|resume|unavailable)$/.test(url.pathname) && !url.pathname.includes(SESSION_ID),
    (route) => {
      const url = new URL(route.request().url());
      url.pathname = url.pathname.replace(/^\/api\/sessions\/[^/]+/, `/api/sessions/${SESSION_ID}`);
      return route.fallback({ url: url.toString() });
    },
  );
}

export async function setupReceptionAvailability(page: Page, options: QueueMockOptions = {}): Promise<{ queue: QueueMock; affected: AffectedMock }> {
  await installFakeEventSource(page);
  await mockApi(page, 'reception');
  const queue = await mockQueue(page, options);
  await mockScheduling(page);
  await routeLiveBoardToQueueMock(page);
  await routeSessionCommandsToQueueMock(page);
  const affected = await mockAffected(page, queue);
  return { queue, affected };
}

/** A delivery row as GET /admin/notifications returns it. */
export function delivery(n: number, over: Record<string, unknown> = {}) {
  return {
    id: uuid(0xd000 + n),
    channel: 'sms',
    status: 'sent',
    recipientName: 'Ananya Iyer',
    recipientRole: 'patient',
    address: '+91 ******2233',
    body: 'Dr. Meenakshi Rao has stepped away and is expected back about 10:45 am. Your place in the queue is kept.',
    eventType: 'SessionPaused',
    sessionId: SESSION_ID,
    provider: 'fake',
    providerMessageId: `fake-${n}`,
    attempts: 1,
    lastError: null,
    createdAt: ist('10:30'),
    sentAt: ist('10:30'),
    ...over,
  };
}

export const NOTIFICATION_ROWS = [
  delivery(1, { channel: 'in_app', recipientName: 'Ananya Iyer', address: 'in-app', provider: null, providerMessageId: null, attempts: 0 }),
  delivery(2),
  delivery(3, { channel: 'email', recipientName: 'Ananya Iyer', address: 'a***@example.in', body: 'Dr. Meenakshi Rao has stepped away and is expected back about 10:45 am. Your place in the queue is kept.' }),
  delivery(4, { recipientName: 'Imran Pasha', address: '+91 ******8765', status: 'failed', attempts: 3, lastError: 'Provider timed out', sentAt: null, createdAt: ist('10:30') }),
  delivery(5, { recipientName: 'Kavya Nambiar', address: '+91 ******4433', status: 'queued', attempts: 0, sentAt: null, createdAt: ist('10:31') }),
  delivery(6, { channel: 'in_app', recipientName: 'Deepa Nair', recipientRole: 'reception', address: 'in-app', provider: null, providerMessageId: null, attempts: 0, body: 'Dr. Meenakshi Rao is away, expected back about 10:45 am. 5 patients are waiting or booked.' }),
  delivery(7, { recipientName: 'Harish Gowda', address: '+91 ******2345', body: 'Dr. Meenakshi Rao is unavailable for the rest of this session. Reception will help you see another doctor.', eventType: 'SessionUnavailable', createdAt: ist('10:50'), sentAt: ist('10:50') }),
];

/** GET /admin/notifications with channel and status filters, newest first. */
export async function mockNotificationLog(page: Page, rows: unknown[] = NOTIFICATION_ROWS, opts: { fail?: boolean } = {}): Promise<{ requests: string[] }> {
  const requests: string[] = [];
  await page.route(/\/api\/admin\/notifications(\?.*)?$/, (route) => {
    const url = new URL(route.request().url());
    requests.push(url.search);
    if (opts.fail) return route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: { code: 'INTERNAL', message: 'x' } }) });
    const channel = url.searchParams.get('channel');
    const status = url.searchParams.get('status');
    const list = (rows as Array<{ channel: string; status: string; createdAt: string }>)
      .filter((r) => (!channel || r.channel === channel) && (!status || r.status === status))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(list) });
  });
  return { requests };
}
