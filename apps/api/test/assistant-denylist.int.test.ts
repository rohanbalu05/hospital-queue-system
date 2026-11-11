/* eslint-disable @typescript-eslint/no-non-null-assertion -- tests index rows they have just created */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AssistantAnswer, type FollowUpTask, InstructionVersion } from '@hqms/contracts';
import { count, createTestApp, linkPatient, loginAs, newLoginPatient, type Client, type TestApp } from './helpers.js';
import { MemoryStorage, SpyLlm, makePng } from './fakes.js';

/**
 * Regression for Codex P1 #1 (FR-14 / report 6.8): a question that names the medicine directly and asks for a
 * treatment change ("Should I stop metformin?") must be escalated by the provider-independent deny-list, with ZERO
 * provider calls, even though the patient's verified instruction mentions that medicine.
 */
let t: TestApp;
let llm: SpyLlm;
let admin: Client;
let reception: Client;
let doctor1: Client;
let patient: Client;
let patientIdValue: string;
let version: InstructionVersion;

beforeAll(async () => {
  llm = new SpyLlm();
  t = await createTestApp({ storage: new MemoryStorage(), llm });
  admin = await loginAs(t.server, 'admin@hqms.test');
  reception = await loginAs(t.server, 'reception@hqms.test');
  doctor1 = await loginAs(t.server, 'doctor@hqms.test');
  const p = await newLoginPatient(t, reception, 'Denylist Patient');
  [patient, patientIdValue] = [p.client, p.id];
  await linkPatient(admin, reception, patientIdValue, 1);

  const up = await patient.upload('/documents', makePng(), { patientId: patientIdValue });
  expect(up.status).toBe(201);
  await t.pool.query(`UPDATE documents SET status = 'ocr_ready' WHERE id = $1`, [up.body.id]);
  const res = await doctor1.post(`/documents/${up.body.id}/verify`, {
    title: 'Diabetes care',
    body: 'Take metformin 500 mg twice daily.',
  });
  expect(res.status).toBe(201);
  version = InstructionVersion.parse(res.body);
});
afterAll(async () => {
  await t.close();
});
beforeEach(() => {
  t.clock.reset();
  llm.calls.length = 0;
  llm.next = null;
});

const ask = (question: string) => patient.post('/assistant/messages', { question }, null);

describe('direct medicine-name treatment-change questions with matching verified context', () => {
  for (const question of ['Should I stop metformin?', 'Should I increase metformin?']) {
    it(`escalates by the deny-list without calling the provider: ${question}`, async () => {
      t.clock.set('2041-06-10T05:00:00Z');
      const res = await ask(question);
      expect(res.status).toBe(201);
      const answer = AssistantAnswer.parse(res.body);
      expect(answer.outcome).toBe('escalated');
      expect(answer.citations).toEqual([]);
      expect(answer.answer).not.toMatch(/metformin|500 mg|twice daily/i); // no instruction text
      expect(answer.escalation).not.toBeNull();
      expect(answer.escalation!.dueAt).toBeTruthy();

      // the provider was never consulted
      expect(llm.calls).toHaveLength(0);

      // an owned staff task exists, with a due time
      const task = (await admin.get(`/follow-up-tasks/${answer.escalation!.taskId}`)).body as FollowUpTask;
      expect(task).toMatchObject({ kind: 'assistant_escalation', patientId: patientIdValue, status: 'open' });
      expect(task.ownerId).toBeTruthy();
      expect(task.dueAt).toBeTruthy();

      // audit reason is the deny-list code, and the stored message cites nothing
      const audit = await t.pool.query(
        `SELECT reason FROM audit_events WHERE operation = 'assistant.escalate' AND next->>'messageId' = $1`,
        [answer.messageId],
      );
      expect(audit.rows.map((r) => r.reason)).toEqual(['denied_intent']);
      const msg = (await t.pool.query(`SELECT outcome, source_version_ids FROM messages WHERE id = $1`, [answer.messageId])).rows[0]!;
      expect(msg).toMatchObject({ outcome: 'escalated', source_version_ids: [] });
    });
  }

  it('a benign question about the same medicine is answered from the current version and cited', async () => {
    const res = await ask('How often do I take metformin?');
    expect(res.status).toBe(201);
    const answer = AssistantAnswer.parse(res.body);
    expect(answer.outcome).toBe('answered');
    expect(answer.escalation).toBeNull();
    expect(answer.citations).toEqual([
      { instructionVersionId: version.id, title: 'Diabetes care', version: 1, verifiedAt: expect.any(String) },
    ]);
    expect(answer.answer).toContain('metformin 500 mg twice daily');
    expect(llm.calls).toHaveLength(1);
    expect(llm.calls[0]!.context.map((c) => c.instructionVersionId)).toEqual([version.id]);
  });

  it('the denied questions created no answered message and left the instruction untouched', async () => {
    expect(
      await count(t.pool, `SELECT 1 FROM instruction_versions WHERE patient_id = $1 AND status = 'current'`, [patientIdValue]),
    ).toBe(1);
  });
});
