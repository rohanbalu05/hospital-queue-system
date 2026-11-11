/* eslint-disable @typescript-eslint/no-non-null-assertion -- tests index rows they have just created */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  ApiError,
  Appointment,
  AssistantAnswer,
  AuditEvent,
  FollowUpTask,
  InstructionVersion,
  StaffMember,
} from '@hqms/contracts';
import { buildTaskListQuery } from '../src/followup/followup.repo.js';
import {
  type Client,
  type MadeSession,
  type TestApp,
  at,
  count,
  createTestApp,
  doctorId,
  linkPatient,
  loginAs,
  makeSession,
  newLoginPatient,
  newPatient,
} from './helpers.js';
import { MemoryStorage, SpyLlm, makePng } from './fakes.js';

let t: TestApp;
let admin: Client;
let reception: Client;
let doctor1: Client;
let doctor8: Client;
let followup: Client;
let followup2: Client;
let F1: string;
const llm = new SpyLlm();

beforeAll(async () => {
  t = await createTestApp({ storage: new MemoryStorage(), llm });
  admin = await loginAs(t.server, 'admin@hqms.test');
  reception = await loginAs(t.server, 'reception@hqms.test');
  doctor1 = await loginAs(t.server, 'doctor@hqms.test');
  doctor8 = await loginAs(t.server, 'doctor8@hqms.test');
  followup = await loginAs(t.server, 'followup@hqms.test');
  followup2 = await loginAs(t.server, 'followup2@hqms.test');
  F1 = (await followup.get('/me')).body.userId as string;
});
afterAll(async () => {
  await t.close();
});
beforeEach(() => {
  t.clock.reset();
  llm.calls.length = 0;
  llm.next = null;
  delete llm.onCall;
});

const code = (body: unknown): string => ApiError.parse(body).error.code;
const inHours = (h: number): string => new Date(t.clock.now().getTime() + h * 3_600_000).toISOString();

/** A patient with a login, linked to doctor 1, with one verified instruction. */
async function patientWithContext(
  name = 'Review Patient',
  body = 'Take amoxicillin 500 mg twice daily after food. Finish the whole course.',
): Promise<{ id: string; client: Client; version: InstructionVersion }> {
  const { id, client } = await newLoginPatient(t, reception, name);
  await linkPatient(admin, reception, id, 1);
  const version = await verifyNew(client, id, 'Antibiotic course', body);
  return { id, client, version };
}

async function readyDocument(patient: Client, pid: string): Promise<string> {
  const up = await patient.upload('/documents', makePng(), { patientId: pid });
  expect(up.status).toBe(201);
  await t.pool.query(`UPDATE documents SET status = 'ocr_ready' WHERE id = $1`, [up.body.id]);
  return up.body.id as string;
}

async function verifyNew(patient: Client, pid: string, title: string, body: string): Promise<InstructionVersion> {
  const doc = await readyDocument(patient, pid);
  const res = await doctor1.post(`/documents/${doc}/verify`, { title, body });
  expect(res.status).toBe(201);
  return InstructionVersion.parse(res.body);
}

const ask = (c: Client, question: string, conversationId?: string, key: string | null = randomUUID()) =>
  c.post('/assistant/messages', { question, ...(conversationId ? { conversationId } : {}) }, key);

async function auditOf(entityId: string, operation: string) {
  const r = await t.pool.query(`SELECT reason, previous, next FROM audit_events WHERE entity_id = $1 AND operation = $2 ORDER BY id`, [
    entityId,
    operation,
  ]);
  return r.rows;
}

describe('FR-14 assistant: provider-independent deny-list, caps, idempotency, rate limit, stale citations', () => {
  it('a denied intent with verified context escalates WITHOUT calling the provider (dose, stop, start, priority, booking)', async () => {
    const p = await patientWithContext('Deny Patient');
    for (const q of [
      'Can I increase my dose?',
      'Can I stop taking the tablets?',
      'Should I add another painkiller as well?',
      'Please move me up the queue, it is urgent',
      'Please cancel my appointment',
      'Do I have diabetes?',
    ]) {
      const res = await ask(p.client, q);
      expect(res.status).toBe(201);
      const a = AssistantAnswer.parse(res.body);
      expect(a.outcome, q).toBe('escalated');
      expect(a.escalation, q).not.toBeNull();
      expect((await auditOf(a.escalation!.taskId, 'assistant.escalate')).some((r) => r.reason === 'denied_intent'), q).toBe(true);
    }
    expect(llm.calls).toHaveLength(0);
    // A question the verified instruction does cover still reaches the provider.
    expect(AssistantAnswer.parse((await ask(p.client, 'How should I take the amoxicillin?')).body).outcome).toBe('answered');
    expect(llm.calls).toHaveLength(1);
  });

  it('beyond ASSISTANT_MAX_CONCURRENCY (4) a question escalates as "busy": never a 5xx, never more than 4 provider calls', async () => {
    const people = [] as Array<{ client: Client }>;
    for (let i = 0; i < 5; i += 1) people.push(await patientWithContext(`Busy Patient ${i}`));
    let release: () => void = () => undefined;
    const gate = new Promise<void>((ok) => {
      release = ok;
    });
    llm.onCall = () => gate;
    const results: Array<{ status: number; body: AssistantAnswer }> = [];
    const all = people.map(async (p) => {
      const r = await ask(p.client, 'How should I take the amoxicillin?');
      results.push({ status: r.status, body: r.body as AssistantAnswer });
    });
    const deadline = Date.now() + 8000;
    while ((llm.calls.length < 4 || results.length < 1) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25));
    expect(llm.calls).toHaveLength(4);
    expect(results).toHaveLength(1);
    expect(results[0]!.status).toBe(201);
    expect(results[0]!.body.outcome).toBe('escalated');
    const busyTask = results[0]!.body.escalation!.taskId;
    release();
    await Promise.all(all);
    expect(llm.calls).toHaveLength(4);
    expect(results.map((r) => r.status)).toEqual([201, 201, 201, 201, 201]);
    expect(results.filter((r) => r.body.outcome === 'answered')).toHaveLength(4);
    expect((await auditOf(busyTask, 'assistant.escalate'))[0]!.reason).toBe('busy');
  });

  it('Idempotency-Key: a retry returns the same answer, the provider is asked once, a different body is IDEMPOTENCY_KEY_REUSED', async () => {
    const p = await patientWithContext('Idem Patient');
    const key = `ask-${randomUUID()}`;
    const first = await ask(p.client, 'How should I take the amoxicillin?', undefined, key);
    expect(first.status).toBe(201);
    const again = await ask(p.client, 'How should I take the amoxicillin?', undefined, key);
    expect(again.status).toBe(201);
    expect(again.headers['idempotency-replayed']).toBe('true');
    expect(again.body.messageId).toBe(first.body.messageId);
    expect(llm.calls).toHaveLength(1);
    expect(await count(t.pool, `SELECT 1 FROM messages WHERE patient_id = $1 AND role = 'patient'`, [p.id])).toBe(1);
    const other = await ask(p.client, 'And how long is the course?', undefined, key);
    expect(other.status).toBe(409);
    expect(code(other.body)).toBe('IDEMPOTENCY_KEY_REUSED');
  });

  it('at most 3 open escalation tasks per patient (the next question joins the latest), and 10 questions per 10 minutes then 429', async () => {
    const { id, client } = await newLoginPatient(t, reception, 'Chatty Patient');
    let last: AssistantAnswer | null = null;
    for (let i = 1; i <= 10; i += 1) {
      const res = await ask(client, `Question number ${i} please`);
      expect(res.status).toBe(201);
      last = AssistantAnswer.parse(res.body);
      expect(last.outcome).toBe('escalated');
    }
    const open = await t.pool.query(
      `SELECT id, detail FROM follow_up_tasks WHERE patient_id = $1 AND kind = 'assistant_escalation' AND status IN ('open','acknowledged') ORDER BY created_at`,
      [id],
    );
    expect(open.rows).toHaveLength(3);
    expect(last!.escalation!.taskId).toBe(open.rows[2]!.id);
    expect(open.rows[2]!.detail).toContain('Question number 10 please');
    expect(open.rows[2]!.detail).toContain('Question number 4 please');
    // every question was recorded and answered with a task id
    expect(await count(t.pool, `SELECT 1 FROM messages WHERE patient_id = $1 AND role = 'patient'`, [id])).toBe(10);
    expect(await count(t.pool, `SELECT 1 FROM messages WHERE patient_id = $1 AND outcome = 'escalated' AND escalation_task_id IS NOT NULL`, [id])).toBe(10);

    const limited = await ask(client, 'One more question please');
    expect(limited.status).toBe(429);
    expect(code(limited.body)).toBe('RATE_LIMITED');
    expect(await count(t.pool, `SELECT 1 FROM messages WHERE patient_id = $1 AND role = 'patient'`, [id])).toBe(10);
  });

  it('a citation that is superseded while the provider is thinking is re-checked in the write transaction: escalated, not answered', async () => {
    const p = await patientWithContext('Stale Patient');
    const doc2 = await readyDocument(p.client, p.id);
    llm.next = async () => {
      const rev = await doctor1.post(`/documents/${doc2}/verify`, {
        instructionId: p.version.instructionId,
        expectedCurrentVersionId: p.version.id,
        title: 'Antibiotic course',
        body: 'Take amoxicillin 250 mg three times daily.',
      });
      expect(rev.status).toBe(201);
      return { kind: 'answer' as const, text: 'Take amoxicillin 500 mg twice daily.', citedVersionIds: [p.version.id] };
    };
    const res = await ask(p.client, 'How should I take the amoxicillin?');
    const a = AssistantAnswer.parse(res.body);
    expect(a.outcome).toBe('escalated');
    expect(a.answer).not.toContain('500 mg');
    expect((await auditOf(a.escalation!.taskId, 'assistant.escalate'))[0]!.reason).toBe('stale_version');
  });

  it('the escalation text shows the due time in Asia/Kolkata ("by 3:30 pm, 13 Nov"), and audit rows never carry the question', async () => {
    const { id, client } = await newLoginPatient(t, reception, 'Zone Patient');
    t.clock.set('2041-11-12T10:00:00Z'); // 15:30 IST; due in 24 h
    const res = await ask(client, 'Please tell me about zebracadabra tablets');
    const a = AssistantAnswer.parse(res.body);
    expect(a.answer).toMatch(/follow up with you by 3:30 pm, 13 Nov\.$/);
    expect(a.answer).not.toMatch(/Z\b|T\d\d:/);
    const rows = await t.pool.query(
      `SELECT reason, previous::text AS previous, next::text AS next FROM audit_events WHERE actor_id = (SELECT id FROM users WHERE patient_id = $1)`,
      [id],
    );
    expect(rows.rows.length).toBeGreaterThan(0);
    expect(JSON.stringify(rows.rows)).not.toMatch(/zebracadabra/i);
    expect(rows.rows.some((r) => /questionLength/.test(r.next as string))).toBe(true);
  });
});

describe('FR-11 ownership: escalation owners, default owners, owner-only resolve and cancel', () => {
  it('a doctor-created task without an owner gets one by the assignment rule; a follow-up creator owns what they create', async () => {
    const p = await newPatient(reception, 'Owner Rule Patient');
    await linkPatient(admin, reception, p, 1);
    const byDoctor = FollowUpTask.parse((await doctor1.post('/follow-up-tasks', { patientId: p, title: 'Call about results', dueAt: inHours(24) })).body);
    expect(byDoctor.ownerId).toBeTruthy();
    expect((await t.pool.query(`SELECT role FROM users WHERE id = $1`, [byDoctor.ownerId])).rows[0]!.role).toBe('followup');
    const byFollowup = FollowUpTask.parse((await followup2.post('/follow-up-tasks', { patientId: p, title: 'Check on the wound', dueAt: inHours(24) })).body);
    expect(byFollowup.ownerId).toBe((await followup2.get('/me')).body.userId);
  });

  async function ownedTask(): Promise<{ task: FollowUpTask; p: string }> {
    const p = await newPatient(reception, 'Owner Patient');
    await linkPatient(admin, reception, p, 1);
    const res = await doctor1.post('/follow-up-tasks', { patientId: p, title: 'Call about dressing', dueAt: inHours(24), ownerId: F1 });
    expect(res.status).toBe(201);
    return { task: FollowUpTask.parse(res.body), p };
  }

  it('resolve and cancel need the owner: another follow-up user and the doctor get 403, the owner and an admin succeed', async () => {
    const { task } = await ownedTask();
    expect((await followup2.post(`/follow-up-tasks/${task.id}/resolve`, { disposition: 'advice_given', outcomeNote: 'Not mine to close' })).status).toBe(403);
    expect((await followup2.post(`/follow-up-tasks/${task.id}/cancel`, { reason: 'Not mine to cancel' })).status).toBe(403);
    expect((await doctor1.post(`/follow-up-tasks/${task.id}/cancel`, { reason: 'Doctor is not the owner' })).status).toBe(403);
    expect((await t.pool.query(`SELECT status FROM follow_up_tasks WHERE id = $1`, [task.id])).rows[0]!.status).toBe('open');
    expect((await followup.post(`/follow-up-tasks/${task.id}/resolve`, { disposition: 'advice_given', outcomeNote: 'Rang and advised' })).status).toBe(200);

    const second = (await ownedTask()).task;
    expect((await admin.post(`/follow-up-tasks/${second.id}/cancel`, { reason: 'Admin cleans up' })).status).toBe(200);
  });

  it('an unowned task is taken by whoever resolves or cancels it', async () => {
    const a = (await ownedTask()).task;
    const b = (await ownedTask()).task;
    await t.pool.query(`UPDATE follow_up_tasks SET owner_id = NULL WHERE id = ANY($1::uuid[])`, [[a.id, b.id]]);
    const me2 = (await followup2.get('/me')).body.userId as string;
    const resolved = await followup2.post(`/follow-up-tasks/${a.id}/resolve`, { disposition: 'no_action_needed', outcomeNote: 'Patient is well' });
    expect(resolved.status).toBe(200);
    expect(resolved.body.ownerId).toBe(me2);
    const cancelled = await followup2.post(`/follow-up-tasks/${b.id}/cancel`, { reason: 'Duplicate request' });
    expect(cancelled.status).toBe(200);
    expect(cancelled.body.ownerId).toBe(me2);
  });

  it('audit rows keep the resolve reason but cap it at 200 characters (the task keeps the full note)', async () => {
    const { task } = await ownedTask();
    const note = `${'Long outcome note. '.repeat(20)}END`;
    expect(note.length).toBeGreaterThan(300);
    expect((await followup.post(`/follow-up-tasks/${task.id}/resolve`, { disposition: 'advice_given', outcomeNote: note })).status).toBe(200);
    const rows = await auditOf(task.id, 'follow_up.resolve');
    expect(rows[0]!.reason).toHaveLength(200);
    expect(note.startsWith(rows[0]!.reason as string)).toBe(true);
    expect((await t.pool.query(`SELECT outcome_note FROM follow_up_tasks WHERE id = $1`, [task.id])).rows[0]!.outcome_note).toBe(note);
  });

  it('the clinical priority audit row keeps the reason capped at 200 characters', async () => {
    const s = await makeSession(admin, { doctor: 1 });
    t.clock.set(at(s, 0));
    const p = await newPatient(reception, 'Priority Patient');
    const arrival = await reception.post(`/sessions/${s.id}/walk-ins`, { patientId: p });
    expect(arrival.status).toBe(201);
    const reason = 'Breathless on arrival. '.repeat(13).slice(0, 290);
    const res = await doctor1.post(`/queue-entries/${arrival.body.queueEntryId}/priority`, { priorityClass: 2, reason });
    expect(res.status).toBe(200);
    const rows = await auditOf(arrival.body.queueEntryId as string, 'queue.priority');
    expect(rows[0]!.reason).toHaveLength(200);
    expect((await t.pool.query(`SELECT priority_reason FROM queue_entries WHERE id = $1`, [arrival.body.queueEntryId])).rows[0]!.priority_reason).toBe(reason);
  });

  it('listTasks: owner=me with a status is served by follow_up_tasks_owner_idx (EXPLAIN), and an owner sees tasks of unlinked patients', async () => {
    const me = (await followup.get('/me')).body.userId as string;
    const q = buildTaskListQuery(new Date(), { scopeDoctors: [doctorId(1)], owner: 'me', userId: me, status: 'open' });
    expect(q.text).toMatch(/t\.owner_id = \$1 AND t\.status = \$2/);
    expect(q.text).toMatch(/ORDER BY t\.due_at, t\.id$/);
    const c = await t.pool.connect();
    try {
      await c.query('BEGIN');
      await c.query('SET LOCAL enable_seqscan = off');
      const plan = await c.query(`EXPLAIN ${q.text}`, q.values);
      await c.query('ROLLBACK');
      const text = plan.rows.map((r: Record<string, string>) => r['QUERY PLAN']).join('\n');
      expect(text).toContain('follow_up_tasks_owner_idx');
    } finally {
      c.release();
    }
    // no scope clause is added for the owner's own list
    const lone = (await newLoginPatient(t, reception, 'Unlinked Patient')).client;
    const a = AssistantAnswer.parse((await ask(lone, 'What should I eat?')).body);
    const ownerEmail = (await t.pool.query(`SELECT u.email FROM follow_up_tasks f JOIN users u ON u.id = f.owner_id WHERE f.id = $1`, [a.escalation!.taskId])).rows[0]!.email as string;
    const owner = await loginAs(t.server, ownerEmail);
    const mine = (await owner.get('/follow-up-tasks?owner=me&status=open')).body as FollowUpTask[];
    expect(mine.map((x) => x.id)).toContain(a.escalation!.taskId);
  });

  it('resolve(return_booked) locks the return appointment: a cancel in flight finishes first, then the resolve answers 409', async () => {
    const { task } = await ownedTask();
    const target = await makeSession(admin, { doctor: 1 });
    const booked = await followup.post(`/follow-up-tasks/${task.id}/return-booking`, { sessionId: target.id });
    expect(booked.status).toBe(201);
    const appt = Appointment.parse(booked.body);

    const c = await t.pool.connect();
    try {
      await c.query('BEGIN');
      await c.query(`SELECT id FROM appointments WHERE id = $1 FOR NO KEY UPDATE`, [appt.id]);
      let settled = false;
      const resolving = followup
        .post(`/follow-up-tasks/${task.id}/resolve`, { disposition: 'return_booked', outcomeNote: 'Return visit booked', returnAppointmentId: appt.id })
        .then((r) => {
          settled = true;
          return r;
        });
      await new Promise((r) => setTimeout(r, 500));
      expect(settled).toBe(false); // waiting on the appointment lock
      await c.query(`UPDATE appointments SET status = 'cancelled' WHERE id = $1`, [appt.id]);
      await c.query('COMMIT');
      const res = await resolving;
      expect(res.status).toBe(409);
      expect(code(res.body)).toBe('CONFLICT');
    } finally {
      c.release();
    }
    expect((await t.pool.query(`SELECT status FROM follow_up_tasks WHERE id = $1`, [task.id])).rows[0]!.status).toBe('open');
  });
});

describe('FR-13 verification: compare-and-set, idempotency, lineage lock', () => {
  it('a revision needs expectedCurrentVersionId; a stale one is 409 CONFLICT; the right one supersedes', async () => {
    const p = await patientWithContext('CAS Patient');
    const docA = await readyDocument(p.client, p.id);
    const missing = await doctor1.post(`/documents/${docA}/verify`, { instructionId: p.version.instructionId, title: 'Antibiotic course', body: 'Take amoxicillin 250 mg.' });
    expect(missing.status).toBe(400);
    const stale = await doctor1.post(`/documents/${docA}/verify`, {
      instructionId: p.version.instructionId,
      expectedCurrentVersionId: randomUUID(),
      title: 'Antibiotic course',
      body: 'Take amoxicillin 250 mg.',
    });
    expect(stale.status).toBe(409);
    expect(code(stale.body)).toBe('CONFLICT');
    expect((await t.pool.query(`SELECT status FROM documents WHERE id = $1`, [docA])).rows[0]!.status).toBe('ocr_ready');
    const ok = await doctor1.post(`/documents/${docA}/verify`, {
      instructionId: p.version.instructionId,
      expectedCurrentVersionId: p.version.id,
      title: 'Antibiotic course',
      body: 'Take amoxicillin 250 mg.',
    });
    expect(ok.status).toBe(201);
    expect(InstructionVersion.parse(ok.body)).toMatchObject({ version: 2, supersedesId: p.version.id, status: 'current' });
    // the superseded version is no longer a valid "current" to revise
    const docB = await readyDocument(p.client, p.id);
    const again = await doctor1.post(`/documents/${docB}/verify`, {
      instructionId: p.version.instructionId,
      expectedCurrentVersionId: p.version.id,
      title: 'Antibiotic course',
      body: 'Take amoxicillin 125 mg.',
    });
    expect(again.status).toBe(409);
  });

  it('two clinicians revising the same current version at once: exactly one wins, the other gets a controlled 409', async () => {
    const p = await patientWithContext('Race Patient');
    const [d1, d2] = [await readyDocument(p.client, p.id), await readyDocument(p.client, p.id)];
    const body = (n: number) => ({
      instructionId: p.version.instructionId,
      expectedCurrentVersionId: p.version.id,
      title: 'Antibiotic course',
      body: `Revision ${n}: take amoxicillin ${n * 100} mg.`,
    });
    const [a, b] = await Promise.all([doctor1.post(`/documents/${d1}/verify`, body(1)), doctor1.post(`/documents/${d2}/verify`, body(2))]);
    expect([a.status, b.status].sort()).toEqual([201, 409]);
    expect(await count(t.pool, `SELECT 1 FROM instruction_versions WHERE instruction_id = $1`, [p.version.instructionId])).toBe(2);
    expect(await count(t.pool, `SELECT 1 FROM instruction_versions WHERE instruction_id = $1 AND status = 'current'`, [p.version.instructionId])).toBe(1);
  });

  it('Idempotency-Key: the same key returns the same version without a second one', async () => {
    const p = await patientWithContext('Idem Verify');
    const doc = await readyDocument(p.client, p.id);
    const key = `verify-${randomUUID()}`;
    const body = { title: 'Fresh instruction', body: 'Rest and drink fluids for three days.' };
    const first = await doctor1.post(`/documents/${doc}/verify`, body, key);
    expect(first.status).toBe(201);
    const second = await doctor1.post(`/documents/${doc}/verify`, body, key);
    expect(second.status).toBe(201);
    expect(second.headers['idempotency-replayed']).toBe('true');
    expect(second.body.id).toBe(first.body.id);
    expect(await count(t.pool, `SELECT 1 FROM instruction_versions WHERE instruction_id = $1`, [first.body.instructionId])).toBe(1);
  });
});

describe('patient scope: only current links count', () => {
  it('an old or cancelled appointment grants nothing; a recent active one does', async () => {
    const p = await newPatient(reception, 'Scope Patient');
    const link = await linkPatient(admin, reception, p, 1);
    expect((await doctor1.get(`/documents?patientId=${p}`)).status).toBe(200);

    await t.pool.query(`UPDATE appointments SET status = 'cancelled' WHERE id = $1`, [link.appointmentId]);
    expect((await doctor1.get(`/documents?patientId=${p}`)).status).toBe(404);

    await t.pool.query(`UPDATE appointments SET status = 'completed', scheduled_at = now() - interval '200 days' WHERE id = $1`, [link.appointmentId]);
    expect((await doctor1.get(`/documents?patientId=${p}`)).status).toBe(404);

    await t.pool.query(`UPDATE appointments SET scheduled_at = now() - interval '100 days' WHERE id = $1`, [link.appointmentId]);
    expect((await doctor1.get(`/documents?patientId=${p}`)).status).toBe(200);
  });
});

describe('contract additions: sourceVisit, audit actorName, admin staff', () => {
  it('a task with a source visit carries sessionDate, doctor and department on detail and list reads', async () => {
    await t.pool.query(
      `UPDATE queue_entries SET state = 'skipped', skipped_at = now() WHERE doctor_id = $1 AND state IN ('called','in_service')`,
      [doctorId(8)],
    );
    const s: MadeSession = await makeSession(admin, { doctor: 8 });
    const p = await newPatient(reception, 'Source Visit Patient');
    const appt = await reception.post('/appointments', { sessionId: s.id, patientId: p });
    expect(appt.status).toBe(201);
    t.clock.set(at(s, 0));
    expect((await reception.post(`/appointments/${appt.body.id}/check-in`, {})).status).toBe(201);
    const called = await doctor8.post(`/sessions/${s.id}/call-next`, {});
    const visitId = called.body.entry.visitId as string;
    t.clock.set(at(s, 1));
    expect((await doctor8.post(`/visits/${visitId}/start`, {})).status).toBe(200);
    t.clock.set(at(s, 8));
    expect((await doctor8.post(`/visits/${visitId}/complete`, {})).status).toBe(200);

    const created = await doctor8.post('/follow-up-tasks', { patientId: p, sourceVisitId: visitId, title: 'Review after the visit', dueAt: inHours(48) });
    expect(created.status).toBe(201);
    const task = FollowUpTask.parse(created.body);
    expect(task.sourceVisit).toMatchObject({ sessionDate: s.date, doctorId: doctorId(8) });
    expect(task.sourceVisit!.doctorName).toBeTruthy();
    expect(task.sourceVisit!.department).toBeTruthy();
    const listed = (await admin.get(`/follow-up-tasks?owner=all&patientId=${p}`)).body as FollowUpTask[];
    expect(listed.find((x) => x.id === task.id)?.sourceVisit).toEqual(task.sourceVisit);
    const plain = (await doctor8.post('/follow-up-tasks', { patientId: p, title: 'No visit attached', dueAt: inHours(48) })).body as FollowUpTask;
    expect(plain.sourceVisit).toBeNull();

    // audit: the actor's display name rides along (B5)
    const audit = ((await admin.get(`/audit?entityType=follow_up_task&entityId=${task.id}`)).body as unknown[]).map((e) => AuditEvent.parse(e));
    const doctorName = (await doctor8.get('/me')).body.displayName as string;
    expect(audit[0]).toMatchObject({ operation: 'follow_up.create', actorName: doctorName });
  });

  it('GET /admin/staff lists staff with their doctors (admin only); PUT assignments replaces them, audited, and rejects non-assignable users', async () => {
    const tag = randomUUID().slice(0, 8);
    const email = `assign-${tag}@hqms.test`;
    await t.pool.query(
      `INSERT INTO users (hospital_id, email, display_name, role, password_hash)
       SELECT hospital_id, $1, 'Assign Test', 'reception', password_hash FROM users WHERE email = 'reception@hqms.test'`,
      [email],
    );
    const userId = (await t.pool.query(`SELECT id FROM users WHERE email = $1`, [email])).rows[0]!.id as string;

    expect((await reception.get('/admin/staff')).status).toBe(403);
    expect((await doctor1.get('/admin/staff')).status).toBe(403);
    const list = ((await admin.get('/admin/staff')).body as unknown[]).map((m) => StaffMember.parse(m));
    expect(list.find((m) => m.userId === userId)).toMatchObject({ role: 'reception', doctorIds: [] });
    expect(list.every((m) => m.role !== ('patient' as string))).toBe(true);
    expect(list.find((m) => m.email === 'doctor@hqms.test')?.doctorIds).toEqual([doctorId(1)]);

    const res = await adminPut(userId, [doctorId(2), doctorId(1)]);
    expect(res.status).toBe(200);
    expect(StaffMember.parse(res.body).doctorIds.sort()).toEqual([doctorId(1), doctorId(2)].sort());
    const me = await (await loginAs(t.server, email)).get('/me');
    expect((me.body.assignedDoctorIds as string[]).sort()).toEqual([doctorId(1), doctorId(2)].sort());
    const audit = await auditOf(userId, 'staff.assignments');
    expect(audit).toHaveLength(1);
    expect(audit[0]!.previous).toEqual({ doctorIds: [] });
    expect((audit[0]!.next as { doctorIds: string[] }).doctorIds.sort()).toEqual([doctorId(1), doctorId(2)].sort());

    // replace, then clear
    expect((await adminPut(userId, [doctorId(3)])).body.doctorIds).toEqual([doctorId(3)]);
    expect((await adminPut(userId, [])).body.doctorIds).toEqual([]);

    // refused: a doctor user, an admin, an unknown doctor, an unknown user, non-admin callers
    const doctorUser = (await t.pool.query(`SELECT id FROM users WHERE email = 'doctor@hqms.test'`)).rows[0]!.id as string;
    expect((await adminPut(doctorUser, [doctorId(1)])).status).toBe(400);
    expect((await adminPut(userId, [randomUUID()])).status).toBe(400);
    expect((await adminPut(randomUUID(), [doctorId(1)])).status).toBe(404);
    expect((await adminPut(userId, [doctorId(1)], reception)).status).toBe(403);
    expect((await adminPut(userId, [doctorId(1)], doctor1)).status).toBe(403);
  });

  /** PUT with the shared client's cookie (the test Client has no put helper). */
  async function adminPut(userId: string, doctorIds: string[], by: Client = admin) {
    const request = (await import('supertest')).default;
    return request(t.server).put(`/admin/staff/${userId}/assignments`).set('Cookie', by.cookie).send({ doctorIds });
  }
});

describe('FR-15 the audit trail is append-only (migration 0006)', () => {
  it('UPDATE and DELETE on audit_events are rejected; inserts still work', async () => {
    const row = (await t.pool.query(`SELECT id FROM audit_events ORDER BY id DESC LIMIT 1`)).rows[0] as { id: string } | undefined;
    expect(row).toBeTruthy();
    await expect(t.pool.query(`UPDATE audit_events SET reason = 'tampered' WHERE id = $1`, [row!.id])).rejects.toThrow(/append-only/);
    await expect(t.pool.query(`DELETE FROM audit_events WHERE id = $1`, [row!.id])).rejects.toThrow(/append-only/);
    await expect(t.pool.query(`UPDATE audit_events SET reason = 'tampered'`)).rejects.toThrow(/append-only/);
    expect((await t.pool.query(`SELECT reason FROM audit_events WHERE id = $1`, [row!.id])).rows[0]!.reason).not.toBe('tampered');
    const before = await count(t.pool, `SELECT 1 FROM audit_events`);
    await t.pool.query(`INSERT INTO audit_events (actor_role, operation, entity_type, entity_id) VALUES ('system', 'test.append', 'test', $1)`, [randomUUID()]);
    expect(await count(t.pool, `SELECT 1 FROM audit_events`)).toBe(before + 1);
  });
});
