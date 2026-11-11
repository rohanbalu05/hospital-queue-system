/* eslint-disable @typescript-eslint/no-non-null-assertion -- fixtures look up ids this file created */
import type { Page, Route } from '@playwright/test';

/**
 * Stateful /api mock for the live queue screens (W2): doctor console, display, My visit, session board.
 * Register it AFTER mockApi() (later routes win). The page clock is fixed to NOW so screenshots are stable.
 *
 * SSE is simulated by replacing window.EventSource before the app loads (installFakeEventSource), so specs can push
 * `queue` notices, drop the connection and bring it back deterministically. One spec also uses a real text/event-stream.
 */

/** 10:05 am IST on Wed 11 Nov 2026. */
export const NOW = new Date('2026-11-11T04:35:00Z');
const uuid = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;

export const SESSION_ID = uuid(0x5e51);
export const AFTERNOON_SESSION_ID = uuid(0x5e52);
export const DOCTOR_ID = uuid(0xd1);

type Group = 'A' | 'W';
type EntryState = 'waiting' | 'called' | 'in_service' | 'skipped' | 'absent' | 'completed';
type Reason = 'CLINICAL_PRIORITY' | 'AGING' | 'ROTATION' | 'NO_ALLOCATION';
type SessionStatus = 'scheduled' | 'open' | 'paused' | 'unavailable' | 'closed';

export interface MockEntry {
  id: string;
  visitId: string;
  sessionId: string;
  doctorId: string;
  patientId: string;
  patientName: string;
  token: string;
  group: Group;
  seq: number;
  state: EntryState;
  scheduledAt: string | null;
  checkedInAt: string;
  eligibleAt: string;
  priorityClass: number | null;
  priorityReason: string | null;
  calledAt: string | null;
  callCount: number;
  waitingMinutes: number | null;
  projectedPosition: number | null;
  version: number;
}

const istTime = (hhmm: string) => new Date(`2026-11-11T${hhmm}:00+05:30`).toISOString();
const minutesBefore = (iso: string) => Math.max(0, Math.floor((NOW.getTime() - new Date(iso).getTime()) / 60_000));

function makeEntry(n: number, group: Group, name: string, checkedIn: string, extra: Partial<MockEntry> = {}): MockEntry {
  const checkedInAt = istTime(checkedIn);
  return {
    id: uuid(0xe000 + n + (group === 'W' ? 0x100 : 0)),
    visitId: uuid(0xf000 + n + (group === 'W' ? 0x100 : 0)),
    sessionId: SESSION_ID,
    doctorId: DOCTOR_ID,
    patientId: uuid(0xa000 + n + (group === 'W' ? 0x100 : 0)),
    patientName: name,
    token: `${group}-${String(n).padStart(3, '0')}`,
    group,
    seq: n,
    state: 'waiting',
    scheduledAt: group === 'A' ? checkedInAt : null,
    checkedInAt,
    eligibleAt: checkedInAt,
    priorityClass: null,
    priorityReason: null,
    calledAt: null,
    callCount: 0,
    waitingMinutes: minutesBefore(checkedInAt),
    projectedPosition: null,
    version: 1,
    ...extra,
  };
}

/** Projected order under rotation A, A, W with the pointer on the 2nd A slot: A, W, A, A, W, A. */
function initialWaiting(): MockEntry[] {
  return [
    makeEntry(14, 'A', 'Harish Gowda', '09:32'),
    makeEntry(5, 'W', 'Rohan Deshpande', '09:48'),
    makeEntry(15, 'A', 'Lakshmi Narayanan', '09:40'),
    makeEntry(16, 'A', 'Ananya Iyer', '09:52'),
    makeEntry(6, 'W', 'Sneha Kulkarni', '09:58'),
    makeEntry(17, 'A', 'Imran Pasha', '10:01'),
  ];
}

const ROTATION: Group[] = ['A', 'A', 'W'];
const ORDINAL = ['1st', '2nd', '3rd'];
const GROUP_WORD: Record<Group, string> = { A: 'appointment', W: 'walk-in' };

function rotationExplanation(pointer: number): string {
  const letter = ROTATION[pointer % 3]!;
  const nth = ROTATION.slice(0, (pointer % 3) + 1).filter((g) => g === letter).length;
  return `Called by rotation: ${ORDINAL[nth - 1]} ${GROUP_WORD[letter]} of ${ROTATION.join(', ')}`;
}

export interface PatientViewState {
  state: EntryState;
  position: number | null;
  eta: Record<string, unknown>;
}

export const ETA_OK = {
  status: 'ok',
  lowMinutes: 25,
  highMinutes: 40,
  note: null,
  computedAt: NOW.toISOString(),
  estimatorMeanMinutes: 12,
  estimatorSamples: 3,
  uncertainty: 'cold_start',
};
export const ETA_WITHHELD = {
  status: 'withheld',
  lowMinutes: null,
  highMinutes: null,
  note: 'Doctor paused (unknown duration). Model estimate, not a measured confidence interval.',
  computedAt: NOW.toISOString(),
  estimatorMeanMinutes: 12,
  estimatorSamples: 3,
  uncertainty: null,
};

export interface DisplayColumnState {
  sessionId: string;
  doctorLabel: string;
  room: string;
  status: SessionStatus;
  nowCalling: string | null;
  next: string[];
  queueVersion: number;
}

export interface QueueMockOptions {
  /** Who GET /sessions/:id/queue answers for. */
  view?: 'staff' | 'patient';
  status?: SessionStatus;
  pauseUntil?: string | null;
  /** Make the queue endpoint fail with 500 (error state). */
  failQueue?: boolean;
  /** Delay the queue response in ms (loading state). */
  queueDelayMs?: number;
}

export interface QueueMock {
  /** Requests seen: "METHOD /path". */
  requests: Array<{ line: string; key: string | null; body: unknown }>;
  snapshotFetches: () => number;
  /** Direct access to the world for specs that change server state. */
  world: {
    version: number;
    status: SessionStatus;
    pauseUntil: string | null;
    active: MockEntry | null;
    waiting: MockEntry[];
    skipped: MockEntry[];
    completed: number;
    patient: PatientViewState;
    columns: DisplayColumnState[];
    failQueue: boolean;
    failDisplay: boolean;
    lastDecision: Record<string, unknown> | null;
  };
  /** Bump the server version and push a `queue` notice over the fake SSE stream. */
  publish(sessionId?: string): Promise<void>;
  /** Drop every open fake SSE connection and refuse new ones until reconnect(). */
  disconnect(): Promise<void>;
  reconnect(): Promise<void>;
}

/** Replace EventSource with a controllable fake. Call before page.goto(). */
export async function installFakeEventSource(page: Page): Promise<void> {
  await page.addInitScript(() => {
    type L = (ev: MessageEvent) => void;
    class FakeES {
      url: string;
      readyState = 0;
      onopen: ((e: Event) => void) | null = null;
      onerror: ((e: Event) => void) | null = null;
      closed = false;
      listeners: Record<string, L[]> = {};
      constructor(url: string) {
        this.url = url;
        const w = window as unknown as { __sse: { sources: FakeES[]; offline: boolean } };
        w.__sse.sources.push(this);
        setTimeout(() => {
          if (this.closed) return;
          if (w.__sse.offline) {
            this.readyState = 2;
            this.onerror?.(new Event('error'));
          } else {
            this.readyState = 1;
            this.onopen?.(new Event('open'));
          }
        }, 0);
      }
      addEventListener(t: string, l: L) {
        (this.listeners[t] ??= []).push(l);
      }
      close() {
        this.closed = true;
        this.readyState = 2;
      }
    }
    (window as unknown as { __sse: unknown }).__sse = { sources: [], offline: false };
    (window as unknown as { EventSource: unknown }).EventSource = FakeES;
  });
}

async function sseEmit(page: Page, match: string, name: string, data: unknown) {
  await page.evaluate(
    ([m, n, d]) => {
      const w = window as unknown as {
        __sse: { sources: Array<{ url: string; closed: boolean; listeners: Record<string, Array<(e: MessageEvent) => void>> }> };
      };
      for (const s of w.__sse.sources) {
        if (s.closed || !s.url.includes(m as string)) continue;
        for (const l of s.listeners[n as string] ?? []) l(new MessageEvent(n as string, { data: JSON.stringify(d) }));
      }
    },
    [match, name, data] as const,
  );
}

export async function mockQueue(page: Page, options: QueueMockOptions = {}): Promise<QueueMock> {
  await page.clock.setFixedTime(NOW);

  const world: QueueMock['world'] = {
    version: 7,
    status: options.status ?? 'open',
    pauseUntil: options.pauseUntil ?? null,
    active: null,
    waiting: initialWaiting(),
    skipped: [makeEntry(11, 'A', 'Geetha Murthy', '09:05', { state: 'skipped', callCount: 1, calledAt: istTime('09:50') })],
    completed: 9,
    patient: { state: 'waiting', position: 4, eta: ETA_OK },
    columns: [],
    failQueue: options.failQueue ?? false,
    failDisplay: false,
    lastDecision: null,
  };
  let pointer = 1;
  let fetches = 0;
  const requests: QueueMock['requests'] = [];

  const json = (route: Route, status: number, body: unknown) =>
    route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
  const err = (route: Route, status: number, code: string, message: string) => json(route, status, { error: { code, message } });

  const withPositions = (list: MockEntry[]) => list.map((e, i) => ({ ...e, projectedPosition: i + 1 }));

  const sessionObject = (id: string, status: SessionStatus, label: 'morning' | 'afternoon', starts: string, ends: string) => ({
    id,
    doctorId: DOCTOR_ID,
    doctorName: 'Dr. Meenakshi Rao',
    department: 'General Medicine',
    room: 'Room 12',
    sessionDate: '2026-11-11',
    label,
    startsAt: istTime(starts),
    endsAt: istTime(ends),
    slotMinutes: 12,
    status,
    policyVersion: 1,
    capacity: { bookedCapacity: 10, walkinCapacity: 5, bookedReserved: 8, walkinUsed: 2, bookedAvailable: 2, walkinAvailable: 3 },
    version: 1,
  });

  const staffSnapshot = () => ({
    view: 'staff' as const,
    sessionId: SESSION_ID,
    doctorId: DOCTOR_ID,
    status: world.status,
    pauseUntil: world.pauseUntil,
    policyVersion: 1,
    rotationPointer: pointer % 3,
    rotation: ROTATION,
    queueVersion: world.version,
    capturedAt: NOW.toISOString(),
    active: world.active,
    waiting: withPositions(world.waiting),
    skipped: world.skipped,
    completedCount: world.completed,
    lastDecision: world.lastDecision,
    capacity: { bookedCapacity: 10, walkinCapacity: 5, bookedReserved: 8, walkinUsed: 2 },
  });

  const calledToken = () => (world.active?.state === 'called' ? world.active.token : null);
  const myColumn = (): DisplayColumnState => ({
    sessionId: SESSION_ID,
    doctorLabel: 'Dr. Meenakshi Rao, General Medicine',
    room: 'Room 12',
    status: world.status,
    nowCalling: calledToken(),
    next: world.waiting.slice(0, 3).map((e) => e.token),
    queueVersion: world.version,
  });
  const otherColumns = (): DisplayColumnState[] =>
    world.columns.length > 0
      ? world.columns
      : [
          { sessionId: uuid(0x5e61), doctorLabel: 'Dr. Arvind Kulkarni, Paediatrics', room: 'Room 4', status: 'open', nowCalling: 'A-022', next: ['A-023', 'W-009', 'A-024'], queueVersion: 12 },
          { sessionId: uuid(0x5e62), doctorLabel: 'Dr. Farah Siddiqui, ENT', room: 'Room 7', status: 'open', nowCalling: 'W-011', next: ['A-031', 'A-032', 'W-012'], queueVersion: 5 },
          { sessionId: uuid(0x5e63), doctorLabel: 'Dr. Suresh Gowda, Orthopaedics', room: 'Room 9', status: 'paused', nowCalling: null, next: ['A-008', 'A-009'], queueVersion: 3 },
        ];
  const displaySnapshot = () => ({
    view: 'display' as const,
    capturedAt: NOW.toISOString(),
    columns: [myColumn(), ...otherColumns()],
  });

  const decide = (entry: MockEntry | null, reason: Reason, explanation: string) => {
    world.version += 1;
    world.lastDecision = {
      id: uuid(0xdec0 + world.version),
      sessionId: SESSION_ID,
      doctorId: DOCTOR_ID,
      queueEntryId: entry?.id ?? null,
      token: entry?.token ?? null,
      reason,
      rotationSlot: reason === 'ROTATION' ? pointer % 3 : null,
      pointerBefore: pointer % 3,
      pointerAfter: reason === 'ROTATION' ? (pointer + 1) % 3 : pointer % 3,
      policyVersion: 1,
      queueVersion: world.version,
      explanation,
      decidedAt: NOW.toISOString(),
      decidedBy: uuid(0x03),
    };
    return world.lastDecision;
  };

  const find = (id: string) =>
    [world.active, ...world.waiting, ...world.skipped].find((e): e is MockEntry => e !== null && e.id === id) ?? null;

  const mock: QueueMock = {
    requests,
    snapshotFetches: () => fetches,
    world,
    async publish(sessionId = SESSION_ID) {
      world.version += 1;
      try {
        await sseEmit(page, '/events', 'queue', {
          sessionId,
          queueVersion: world.version,
          eventType: 'queue.changed',
          committedAt: NOW.toISOString(),
        });
      } catch {
        // page closed or navigating
      }
    },
    async disconnect() {
      await page.evaluate(() => {
        const w = window as unknown as { __sse: { offline: boolean; sources: Array<{ closed: boolean; readyState: number; onerror: ((e: Event) => void) | null }> } };
        w.__sse.offline = true;
        for (const s of w.__sse.sources) if (!s.closed) { s.readyState = 2; s.onerror?.(new Event('error')); }
      });
    },
    async reconnect() {
      await page.evaluate(() => {
        (window as unknown as { __sse: { offline: boolean } }).__sse.offline = false;
      });
    },
  };

  await page.route(
    (url) => url.pathname.startsWith('/api/'),
    async (route) => {
      const req = route.request();
      const url = new URL(req.url());
      const path = url.pathname.replace(/^\/api/, '');
      const method = req.method();
      const body = method === 'POST' ? (req.postDataJSON?.() ?? null) : null;
      const note = () => requests.push({ line: `${method} ${path}`, key: req.headers()['idempotency-key'] ?? null, body });
      const done = async (status: number, payload: unknown) => {
        await json(route, status, payload);
        await mock.publish();
      };

      if (method === 'GET' && path === '/sessions') {
        note();
        return json(route, 200, [
          sessionObject(SESSION_ID, world.status, 'morning', '09:00', '13:00'),
          sessionObject(AFTERNOON_SESSION_ID, 'scheduled', 'afternoon', '14:00', '17:00'),
        ]);
      }
      if (method === 'GET' && path === `/sessions/${SESSION_ID}/queue`) {
        note();
        fetches += 1;
        if (options.queueDelayMs) await new Promise((r) => setTimeout(r, options.queueDelayMs));
        if (world.failQueue) return err(route, 500, 'INTERNAL', 'The queue service is not answering.');
        if ((options.view ?? 'staff') === 'patient') {
          return json(route, 200, {
            view: 'patient',
            sessionId: SESSION_ID,
            status: world.status,
            queueVersion: world.version,
            capturedAt: NOW.toISOString(),
            myEntry: {
              queueEntryId: uuid(0xe010),
              token: 'A-016',
              group: 'A',
              state: world.patient.state,
              position: world.patient.position,
              eta: world.patient.eta,
            },
            nowCalling: calledToken() ?? 'A-013',
          });
        }
        return json(route, 200, staffSnapshot());
      }
      if (method === 'GET' && path.startsWith('/sessions/') && path.endsWith('/queue')) {
        note();
        return json(route, 200, { ...staffSnapshot(), sessionId: AFTERNOON_SESSION_ID, status: 'scheduled', active: null, waiting: [], skipped: [], completedCount: 0 });
      }
      if (method === 'GET' && path === '/display/sessions') {
        note();
        if (world.failDisplay) return err(route, 500, 'INTERNAL', 'Display feed is down.');
        return json(route, 200, displaySnapshot());
      }

      if (method === 'POST' && path === `/sessions/${SESSION_ID}/call-next`) {
        note();
        if (world.status !== 'open') return err(route, 409, 'SESSION_NOT_CALLABLE', 'This session is paused or closed.');
        if (world.active) return err(route, 409, 'DOCTOR_OCCUPIED', 'You already have a patient called or in service.');
        const next = world.waiting.shift() ?? null;
        if (!next) {
          const d = decide(null, 'NO_ALLOCATION', 'No one is waiting');
          return done(200, { decision: d, entry: null });
        }
        const priority = next.priorityClass !== null;
        const aging = !priority && (next.waitingMinutes ?? 0) >= 45;
        const reason: Reason = priority ? 'CLINICAL_PRIORITY' : aging ? 'AGING' : 'ROTATION';
        const explanation = priority
          ? `Clinical priority (class ${next.priorityClass})`
          : aging
            ? `Aging: waited ${next.waitingMinutes} min`
            : rotationExplanation(pointer);
        const d = decide(next, reason, explanation);
        if (reason === 'ROTATION') pointer += 1;
        next.state = 'called';
        next.calledAt = NOW.toISOString();
        next.callCount += 1;
        next.waitingMinutes = null;
        next.version += 1;
        world.active = next;
        return done(200, { decision: d, entry: next });
      }
      const visitMatch = /^\/visits\/([^/]+)\/(start|complete)$/.exec(path);
      if (method === 'POST' && visitMatch) {
        note();
        const a = world.active;
        if (!a || a.visitId !== visitMatch[1]) return err(route, 409, 'INVALID_TRANSITION', 'That visit is not the active one.');
        if (visitMatch[2] === 'start') {
          a.state = 'in_service';
          a.version += 1;
        } else {
          world.active = null;
          world.completed += 1;
        }
        world.version += 1;
        return done(200, {});
      }
      const entryMatch = /^\/queue-entries\/([^/]+)\/(skip|re-enter|absent|priority)$/.exec(path);
      if (method === 'POST' && entryMatch) {
        note();
        const e = find(entryMatch[1]!);
        if (!e) return err(route, 404, 'NOT_FOUND', 'That entry is no longer in the queue.');
        const action = entryMatch[2];
        if (action === 'skip') {
          world.active = null;
          e.state = 'skipped';
          world.skipped.unshift(e);
        } else if (action === 're-enter') {
          world.skipped = world.skipped.filter((s) => s.id !== e.id);
          e.state = 'waiting';
          world.waiting.push(e);
        } else if (action === 'absent') {
          world.waiting = world.waiting.filter((s) => s.id !== e.id);
          e.state = 'absent';
          world.skipped.unshift(e);
        } else {
          const b = body as { priorityClass: number | null; reason: string };
          e.priorityClass = b.priorityClass;
          e.priorityReason = b.priorityClass === null ? null : b.reason;
          world.waiting.sort((x, y) => (x.priorityClass ?? 99) - (y.priorityClass ?? 99));
        }
        e.version += 1;
        return done(200, {});
      }
      if (method === 'POST' && path === `/sessions/${SESSION_ID}/pause`) {
        note();
        world.status = 'paused';
        world.pauseUntil = (body as { until?: string } | null)?.until ?? null;
        return done(200, {});
      }
      if (method === 'POST' && path === `/sessions/${SESSION_ID}/resume`) {
        note();
        world.status = 'open';
        world.pauseUntil = null;
        return done(200, {});
      }
      if (method === 'POST' && path === `/sessions/${SESSION_ID}/unavailable`) {
        note();
        world.status = 'unavailable';
        return done(200, {});
      }
      return route.fallback();
    },
  );

  return mock;
}
