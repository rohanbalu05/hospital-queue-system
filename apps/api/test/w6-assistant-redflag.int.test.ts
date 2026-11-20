/* eslint-disable @typescript-eslint/no-non-null-assertion -- tests index rows they have just created */
/* PR-13: red-flag symptom questions get fixed safety advice and an URGENT owned task, never a provider answer. */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AssistantAnswer, ConversationMessage, FollowUpTask } from '@hqms/contracts';
import { type Client, createTestApp, linkPatient, loginAs, newLoginPatient, type TestApp } from './helpers.js';
import { MemoryStorage, SpyLlm } from './fakes.js';

// Many questions from one patient in one file.
process.env['ASSISTANT_RATE_LIMIT_MAX'] = '200';

const URGENT_ADVICE =
  'If you have chest pain, trouble breathing, fainting, a swollen face or throat, signs of a stroke or a seizure, call 108 or come to the Emergency department now. Do not wait for our reply.';

let t: TestApp;
let llm: SpyLlm;
let admin: Client;
let reception: Client;
let followup: Client;
let doctor1: Client;
let patient: Client;
let P: string;

beforeAll(async () => {
  llm = new SpyLlm();
  t = await createTestApp({ storage: new MemoryStorage(), llm });
  admin = await loginAs(t.server, 'admin@hqms.test');
  reception = await loginAs(t.server, 'reception@hqms.test');
  followup = await loginAs(t.server, 'followup@hqms.test');
  doctor1 = await loginAs(t.server, 'doctor@hqms.test');
  const a = await newLoginPatient(t, reception, 'Red Flag Patient');
  patient = a.client;
  P = a.id;
  await linkPatient(admin, reception, P, 1);
});
afterAll(() => t.close());
beforeEach(() => {
  t.clock.reset();
  llm.calls.length = 0;
  llm.next = null;
});

const ask = (q: string, conversationId?: string) =>
  patient.post('/assistant/messages', { question: q, ...(conversationId ? { conversationId } : {}) }, null);

describe('red-flag questions', () => {
  it('escalate as urgent with the fixed advice, before any provider call', async () => {
    const before = new Date();
    const res = await ask('I feel dizzy after the new tablets. Should I stop taking them?');
    expect(res.status).toBe(201);
    const answer = AssistantAnswer.parse(res.body);
    expect(answer.outcome).toBe('escalated');
    expect(answer.citations).toEqual([]);
    expect(answer.urgentAdvice).toBe(URGENT_ADVICE);
    expect(answer.escalation?.urgent).toBe(true);
    expect(llm.calls).toHaveLength(0);

    // due in 2 hours, not 24
    const due = new Date(answer.escalation!.dueAt).getTime();
    expect(due - before.getTime()).toBeGreaterThan(115 * 60_000);
    expect(due - before.getTime()).toBeLessThan(125 * 60_000);

    const task = (await t.pool.query(`SELECT urgent, owner_id, kind, status, due_at FROM follow_up_tasks WHERE id = $1`, [answer.escalation!.taskId])).rows[0]!;
    expect(task).toMatchObject({ urgent: true, kind: 'assistant_escalation', status: 'open' });
    expect(task.owner_id).toBeTruthy(); // owned like every escalation

    // audit says why (code), not what was asked
    const audit = await t.pool.query(`SELECT reason, next FROM audit_events WHERE operation = 'assistant.escalate' AND entity_id = $1`, [answer.escalation!.taskId]);
    expect(audit.rows[0]!.reason).toBe('red_flag');
    expect(JSON.stringify(audit.rows)).not.toMatch(/dizzy|tablets/);

    // staff see it first, flagged urgent
    const list = (await followup.get(`/follow-up-tasks?owner=all&patientId=${P}`)).body as FollowUpTask[];
    expect(list[0]!.id).toBe(answer.escalation!.taskId);
    expect(list[0]!.urgent).toBe(true);
  });

  it('the conversation history returns urgentAdvice for those messages (from the task urgent flag)', async () => {
    const res = AssistantAnswer.parse((await ask('I have chest pain and my left arm hurts')).body);
    const calm = AssistantAnswer.parse((await ask('When is my next appointment?', res.conversationId)).body);
    expect(calm.urgentAdvice ?? null).toBeNull();
    const msgs = ((await patient.get(`/assistant/conversations/${res.conversationId}/messages`)).body as unknown[]).map((m) => ConversationMessage.parse(m));
    const assistant = msgs.filter((m) => m.role === 'assistant');
    expect(assistant[0]).toMatchObject({ outcome: 'escalated', urgentAdvice: URGENT_ADVICE });
    expect(assistant[1]!.urgentAdvice ?? null).toBeNull();
    expect(msgs.filter((m) => m.role === 'patient').every((m) => (m.urgentAdvice ?? null) === null)).toBe(true);
  });

  it.each([
    'I cannot breathe properly',
    'My father fainted and is unconscious',
    'I am vomiting blood',
    'My face and lips are swollen',
    'slurred speech and a drooping face',
    'she is having a seizure',
    'I am having suicidal thoughts',
    'I have a rash after starting the new medicine',
  ])('"%s" is escalated as urgent', async (q) => {
    const a = AssistantAnswer.parse((await ask(q)).body);
    expect(a.outcome).toBe('escalated');
    expect(a.urgentAdvice).toBe(URGENT_ADVICE);
    expect(a.escalation?.urgent).toBe(true);
    expect(llm.calls).toHaveLength(0);
  });

  it('a red flag is urgent even when it also trips the deny-list ("emergency")', async () => {
    const a = AssistantAnswer.parse((await ask('This is an emergency, I have chest pain, please move me up the queue')).body);
    expect(a.urgentAdvice).toBe(URGENT_ADVICE);
    expect(a.escalation?.urgent).toBe(true);
  });

  it('a red flag is never merged into an older, non-urgent open task', async () => {
    const p2 = await newLoginPatient(t, reception, 'Red Flag Join');
    await linkPatient(admin, reception, p2.id, 1);
    // three ordinary escalations hit the open-escalation cap (3)
    for (let i = 0; i < 3; i += 1) {
      const r = await p2.client.post('/assistant/messages', { question: `Please explain my result number ${i + 1}` }, null);
      expect(AssistantAnswer.parse(r.body).urgentAdvice ?? null).toBeNull();
    }
    const urgent = AssistantAnswer.parse((await p2.client.post('/assistant/messages', { question: 'I have chest pain now' }, null)).body);
    const row = (await t.pool.query(`SELECT urgent FROM follow_up_tasks WHERE id = $1`, [urgent.escalation!.taskId])).rows[0]!;
    expect(row.urgent).toBe(true);
    expect(urgent.escalation?.urgent).toBe(true);
  });

  it('ordinary questions and negated symptoms are not urgent', async () => {
    for (const q of ['Where do I collect my chest X-ray report?', 'I have no chest pain, how long is the course?']) {
      const a = AssistantAnswer.parse((await ask(q)).body);
      expect(a.urgentAdvice ?? null).toBeNull();
      expect(a.escalation?.urgent ?? false).toBe(false);
    }
  });

  it('doctor and other roles cannot use the patient assistant endpoint', async () => {
    expect((await doctor1.post('/assistant/messages', { question: 'chest pain' }, null)).status).toBe(403);
  });
});
