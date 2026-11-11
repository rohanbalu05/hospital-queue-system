/* eslint-disable @typescript-eslint/no-non-null-assertion -- fixtures look up ids this file created */
import type { Page, Route } from '@playwright/test';
import { DOCTORS, ME_PATIENT_ID, NOW, type SchedulingMock } from './scheduling-mocks';
import { SESSION_ID as QUEUE_SESSION_ID } from './mocks-queue';

/**
 * Stateful /api mock for the Wave 3 screens: follow-up tasks, documents and review, the bounded assistant,
 * admin (capacity, staff, policy, reports, audit). Register it AFTER mockApi() and mockScheduling(): later routes win.
 * All people and numbers are fixtures for screenshots, not measurements. The page clock is fixed to NOW (10:05 am IST).
 */

const uuid = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const ist = (date: string, hhmm: string) => `${date}T${hhmm}:00+05:30`;
const D1 = DOCTORS[0]!;
const D3 = DOCTORS[2]!;
const D4 = DOCTORS[3]!;

export const FOLLOWUP_USER = { id: uuid(4), name: 'Sunita Hegde' };
export const DOCTOR_USER = { id: uuid(3), name: 'Dr. Meenakshi Rao' };
const OTHER_STAFF = { id: uuid(0x44), name: 'Rakesh Pai' };

const patientId = (n: number) => (n === 1 ? ME_PATIENT_ID : uuid(0xa000 + n));
export const PATIENT_NAMES: Record<string, string> = {
  [patientId(1)]: 'Ananya Iyer',
  [patientId(2)]: 'Harish Gowda',
  [patientId(3)]: 'Lakshmi Narayanan',
  [patientId(4)]: 'Sneha Kulkarni',
  [patientId(5)]: 'Rohan Deshpande',
  [patientId(6)]: 'Fatima Begum',
  [patientId(8)]: 'Gopal Krishnan',
};

type Json = Record<string, unknown>;

export interface TaskRow extends Json {
  id: string;
  patientId: string;
  patientName: string;
  sourceVisitId: string | null;
  sourceMessageId: string | null;
  kind: string;
  title: string;
  detail: string | null;
  ownerId: string | null;
  ownerName: string | null;
  status: 'open' | 'acknowledged' | 'resolved' | 'cancelled';
  dueAt: string;
  overdue: boolean;
  acknowledgedAt: string | null;
  disposition: string | null;
  outcomeNote: string | null;
  resolvedAt: string | null;
  returnAppointmentId: string | null;
  version: number;
  createdAt: string;
  sourceVisit?: { sessionDate: string; doctorId: string; doctorName: string; department: string } | null;
}

export interface DocRow extends Json {
  id: string;
  patientId: string;
  visitId: string | null;
  originalName: string;
  mimeType: string;
  sizeBytes: number;
  pageCount: number;
  status: 'uploaded' | 'accepted' | 'processing' | 'ocr_ready' | 'ocr_failed' | 'verified' | 'rejected';
  ocrAttempts: number;
  lastError: string | null;
  version: number;
  createdAt: string;
}

export interface VersionRow extends Json {
  id: string;
  instructionId: string;
  patientId: string;
  version: number;
  title: string;
  body: string;
  status: 'current' | 'superseded';
  verifiedBy: string;
  verifiedByName: string;
  verifiedAt: string;
  supersedesId: string | null;
  sourceDraftId: string | null;
}

export interface MessageRow extends Json {
  id: string;
  role: 'patient' | 'assistant';
  body: string;
  outcome: 'answered' | 'escalated' | 'refused' | null;
  citations: Array<{ instructionVersionId: string; title: string; version: number }>;
  escalationTaskId: string | null;
  createdAt: string;
}

export const CONVERSATION_ID = uuid(0x7b00);
export const INSTRUCTION_V1 = uuid(0x7f01);
export const INSTRUCTION_V2 = uuid(0x7f02);

export interface Wave3Mock {
  tasks: TaskRow[];
  documents: DocRow[];
  versions: VersionRow[];
  messages: MessageRow[];
  requests: Array<{ line: string; key: string | null; body: unknown }>;
  /** Make the next return-booking fail with 409 CAPACITY_FULL. */
  failReturnBookingFull: boolean;
  /** Hold GET /follow-up-tasks for this many ms (loading skeleton shots). */
  delayTasksMs: number;
  /** Answer every list with an empty array (empty-state shots). */
  empty: boolean;
  /** Make every Wave 3 GET fail with 503 (error-state shots). */
  failReads: boolean;
  /** Whether the patient already has an assistant conversation (false: the first question starts one). */
  hasConversation: boolean;
}

function buildTasks(): TaskRow[] {
  const base = (n: number, p: number, over: Partial<TaskRow>): TaskRow => ({
    id: uuid(0x7a00 + n),
    patientId: patientId(p),
    patientName: PATIENT_NAMES[patientId(p)]!,
    sourceVisitId: uuid(0xf000 + n),
    sourceMessageId: null,
    kind: 'post_visit',
    title: '',
    detail: null,
    ownerId: null,
    ownerName: null,
    status: 'open',
    dueAt: ist('2026-11-11', '14:00'),
    overdue: false,
    acknowledgedAt: null,
    disposition: null,
    outcomeNote: null,
    resolvedAt: null,
    returnAppointmentId: null,
    version: 1,
    createdAt: ist('2026-11-09', '12:10'),
    sourceVisit: null,
    ...over,
  });
  const me = { ownerId: FOLLOWUP_USER.id, ownerName: FOLLOWUP_USER.name };
  return [
    base(1, 2, {
      title: 'Check recovery after fever visit',
      detail: 'Dr. Rao asked for a call two days after the visit. Ask about fever, appetite and whether the antibiotic course is complete. If the fever has returned, book a return visit this week.',
      ...me,
      status: 'acknowledged',
      acknowledgedAt: ist('2026-11-10', '10:20'),
      dueAt: ist('2026-11-10', '17:00'),
      overdue: true,
      version: 2,
      sourceVisit: { sessionDate: '2026-11-04', doctorId: D1.id, doctorName: D1.fullName, department: D1.department },
    }),
    base(8, 8, {
      kind: 'assistant_escalation',
      title: 'Question: can the knee brace be worn in bed?',
      detail: 'Patient asked through the assistant: "Can I keep the knee brace on while I sleep?" The verified instruction does not say. Needs the orthopaedics team.',
      sourceMessageId: uuid(0x7b08),
      dueAt: ist('2026-11-11', '09:30'),
      overdue: true,
      sourceVisit: { sessionDate: '2026-11-03', doctorId: D4.id, doctorName: D4.fullName, department: D4.department },
    }),
    base(2, 1, {
      kind: 'assistant_escalation',
      title: 'Question: can ibuprofen be taken with paracetamol?',
      detail: 'Patient asked through the assistant: "Can I take ibuprofen along with the paracetamol?" No verified instruction covers this.',
      sourceMessageId: uuid(0x7b04),
      dueAt: ist('2026-11-11', '14:00'),
      sourceVisit: { sessionDate: '2026-11-04', doctorId: D1.id, doctorName: D1.fullName, department: D1.department },
    }),
    base(3, 3, {
      title: 'Call about home blood pressure readings',
      detail: 'Patient to read out morning and evening BP for the last 3 days. Escalate to Dr. Rao if any reading is above 160/100.',
      ...me,
      dueAt: ist('2026-11-11', '16:00'),
      sourceVisit: { sessionDate: '2026-11-05', doctorId: D1.id, doctorName: D1.fullName, department: D1.department },
    }),
    base(4, 5, {
      kind: 'document_review',
      title: 'Prescription photo could not be read',
      detail: 'OCR failed twice. Ask the patient to upload a clearer photo, or forward to the doctor for manual transcription.',
      ...me,
      status: 'acknowledged',
      acknowledgedAt: ist('2026-11-11', '09:10'),
      dueAt: ist('2026-11-12', '12:00'),
      version: 2,
      sourceVisit: { sessionDate: '2026-11-09', doctorId: D3.id, doctorName: D3.fullName, department: D3.department },
    }),
    base(9, 4, {
      title: 'Dressing change reminder',
      detail: 'Remind the patient to bring the dressing pack on the next visit.',
      ownerId: OTHER_STAFF.id,
      ownerName: OTHER_STAFF.name,
      status: 'acknowledged',
      acknowledgedAt: ist('2026-11-11', '08:50'),
      dueAt: ist('2026-11-11', '12:00'),
      version: 2,
      sourceVisit: { sessionDate: '2026-11-10', doctorId: D4.id, doctorName: D4.fullName, department: D4.department },
    }),
    base(5, 4, {
      title: 'Post-visit check, Dermatology',
      ...me,
      status: 'resolved',
      acknowledgedAt: ist('2026-11-08', '11:00'),
      disposition: 'advice_given',
      outcomeNote: 'Reached the patient. Rash is settling. Advised to continue the cream for 7 days.',
      resolvedAt: ist('2026-11-09', '15:40'),
      dueAt: ist('2026-11-09', '17:00'),
      version: 3,
    }),
    base(6, 6, {
      kind: 'return_visit',
      title: 'Arrange return visit in 2 weeks',
      detail: 'Dr. Rao wants a review of the thyroid profile in two weeks. Book a morning session if possible.',
      dueAt: ist('2026-11-12', '11:00'),
      sourceVisit: { sessionDate: '2026-11-10', doctorId: D1.id, doctorName: D1.fullName, department: D1.department },
    }),
    base(7, 1, {
      title: 'Post-visit check, General Medicine',
      status: 'resolved',
      ownerId: OTHER_STAFF.id,
      ownerName: OTHER_STAFF.name,
      acknowledgedAt: ist('2026-11-05', '10:30'),
      disposition: 'advice_given',
      outcomeNote: 'Called and confirmed she is recovering. Internal: patient asked about work letter.',
      resolvedAt: ist('2026-11-06', '11:15'),
      dueAt: ist('2026-11-06', '17:00'),
      version: 3,
      sourceVisit: { sessionDate: '2026-11-04', doctorId: D1.id, doctorName: D1.fullName, department: D1.department },
    }),
  ];
}

function buildDocuments(): DocRow[] {
  const d = (n: number, p: number, name: string, mime: string, size: number, pages: number, status: DocRow['status'], at: string, extra: Partial<DocRow> = {}): DocRow => ({
    id: uuid(0x7d00 + n),
    patientId: patientId(p),
    visitId: null,
    originalName: name,
    mimeType: mime,
    sizeBytes: size,
    pageCount: pages,
    status,
    ocrAttempts: status === 'ocr_failed' ? 2 : 1,
    lastError: null,
    version: 2,
    createdAt: at,
    ...extra,
  });
  return [
    d(1, 1, 'discharge-summary-4-nov.pdf', 'application/pdf', 412_000, 2, 'verified', ist('2026-11-04', '16:20')),
    d(2, 1, 'prescription-photo.jpg', 'image/jpeg', 2_300_000, 1, 'ocr_ready', ist('2026-11-10', '18:05')),
    d(3, 1, 'blood-report-nov.png', 'image/png', 880_000, 1, 'processing', ist('2026-11-11', '09:58')),
    d(4, 1, 'old-scan.jpg', 'image/jpeg', 1_100_000, 1, 'ocr_failed', ist('2026-11-09', '12:30'), { lastError: 'The image is too dark to read text from.' }),
    d(5, 2, 'prescription-4-nov.pdf', 'application/pdf', 640_000, 2, 'ocr_ready', ist('2026-11-10', '11:12')),
    d(6, 3, 'handwritten-advice.jpg', 'image/jpeg', 3_900_000, 1, 'ocr_failed', ist('2026-11-10', '14:44'), { lastError: 'The handwriting could not be read with enough confidence.' }),
  ];
}

const DRAFTS: Record<string, string> = {
  [uuid(0x7d02)]: `Fever and throat infection: home care
Tab. Cefixime 200 mg: 1 tablet twice a day after food for 5 days.
Tab. Paracetamol 650 mg: 1 tablet if temperature is above 100 F. No more than 3 tablets in a day.
Drink plenty of water and rest. Warm salt-water gargles 3 times a day.
Review after 5 days, or earlier if the fever lasts more than 48 hours.`,
  [uuid(0x7d05)]: `Back pain: exercises and rest
Avoid lifting more than 5 kg for 2 weeks.
Tab. Etoricoxib 60 mg: once a day after food for 5 days.
Do the cat-camel stretch 10 times, morning and evening.
Come back if there is numbness in the leg.`,
};

export async function mockWave3(page: Page, sched: SchedulingMock, _role: 'followup' | 'doctor' | 'patient' | 'admin' | 'reception' = 'followup'): Promise<Wave3Mock> {
  const tasks = buildTasks();
  const documents = buildDocuments();
  const versions: VersionRow[] = [
    {
      id: INSTRUCTION_V1,
      instructionId: uuid(0x7e01),
      patientId: ME_PATIENT_ID,
      version: 1,
      title: 'Care after viral fever',
      body: 'Paracetamol 650 mg when the temperature is above 100 F. No more than 3 tablets in a day.',
      status: 'superseded',
      verifiedBy: DOCTOR_USER.id,
      verifiedByName: DOCTOR_USER.name,
      verifiedAt: ist('2026-11-04', '17:10'),
      supersedesId: null,
      sourceDraftId: null,
    },
    {
      id: INSTRUCTION_V2,
      instructionId: uuid(0x7e01),
      patientId: ME_PATIENT_ID,
      version: 2,
      title: 'Care after viral fever',
      body: 'Paracetamol 650 mg when the temperature is above 100 F. No more than 3 tablets in a day.\nDrink plenty of water and rest for 3 days.\nCome back if the fever lasts more than 48 hours.',
      status: 'current',
      verifiedBy: DOCTOR_USER.id,
      verifiedByName: DOCTOR_USER.name,
      verifiedAt: ist('2026-11-09', '12:40'),
      supersedesId: INSTRUCTION_V1,
      sourceDraftId: null,
    },
  ];
  const cite = [{ instructionVersionId: INSTRUCTION_V2, title: 'Care after viral fever', version: 2 }];
  const messages: MessageRow[] = [
    { id: uuid(0x7b01), role: 'patient', body: 'How many paracetamol tablets can I take in a day?', outcome: null, citations: [], escalationTaskId: null, createdAt: ist('2026-11-11', '09:12') },
    {
      id: uuid(0x7b02),
      role: 'assistant',
      body: 'You can take 1 tablet of Paracetamol 650 mg when your temperature is above 100 F, and no more than 3 tablets in a day.',
      outcome: 'answered',
      citations: cite,
      escalationTaskId: null,
      createdAt: ist('2026-11-11', '09:12'),
    },
    { id: uuid(0x7b03), role: 'patient', body: 'Can I take ibuprofen along with the paracetamol?', outcome: null, citations: [], escalationTaskId: null, createdAt: ist('2026-11-11', '09:14') },
    {
      id: uuid(0x7b04),
      role: 'assistant',
      body: 'Sent to the follow-up team.',
      outcome: 'escalated',
      citations: [],
      escalationTaskId: uuid(0x7a02),
      createdAt: ist('2026-11-11', '09:14'),
    },
  ];

  const m: Wave3Mock = { tasks, documents, versions, messages, requests: [], failReturnBookingFull: false, delayTasksMs: 0, empty: false, failReads: false, hasConversation: true };

  const json = (route: Route, status: number, body: unknown) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
  const error = (route: Route, status: number, code: string, message: string, details?: unknown) =>
    json(route, status, { error: { code, message, ...(details !== undefined ? { details } : {}) } });

  const nameOfPatient = (id: string) => PATIENT_NAMES[id] ?? 'Unknown patient';
  const withOverdue = (t: TaskRow): TaskRow => ({
    ...t,
    overdue: (t.status === 'open' || t.status === 'acknowledged') && new Date(t.dueAt).getTime() < NOW.getTime(),
  });

  // ---- admin fixtures -------------------------------------------------------------------------------------
  const staff = [
    { userId: uuid(2), displayName: 'Deepa Nair', role: 'reception', doctorIds: [D1.id, DOCTORS[1]!.id] },
    { userId: FOLLOWUP_USER.id, displayName: FOLLOWUP_USER.name, role: 'followup', doctorIds: [D1.id, D3.id, D4.id] },
    { userId: OTHER_STAFF.id, displayName: OTHER_STAFF.name, role: 'followup', doctorIds: [D1.id] },
    { userId: uuid(0x45), displayName: 'Lata Menon', role: 'reception', doctorIds: [D4.id, DOCTORS[4]!.id] },
  ];
  const audit = [
    ['09:58:14', 'queue.call_next', 'queue_entry', 0xe014, 'doctor', 3, 'Called by rotation: 2nd appointment of A, A, W', 1],
    ['09:57:02', 'arrival.check_in', 'visit', 0xf014, 'reception', 2, null, 1],
    ['09:41:37', 'queue.call_next', 'queue_entry', 0xe013, 'doctor', 3, 'Aging: waited 47 min', 1],
    ['09:36:20', 'queue.priority_set', 'queue_entry', 0xe015, 'doctor', 3, 'Breathlessness at triage', 1],
    ['09:30:05', 'followup.acknowledge', 'follow_up_task', 0x7a01, 'followup', 4, null, null],
    ['09:12:44', 'assistant.escalate', 'follow_up_task', 0x7a02, 'patient', 5, 'No verified instruction covers this', null],
    ['09:02:10', 'session.capacity_update', 'session', 0x10000, 'admin', 1, 'Raised walk-in places from 4 to 5', 1],
    ['08:55:31', 'instruction.verify', 'instruction', 0x7e01, 'doctor', 3, 'Version 2 supersedes version 1', null],
    ['08:40:18', 'appointment.book', 'appointment', 0xb014, 'patient', 5, null, 1],
    ['08:12:03', 'policy.activate', 'policy', 0x70, 'admin', 1, 'Initial policy', 1],
  ].map(([t, op, type, id, actorRole, actor, reason, pv], i) => ({
    id: 100 - i,
    occurredAt: ist('2026-11-11', String(t).slice(0, 5)).replace(':00+', `:${String(t).slice(6, 8)}+`),
    actorId: uuid(actor as number),
    actorRole,
    operation: op,
    entityType: type,
    entityId: uuid(id as number),
    previous: null,
    next: null,
    reason,
    policyVersion: pv,
    correlationId: `c-${i}`,
  }));

  const reserved = (s: SchedulingMock['sessions'][number]) => {
    const explicit = sched.appointments.filter((a) => a.sessionId === s.id && ['booked', 'checked_in', 'completed', 'missed'].includes(a.status)).length;
    return Math.min(s.bookedCapacity, s.baseBooked + explicit);
  };

  const report = {
    from: '2026-11-05',
    to: '2026-11-11',
    generatedAt: NOW.toISOString(),
    throughput: { completedVisits: 214, sessions: 38 },
    waitsByGroup: [
      { group: 'A', medianMinutes: 14, p95Minutes: 41.5, n: 131 },
      { group: 'W', medianMinutes: 22, p95Minutes: 63, n: 79 },
      { group: 'P', medianMinutes: 6, p95Minutes: 12, n: 4 },
      { group: 'all', medianMinutes: 17, p95Minutes: 52, n: 214 },
    ],
    decisionsByReason: [
      { reason: 'ROTATION', count: 168 },
      { reason: 'AGING', count: 21 },
      { reason: 'CLINICAL_PRIORITY', count: 4 },
      { reason: 'NO_ALLOCATION', count: 12 },
    ],
    metrics: [
      { name: 'Capacity oversubscriptions', unit: 'count', kind: 'measured', value: 0, sampleSize: 38, note: 'Sessions checked in this period' },
      { name: 'Capacity oversubscriptions', unit: 'count', kind: 'target', value: 0, sampleSize: null, note: 'NFR-03' },
      { name: 'API latency, 95th percentile', unit: 'ms', kind: 'measured', value: null, sampleSize: null, note: 'No load test has been run yet' },
      { name: 'API latency, 95th percentile', unit: 'ms', kind: 'target', value: 500, sampleSize: null, note: 'NFR-01, ordinary requests' },
      { name: 'Queue freshness, 95th percentile', unit: 's', kind: 'measured', value: null, sampleSize: null, note: 'Needs the 200-client run' },
      { name: 'Queue freshness, 95th percentile', unit: 's', kind: 'target', value: 5, sampleSize: null, note: 'NFR-02' },
      { name: 'Unexpected server errors', unit: '%', kind: 'target', value: 1, sampleSize: null, note: 'NFR-02, below this value' },
    ],
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

      const w3Read =
        path.startsWith('/follow-up-tasks') ||
        path === '/me/follow-ups' ||
        path.startsWith('/documents') ||
        path === '/review-inbox' ||
        path === '/instructions' ||
        path.startsWith('/assistant') ||
        path.startsWith('/reports') ||
        path === '/audit' ||
        path.startsWith('/admin/') ||
        path.startsWith('/policies');
      if (method === 'GET' && w3Read && m.failReads) return route.fulfill({ status: 503, body: '' });

      // ---- follow-up tasks ------------------------------------------------------------------------------
      if (method === 'GET' && path === '/follow-up-tasks') {
        if (m.delayTasksMs) await new Promise((r) => setTimeout(r, m.delayTasksMs));
        if (m.empty) return json(route, 200, []);
        const owner = q.get('owner') ?? 'me';
        const pid = q.get('patientId');
        let list = tasks.map(withOverdue);
        if (pid) list = list.filter((t) => t.patientId === pid);
        else if (owner === 'me') list = list.filter((t) => t.ownerId === FOLLOWUP_USER.id);
        else if (owner === 'unassigned') list = list.filter((t) => t.ownerId === null);
        if (q.get('status')) list = list.filter((t) => t.status === q.get('status'));
        return json(route, 200, list);
      }
      // Patients read their own tasks as PatientFollowUp: fixed summary per kind, no staff title, detail, notes or owner.
      if (method === 'GET' && path === '/me/follow-ups') {
        if (m.delayTasksMs) await new Promise((r) => setTimeout(r, m.delayTasksMs));
        if (m.empty) return json(route, 200, []);
        const SUMMARY: Record<string, string> = {
          post_visit: 'Check-in after your visit',
          assistant_escalation: 'Your question for the follow-up team',
          document_review: 'Review of your uploaded document',
          return_visit: 'Return visit to arrange',
        };
        return json(
          route,
          200,
          tasks
            .filter((t) => t.patientId === ME_PATIENT_ID)
            .map(withOverdue)
            .map((t) => ({
              id: t.id,
              kind: t.kind,
              summary: SUMMARY[t.kind] ?? 'Follow-up',
              status: t.status,
              dueAt: t.dueAt,
              disposition: t.disposition,
              returnAppointmentId: t.returnAppointmentId,
              createdAt: t.createdAt,
              resolvedAt: t.resolvedAt,
            })),
        );
      }
      const taskMatch = path.match(/^\/follow-up-tasks\/([^/]+)(?:\/(acknowledge|resolve|cancel|return-booking))?$/);
      if (taskMatch) {
        const t = tasks.find((x) => x.id === taskMatch[1]);
        const action = taskMatch[2];
        if (!t) return error(route, 404, 'NOT_FOUND', 'Task not found.');
        if (method === 'GET' && !action) return json(route, 200, withOverdue(t));
        if (method === 'POST' && action) {
          note();
          const b = (body ?? {}) as Json;
          if (b.expectedVersion !== undefined && b.expectedVersion !== t.version) return error(route, 409, 'CONFLICT', 'This task was changed by someone else.');
          if (action === 'acknowledge') {
            if (t.status !== 'open') return error(route, 409, 'INVALID_TRANSITION', 'This task has already been acknowledged.');
            t.status = 'acknowledged';
            t.ownerId = t.ownerId ?? FOLLOWUP_USER.id;
            t.ownerName = t.ownerName ?? FOLLOWUP_USER.name;
            t.acknowledgedAt = NOW.toISOString();
            t.version += 1;
            return json(route, 200, withOverdue(t));
          }
          if (action === 'resolve') {
            if (b.disposition === 'return_booked' && !b.returnAppointmentId) return error(route, 400, 'VALIDATION_FAILED', 'A return appointment is required.');
            t.status = 'resolved';
            t.disposition = b.disposition as string;
            t.outcomeNote = b.outcomeNote as string;
            t.returnAppointmentId = (b.returnAppointmentId as string | undefined) ?? t.returnAppointmentId;
            t.resolvedAt = NOW.toISOString();
            t.version += 1;
            return json(route, 200, withOverdue(t));
          }
          if (action === 'cancel') {
            t.status = 'cancelled';
            t.outcomeNote = b.reason as string;
            t.resolvedAt = NOW.toISOString();
            t.version += 1;
            return json(route, 200, withOverdue(t));
          }
          if (action === 'return-booking') {
            const s = sched.sessions.find((x) => x.id === (b.sessionId as string));
            if (!s) return error(route, 404, 'NOT_FOUND', 'Session not found.');
            if (m.failReturnBookingFull || reserved(s) >= s.bookedCapacity) {
              m.failReturnBookingFull = false;
              s.baseBooked = s.bookedCapacity;
              return error(route, 409, 'CAPACITY_FULL', 'The last booked place in this session was just taken.');
            }
            const appt = {
              id: uuid(0xb900 + sched.appointments.length),
              patientId: t.patientId,
              sessionId: s.id,
              doctorId: s.doctorId,
              doctorName: s.doctorName,
              department: s.department,
              scheduledAt: new Date(new Date(s.startsAt).getTime() + 40 * 60_000).toISOString(),
              status: 'booked' as const,
              rescheduledFromId: null,
              followUpTaskId: t.id,
              version: 1,
              createdAt: NOW.toISOString(),
              patientName: nameOfPatient(t.patientId),
            };
            sched.appointments.push(appt);
            t.returnAppointmentId = appt.id;
            return json(route, 201, appt);
          }
        }
      }

      // ---- documents ------------------------------------------------------------------------------------
      if (method === 'GET' && path === '/documents') {
        if (m.empty) return json(route, 200, []);
        const pid = q.get('patientId');
        return json(route, 200, documents.filter((d) => !pid || d.patientId === pid));
      }
      if (method === 'POST' && path === '/documents') {
        note();
        const raw = req.postDataBuffer()?.toString('latin1') ?? '';
        const name = /filename="([^"]+)"/.exec(raw)?.[1] ?? 'upload.pdf';
        if (name.includes('too-many-pages')) return error(route, 400, 'UPLOAD_TOO_MANY_PAGES', 'The document has 14 pages. The limit is 10.');
        const doc: DocRow = {
          id: uuid(0x7d80 + documents.length),
          patientId: ME_PATIENT_ID,
          visitId: null,
          originalName: name,
          mimeType: name.endsWith('.png') ? 'image/png' : name.endsWith('.pdf') ? 'application/pdf' : 'image/jpeg',
          sizeBytes: Math.max(raw.length, 1000),
          pageCount: 1,
          status: 'uploaded',
          ocrAttempts: 0,
          lastError: null,
          version: 1,
          createdAt: NOW.toISOString(),
        };
        documents.unshift(doc);
        return json(route, 201, doc);
      }
      if (method === 'GET' && path === '/review-inbox') {
        if (m.empty) return json(route, 200, []);
        return json(
          route,
          200,
          documents.filter((d) => d.status === 'ocr_ready' || d.status === 'ocr_failed').map((d) => ({ ...d, patientName: nameOfPatient(d.patientId) })),
        );
      }
      const draftsMatch = path.match(/^\/documents\/([^/]+)\/drafts$/);
      if (method === 'GET' && draftsMatch) {
        const text = DRAFTS[draftsMatch[1]!];
        if (!text) return json(route, 200, []);
        return json(route, 200, [
          { id: uuid(0x7c00 + (parseInt(draftsMatch[1]!.slice(-4), 16) & 0xff)), documentId: draftsMatch[1], provider: 'fake-ocr', text, blocks: [{ page: 1, text }], createdAt: ist('2026-11-10', '18:06'), isDraft: true },
        ]);
      }
      const retryMatch = path.match(/^\/documents\/([^/]+)\/retry-ocr$/);
      if (method === 'POST' && retryMatch) {
        note();
        const d = documents.find((x) => x.id === retryMatch[1]);
        if (!d) return error(route, 404, 'NOT_FOUND', 'Document not found.');
        d.status = 'processing';
        d.version += 1;
        return json(route, 200, d);
      }
      const verifyMatch = path.match(/^\/documents\/([^/]+)\/verify$/);
      if (method === 'POST' && verifyMatch) {
        note();
        const d = documents.find((x) => x.id === verifyMatch[1]);
        if (!d) return error(route, 404, 'NOT_FOUND', 'Document not found.');
        const b = body as { instructionId?: string; title: string; body: string; sourceDraftId?: string };
        const previous = versions.find((v) => v.patientId === d.patientId && v.status === 'current' && v.instructionId === b.instructionId);
        if (previous) previous.status = 'superseded';
        const v: VersionRow = {
          id: uuid(0x7f10 + versions.length),
          instructionId: previous?.instructionId ?? uuid(0x7e10 + versions.length),
          patientId: d.patientId,
          version: (previous?.version ?? 0) + 1,
          title: b.title,
          body: b.body,
          status: 'current',
          verifiedBy: DOCTOR_USER.id,
          verifiedByName: DOCTOR_USER.name,
          verifiedAt: NOW.toISOString(),
          supersedesId: previous?.id ?? null,
          sourceDraftId: b.sourceDraftId ?? null,
        };
        versions.push(v);
        d.status = 'verified';
        d.version += 1;
        return json(route, 201, v);
      }
      if (method === 'GET' && path === '/instructions') {
        const pid = q.get('patientId');
        return json(route, 200, m.empty ? [] : versions.filter((v) => !pid || v.patientId === pid));
      }

      // ---- assistant ------------------------------------------------------------------------------------
      if (method === 'POST' && path === '/assistant/messages') {
        note();
        const b = body as { question: string };
        const now = ist('2026-11-11', '10:05');
        if (!m.hasConversation) {
          // First question: a new conversation starts empty.
          messages.length = 0;
          m.hasConversation = true;
        }
        messages.push({ id: uuid(0x7b20 + messages.length), role: 'patient', body: b.question, outcome: null, citations: [], escalationTaskId: null, createdAt: now });
        const lower = b.question.toLowerCase();
        let answer: MessageRow;
        let escalation: { taskId: string; dueAt: string } | null = null;
        if (/(increase|stop|change|skip).*(dose|medicine|tablet)/.test(lower)) {
          answer = {
            id: uuid(0x7b40 + messages.length),
            role: 'assistant',
            body: 'I cannot change your treatment or your doses. Please speak to your doctor about this.',
            outcome: 'refused',
            citations: [],
            escalationTaskId: null,
            createdAt: now,
          };
        } else if (/(paracetamol|fever|water|rest|dose)/.test(lower)) {
          answer = {
            id: uuid(0x7b40 + messages.length),
            role: 'assistant',
            body: 'Rest for 3 days and drink plenty of water. Come back if the fever lasts more than 48 hours.',
            outcome: 'answered',
            citations: cite,
            escalationTaskId: null,
            createdAt: now,
          };
        } else {
          const task: TaskRow = {
            ...tasks[2]!,
            id: uuid(0x7a60 + tasks.length),
            title: `Question: ${b.question.slice(0, 60)}`,
            detail: b.question,
            dueAt: ist('2026-11-11', '16:00'),
            createdAt: now,
          };
          tasks.push(task);
          escalation = { taskId: task.id, dueAt: task.dueAt };
          answer = {
            id: uuid(0x7b40 + messages.length),
            role: 'assistant',
            body: 'Sent to the follow-up team.',
            outcome: 'escalated',
            citations: [],
            escalationTaskId: task.id,
            createdAt: now,
          };
        }
        messages.push(answer);
        return json(route, 200, {
          conversationId: CONVERSATION_ID,
          messageId: answer.id,
          outcome: answer.outcome,
          answer: answer.body,
          citations: answer.citations,
          escalation,
          createdAt: now,
        });
      }
      if (method === 'GET' && path === '/assistant/conversations') {
        return json(route, 200, m.hasConversation ? [{ id: CONVERSATION_ID, createdAt: ist('2026-11-11', '09:12'), lastMessageAt: ist('2026-11-11', '09:14') }] : []);
      }
      if (method === 'GET' && path === `/assistant/conversations/${CONVERSATION_ID}/messages`) return json(route, 200, m.empty ? [] : messages);

      // ---- admin ----------------------------------------------------------------------------------------
      const capMatch = path.match(/^\/sessions\/([^/]+)\/capacity$/);
      if (method === 'PATCH' && capMatch) {
        const b = req.postDataJSON() as { bookedCapacity: number; walkinCapacity: number; expectedVersion?: number };
        m.requests.push({ line: `PATCH ${path}`, key, body: b });
        const s = sched.sessions.find((x) => x.id === capMatch[1]);
        if (!s) return error(route, 404, 'NOT_FOUND', 'Session not found.');
        if (b.bookedCapacity < reserved(s)) {
          return error(route, 409, 'INVALID_CAPACITY_REDUCTION', `${reserved(s)} places are already booked in this session, so booked capacity cannot go below ${reserved(s)}.`, { minimum: reserved(s) });
        }
        if (b.walkinCapacity < s.walkinUsed) {
          return error(route, 409, 'INVALID_CAPACITY_REDUCTION', `${s.walkinUsed} walk-in places are already used, so walk-in capacity cannot go below ${s.walkinUsed}.`, { minimum: s.walkinUsed });
        }
        s.bookedCapacity = b.bookedCapacity;
        s.walkinCapacity = b.walkinCapacity;
        s.version += 1;
        const { baseBooked: _b, bookedCapacity: _c, walkinCapacity: _w, walkinUsed: _u, ...rest } = s;
        return json(route, 200, {
          ...rest,
          capacity: {
            bookedCapacity: s.bookedCapacity,
            walkinCapacity: s.walkinCapacity,
            bookedReserved: reserved(s),
            walkinUsed: s.walkinUsed,
            bookedAvailable: s.bookedCapacity - reserved(s),
            walkinAvailable: s.walkinCapacity - s.walkinUsed,
          },
        });
      }
      if (method === 'GET' && path === '/admin/staff') return json(route, 200, m.empty ? [] : staff);
      const assignMatch = path.match(/^\/admin\/staff\/([^/]+)\/assignments$/);
      if (method === 'PUT' && assignMatch) {
        const b = req.postDataJSON() as { doctorIds: string[] };
        m.requests.push({ line: `PUT ${path}`, key, body: b });
        const s = staff.find((x) => x.userId === assignMatch[1]);
        if (!s) return error(route, 404, 'NOT_FOUND', 'Staff member not found.');
        s.doctorIds = b.doctorIds;
        return json(route, 200, { userId: s.userId, doctorIds: s.doctorIds });
      }
      if (method === 'GET' && path === '/policies/current') {
        return json(route, 200, {
          id: uuid(0x70),
          version: 1,
          rotation: ['A', 'A', 'W'],
          earlyEligibilityMin: 10,
          lateGraceMin: 15,
          agingTriggerMin: 45,
          calledTimeoutSec: 120,
          ewmaAlpha: 0.2,
          initialEstimateMin: 12,
          defaultBookedCapacity: 10,
          defaultWalkinCapacity: 5,
          createdAt: ist('2026-11-01', '08:00'),
        });
      }
      if (method === 'GET' && path === '/reports/operations') {
        if (m.empty) return json(route, 200, { ...report, throughput: { completedVisits: 0, sessions: 0 }, waitsByGroup: [], decisionsByReason: [], metrics: [] });
        return json(route, 200, { ...report, from: q.get('from') ?? report.from, to: q.get('to') ?? report.to });
      }
      if (method === 'GET' && path === '/audit') {
        let rows = audit;
        if (q.get('entityType')) rows = rows.filter((r) => r.entityType === q.get('entityType'));
        if (q.get('entityId')) rows = rows.filter((r) => r.entityId === q.get('entityId'));
        return json(route, 200, rows);
      }

      return route.fallback();
    },
  );
  return m;
}

/**
 * Reception specs mock the scheduling sessions (their own ids) and the live queue (one session id).
 * Call this LAST: queue snapshot reads for any other session id are answered from the queue mock's session.
 */
export async function routeLiveBoardToQueueMock(page: Page): Promise<void> {
  await page.route(
    (url) => /^\/api\/sessions\/[^/]+\/queue$/.test(url.pathname) && !url.pathname.includes(QUEUE_SESSION_ID),
    (route) => {
      const url = new URL(route.request().url());
      url.pathname = `/api/sessions/${QUEUE_SESSION_ID}/queue`;
      return route.fallback({ url: url.toString() });
    },
  );
}
