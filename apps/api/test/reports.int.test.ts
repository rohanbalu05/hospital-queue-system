/* eslint-disable @typescript-eslint/no-non-null-assertion -- tests index rows they have just created */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ApiError, CallNextResult, Notification, OperationsReport } from '@hqms/contracts';
import {
  type Client,
  at,
  createTestApp,
  doctorId,
  loginAs,
  makeSession,
  patientId,
  type MadeSession,
  type TestApp,
} from './helpers.js';

let t: TestApp;
let admin: Client;
let reception: Client;
let doctor1: Client;
let patient1: Client;
let patient2: Client;

beforeAll(async () => {
  t = await createTestApp();
  admin = await loginAs(t.server, 'admin@hqms.test');
  reception = await loginAs(t.server, 'reception@hqms.test');
  doctor1 = await loginAs(t.server, 'doctor2@hqms.test'); // serves doctor 2's sessions here
  patient1 = await loginAs(t.server, 'patient@hqms.test');
  patient2 = await loginAs(t.server, 'patient2@hqms.test');
});
afterAll(async () => {
  await t.close();
});
beforeEach(() => t.clock.reset());

/** One served visit: book, check in 5 min before the slot, call at `callMinute`, start +1, complete after `duration`. */
async function servedVisit(s: MadeSession, patient: string, callMinute: number, duration: number): Promise<void> {
  t.clock.reset();
  // A doctor has one allocation at a time across files that share this database: clear leftovers first (test-only SQL).
  await t.pool.query(
    `UPDATE queue_entries SET state = 'skipped', skipped_at = now() WHERE doctor_id = $1 AND state IN ('called','in_service')`,
    [doctorId(2)],
  );
  const booked = await reception.post('/appointments', { sessionId: s.id, patientId: patient });
  expect(booked.status).toBe(201);
  const slot = new Date(booked.body.scheduledAt as string).getTime();
  t.clock.set(new Date(slot - 5 * 60_000));
  expect((await reception.post(`/appointments/${booked.body.id}/check-in`, {})).status).toBe(201);
  t.clock.set(at(s, callMinute));
  const called = CallNextResult.parse((await doctor1.post(`/sessions/${s.id}/call-next`, {})).body);
  t.clock.set(at(s, callMinute + 1));
  expect((await doctor1.post(`/visits/${called.entry!.visitId}/start`, {})).status).toBe(200);
  t.clock.set(at(s, callMinute + 1 + duration));
  expect((await doctor1.post(`/visits/${called.entry!.visitId}/complete`, {})).status).toBe(200);
}

describe('FR-15-b operations report', () => {
  it('reports observed throughput, waits and decisions, with targets and measured values clearly separate', async () => {
    const s = await makeSession(admin, { doctor: 2 });
    // The slot is 09:00 for the first booking, 09:20 for the second; eligible = check-in (5 min early = 08:55 / 09:15).
    await servedVisit(s, patientId(12), 5, 10); // waits 10 min (08:55 -> 09:05)
    await servedVisit(s, patientId(13), 30, 10); // waits 15 min (09:15 -> 09:30)
    t.clock.reset();

    const res = await admin.get(`/reports/operations?from=${s.date}&to=${s.date}&doctorId=${doctorId(2)}`);
    expect(res.status).toBe(200);
    const report = OperationsReport.parse(res.body);
    expect(report).toMatchObject({ from: s.date, to: s.date });
    expect(report.throughput).toEqual({ completedVisits: 2, sessions: 1 });

    const all = report.waitsByGroup.find((w) => w.group === 'all')!;
    const groupA = report.waitsByGroup.find((w) => w.group === 'A')!;
    expect(all.n).toBe(2);
    expect(groupA.n).toBe(2);
    expect(all.medianMinutes).toBeCloseTo(12.5, 1);
    expect(all.p95Minutes).toBeGreaterThan(14);
    expect(report.waitsByGroup.find((w) => w.group === 'W')!.n).toBe(0);
    expect(report.waitsByGroup.find((w) => w.group === 'P')!).toMatchObject({ n: 0, medianMinutes: null });

    expect(report.decisionsByReason.map((d) => d.reason)).toEqual(['CLINICAL_PRIORITY', 'AGING', 'ROTATION', 'NO_ALLOCATION']);
    expect(report.decisionsByReason.reduce((n, d) => n + d.count, 0)).toBe(2);

    // Targets and measured values are both present and cannot be confused.
    const targets = report.metrics.filter((m) => m.kind === 'target');
    const measured = report.metrics.filter((m) => m.kind === 'measured');
    expect(targets.length).toBeGreaterThanOrEqual(6);
    expect(measured.length).toBeGreaterThanOrEqual(5);
    for (const m of targets) {
      expect(m.sampleSize).toBeNull();
      expect(m.note).toMatch(/Phase 1 target, not measured here/);
      expect(m.value).not.toBeNull();
    }
    for (const m of measured) {
      expect(m.sampleSize).not.toBeNull();
      expect(m.note ?? '').not.toMatch(/Phase 1 target/);
    }
    const names = report.metrics.map((m) => m.name);
    expect(new Set(names).size).toBe(names.length);
    expect(targets.find((m) => m.name.startsWith('API latency p95, ordinary'))).toMatchObject({ value: 500, unit: 'ms' });
    expect(targets.find((m) => m.name.startsWith('Queue-update freshness'))).toMatchObject({ value: 5000, unit: 'ms' });
    expect(targets.find((m) => m.name.startsWith('Availability'))).toMatchObject({ value: 99.5, unit: '%' });
    expect(measured.find((m) => m.name.startsWith('Median wait'))).toMatchObject({ unit: 'min', sampleSize: 2 });
    expect(measured.find((m) => m.name.startsWith('Mean consultation'))).toMatchObject({ value: 10, sampleSize: 2 });
    // Nothing measured about latency or availability is claimed here.
    expect(measured.some((m) => /latency|availability|freshness/i.test(m.name))).toBe(false);

    // Another doctor's window is empty, not an error, and measured rows then say so (null value, zero sample).
    const empty = OperationsReport.parse((await admin.get(`/reports/operations?from=${s.date}&to=${s.date}&doctorId=${doctorId(3)}`)).body);
    expect(empty.throughput).toEqual({ completedVisits: 0, sessions: 0 });
    expect(empty.metrics.find((m) => m.name.startsWith('Median wait'))).toMatchObject({ value: null, sampleSize: 0 });
  });

  it('is admin only and validates its window', async () => {
    for (const who of [reception, doctor1, patient1]) {
      expect((await who.get('/reports/operations')).status).toBe(403);
    }
    const defaults = await admin.get('/reports/operations');
    expect(defaults.status).toBe(200);
    expect(OperationsReport.parse(defaults.body).from <= OperationsReport.parse(defaults.body).to).toBe(true);
    const backwards = await admin.get('/reports/operations?from=2040-02-01&to=2040-01-01');
    expect(backwards.status).toBe(400);
    expect(ApiError.parse(backwards.body).error.code).toBe('VALIDATION_FAILED');
    expect((await admin.get('/reports/operations?from=2000-01-01&to=2040-01-01')).status).toBe(400);
    expect((await admin.get('/reports/operations?from=yesterday')).status).toBe(400);
  });
});

describe('notifications', () => {
  it('lists only the caller’s notices and marks one read (not someone else’s)', async () => {
    const me = (await patient1.get('/me')).body.userId as string;
    const other = (await patient2.get('/me')).body.userId as string;
    const mine = await t.pool.query<{ id: string }>(
      `INSERT INTO notifications (recipient_user_id, kind, body) VALUES ($1, 'appointment', 'Your appointment is booked') RETURNING id`,
      [me],
    );
    const theirs = await t.pool.query<{ id: string }>(
      `INSERT INTO notifications (recipient_user_id, kind, body) VALUES ($1, 'appointment', 'Not yours') RETURNING id`,
      [other],
    );
    const list = await patient1.get('/notifications');
    expect(list.status).toBe(200);
    const parsed = (list.body as unknown[]).map((n) => Notification.parse(n));
    expect(parsed.map((n) => n.id)).toContain(mine.rows[0]!.id);
    expect(parsed.map((n) => n.id)).not.toContain(theirs.rows[0]!.id);
    expect(parsed.find((n) => n.id === mine.rows[0]!.id)!.readAt).toBeNull();

    const read = await patient1.post(`/notifications/${mine.rows[0]!.id}/read`, {}, null);
    expect(read.status).toBe(201);
    expect(Notification.parse(read.body).readAt).toBeTruthy();
    const firstRead = read.body.readAt as string;
    expect((await patient1.post(`/notifications/${mine.rows[0]!.id}/read`, {}, null)).body.readAt).toBe(firstRead);
    expect((await patient1.post(`/notifications/${theirs.rows[0]!.id}/read`, {}, null)).status).toBe(404);
    expect((await patient1.post(`/notifications/${randomUUID()}/read`, {}, null)).status).toBe(404);
    // unchanged for the owner of the other one
    expect(((await patient2.get('/notifications')).body as Array<{ id: string; readAt: string | null }>).find((n) => n.id === theirs.rows[0]!.id)!.readAt).toBeNull();
  });
});
