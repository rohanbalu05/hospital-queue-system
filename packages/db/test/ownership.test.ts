import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPool, sqlState } from '../src/index.js';
import { makeFixture, nth, TEST_DB, testUrl } from './helpers.js';

let pool: Pool;
beforeAll(() => {
  pool = createPool(testUrl(TEST_DB), { max: 4 });
});
afterAll(async () => {
  await pool.end();
});

/** SQLSTATE and constraint of a failed query, or null when it succeeded. */
const failure = async (p: Promise<unknown>) => {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  return err ? { state: sqlState(err), constraint: (err as { constraint?: string }).constraint } : null;
};

describe('users.email is unique case-insensitively (migration 0004)', () => {
  it('rejects an email that differs only by case', async () => {
    const f = await makeFixture(pool);
    const email = `Case-${randomUUID().slice(0, 8)}@Test.Local`;
    await pool.query(`INSERT INTO users (hospital_id, email, display_name, role) VALUES ($1, $2, 'A', 'reception')`, [
      f.hospitalId,
      email,
    ]);
    const dup = await failure(
      pool.query(`INSERT INTO users (hospital_id, email, display_name, role) VALUES ($1, $2, 'B', 'reception')`, [
        f.hospitalId,
        email.toLowerCase(),
      ]),
    );
    expect(dup).toEqual({ state: '23505', constraint: 'users_email_lower_uq' });
  });
});

describe('composite patient ownership of instruction versions and messages (migration 0004)', () => {
  it('instruction_versions.patient_id must equal the instruction owner', async () => {
    const f = await makeFixture(pool, { patients: 2 });
    const p1 = nth(f.patientIds, 0);
    const p2 = nth(f.patientIds, 1);
    const ins = await pool.query<{ id: string }>(
      `INSERT INTO instructions (patient_id, title) VALUES ($1, 'Diet') RETURNING id`,
      [p1],
    );
    const instructionId = nth(ins.rows, 0).id;
    const insertVersion = (patientId: string, version: number) =>
      pool.query(
        `INSERT INTO instruction_versions (instruction_id, patient_id, version, body, status, verified_by, verified_at)
         VALUES ($1, $2, $3, 'Drink water', 'current', $4, now())`,
        [instructionId, patientId, version, f.userId],
      );
    expect(await failure(insertVersion(p2, 1))).toEqual({
      state: '23503',
      constraint: 'instruction_versions_instruction_patient_fk',
    });
    expect(await failure(insertVersion(p1, 1))).toBeNull();
  });

  it('messages.patient_id must equal the conversation owner', async () => {
    const f = await makeFixture(pool, { patients: 2 });
    const p1 = nth(f.patientIds, 0);
    const p2 = nth(f.patientIds, 1);
    const conv = await pool.query<{ id: string }>(`INSERT INTO conversations (patient_id) VALUES ($1) RETURNING id`, [p1]);
    const conversationId = nth(conv.rows, 0).id;
    const insertMessage = (patientId: string) =>
      pool.query(`INSERT INTO messages (conversation_id, patient_id, role, body) VALUES ($1, $2, 'patient', 'hello')`, [
        conversationId,
        patientId,
      ]);
    expect(await failure(insertMessage(p2))).toEqual({
      state: '23503',
      constraint: 'messages_conversation_patient_fk',
    });
    expect(await failure(insertMessage(p1))).toBeNull();
  });
});
