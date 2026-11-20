/* eslint-disable @typescript-eslint/no-non-null-assertion -- tests index rows they have just created */
/* PR-22: registering a patient who looks like an existing one needs confirmNew. */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ApiError, Patient, PossibleDuplicates } from '@hqms/contracts';
import { type Client, type TestApp, createTestApp, loginAs } from './helpers.js';

let t: TestApp;
let reception: Client;
let admin: Client;
let patientUser: Client;

beforeAll(async () => {
  t = await createTestApp();
  reception = await loginAs(t.server, 'reception@hqms.test');
  admin = await loginAs(t.server, 'admin@hqms.test');
  patientUser = await loginAs(t.server, 'patient@hqms.test');
});
afterAll(() => t.close());

/** A phone nobody else uses: 10 random digits starting 7 (kept apart from the seeded ones). */
const freshDigits = () => `7${Math.floor(Math.random() * 1e9).toString().padStart(9, '0')}`;
const uniqueName = (prefix = 'Dup') => `${prefix} ${randomUUID().slice(0, 8).replace(/[0-9]/g, 'x')} Test`;
const dupes = (body: unknown) => PossibleDuplicates.parse(ApiError.parse(body).error.details);

describe('POST /patients duplicate check (PR-22)', () => {
  it('the same phone (any formatting, last 10 digits) is refused with the candidates; confirmNew creates', async () => {
    const digits = freshDigits();
    const first = await reception.post('/patients', { fullName: uniqueName('Kiran'), phone: `+91 ${digits}` }, null);
    expect(first.status).toBe(201);

    for (const phone of [digits, `+91${digits}`, `0${digits}`, `+91 ${digits.slice(0, 5)} ${digits.slice(5)}`]) {
      const res = await reception.post('/patients', { fullName: uniqueName('Other'), phone }, null);
      expect(res.status).toBe(409);
      expect(ApiError.parse(res.body).error.code).toBe('CONFLICT');
      const d = dupes(res.body);
      expect(d.candidates.map((c) => c.id)).toContain(first.body.id);
      expect(Patient.parse(d.candidates[0])).toBeTruthy();
    }

    const confirmed = await reception.post('/patients', { fullName: uniqueName('Other'), phone: digits, confirmNew: true }, null);
    expect(confirmed.status).toBe(201);
    expect(confirmed.body.id).not.toBe(first.body.id);
  });

  it('a different phone with the same name is fine when a phone is given', async () => {
    const name = uniqueName('Same');
    expect((await reception.post('/patients', { fullName: name, phone: freshDigits() }, null)).status).toBe(201);
    expect((await reception.post('/patients', { fullName: name, phone: freshDigits() }, null)).status).toBe(201);
  });

  it('with no phone, the same name (case and spacing ignored) is refused; confirmNew creates; a new name is fine', async () => {
    const name = uniqueName('Nophone');
    const first = await reception.post('/patients', { fullName: name }, null);
    expect(first.status).toBe(201);
    const again = await reception.post('/patients', { fullName: `  ${name.toUpperCase()} ` }, null);
    expect(again.status).toBe(409);
    expect(dupes(again.body).candidates.map((c) => c.id)).toEqual([first.body.id]);
    const nullPhone = await reception.post('/patients', { fullName: name, phone: null }, null);
    expect(nullPhone.status).toBe(409);
    expect((await reception.post('/patients', { fullName: name, confirmNew: true }, null)).status).toBe(201);
    expect((await reception.post('/patients', { fullName: uniqueName('Nophone') }, null)).status).toBe(201);
  });

  it('returns at most 10 candidates', async () => {
    const digits = freshDigits();
    for (let i = 0; i < 12; i += 1) {
      expect((await reception.post('/patients', { fullName: uniqueName('Many'), phone: digits, confirmNew: true }, null)).status).toBe(201);
    }
    const res = await reception.post('/patients', { fullName: uniqueName('Many'), phone: digits }, null);
    expect(res.status).toBe(409);
    expect(dupes(res.body).candidates).toHaveLength(10);
  });

  it('audits counts only: no names or phone numbers in the audit rows', async () => {
    const digits = freshDigits();
    const name = uniqueName('Audit');
    await reception.post('/patients', { fullName: name, phone: digits }, null);
    const refused = await reception.post('/patients', { fullName: uniqueName('Audit2'), phone: digits }, null);
    expect(refused.status).toBe(409);
    const ok = await reception.post('/patients', { fullName: uniqueName('Audit3'), phone: digits, confirmNew: true }, null);
    expect(ok.status).toBe(201);

    const rows = await t.pool.query(
      `SELECT operation, next FROM audit_events
        WHERE operation IN ('patient.register.duplicate', 'patient.register') AND next::text LIKE '%candidateCount%'
        ORDER BY occurred_at DESC LIMIT 2`,
    );
    const ops = rows.rows.map((r) => r.operation);
    expect(ops).toEqual(expect.arrayContaining(['patient.register.duplicate', 'patient.register']));
    const dup = rows.rows.find((r) => r.operation === 'patient.register.duplicate')!;
    expect(dup.next).toEqual({ candidateCount: 1 });
    const reg = rows.rows.find((r) => r.operation === 'patient.register')!;
    expect(reg.next).toMatchObject({ confirmedNew: true, candidateCount: 1 });
    const text = JSON.stringify(rows.rows);
    expect(text).not.toContain(digits);
    expect(text).not.toContain('Audit');
  });

  it('an idempotent replay of a successful registration returns the same patient (no second duplicate check)', async () => {
    const key = randomUUID();
    const body = { fullName: uniqueName('Replay'), phone: freshDigits() };
    const a = await reception.post('/patients', body, key);
    const b = await reception.post('/patients', body, key);
    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
    expect(b.body.id).toBe(a.body.id);
  });

  it('admin may register; a patient may not', async () => {
    expect((await admin.post('/patients', { fullName: uniqueName('Adm') }, null)).status).toBe(201);
    expect((await patientUser.post('/patients', { fullName: uniqueName('Pat') }, null)).status).toBe(403);
  });
});
