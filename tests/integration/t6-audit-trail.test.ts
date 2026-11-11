/**
 * T6 (report Table 5, FR-15, NFR-08): audit-trail reconstruction and the operations report, black box.
 *
 * One complete visit is driven through the real HTTP API (book -> check-in -> priority override -> call -> start ->
 * complete -> follow-up task -> acknowledge -> return booking -> resolve) against a real PostgreSQL. Afterwards a
 * reviewer's view is rebuilt ONLY from GET /audit (admin): every material change must carry actor, time, entity and
 * operation; every queue operation the policy version; every override its doctor and reason (FR-15-a).
 * GET /reports/operations must separate Phase 1 targets from measured rows (FR-15-b).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { type ApiClient } from '../support/client.js';
import { futureIso } from '../support/followup.js';
import { recordResult, T6_RESULTS_FILE } from '../support/results.js';
import {
  admitWalkIns,
  book,
  checkGlobalInvariants,
  closePool,
  databaseUrl,
  doctorId,
  loginAs,
  makeFutureSession,
  makeRunningSession,
  registerPatients,
  seededPatientId,
  sqlRows,
  type MadeSession,
} from '../support/world.js';

/* eslint-disable @typescript-eslint/no-explicit-any */

const DOCTOR = 6; // Dr. Mohammed Irfan, ENT (login doctor6@hqms.test)
const record: Record<string, unknown> = {};

let admin: ApiClient;
let reception: ApiClient;
let doctor: ApiClient;
let followup: ApiClient;
let patient: ApiClient; // patient7@hqms.test
let session: MadeSession;
let returnSession: MadeSession;
let startedAt: string;
let policyVersion: number;
let doctorUserId: string;
let patientUserId: string;
let receptionUserId: string;
let followupUserId: string;
const ids: Record<string, string> = {};
let trail: any[] = [];

beforeAll(async () => {
  startedAt = new Date().toISOString();
  [admin, reception, doctor, followup, patient] = await Promise.all([
    loginAs('admin@hqms.test'),
    loginAs('reception@hqms.test'),
    loginAs('doctor6@hqms.test'),
    loginAs('followup@hqms.test'),
    loginAs('patient7@hqms.test'),
  ]);
  const me = await Promise.all([admin, reception, doctor, followup, patient].map((c) => c.get('/me')));
  const uid = (i: number): string => me[i]?.body.userId as string;
  [receptionUserId, doctorUserId, followupUserId, patientUserId] = [uid(1), uid(2), uid(3), uid(4)];
  policyVersion = (await sqlRows(`SELECT max(version)::int AS v FROM queue_policies`))[0]?.['v'];
}, 120_000);

afterAll(async () => {
  const invariants = await checkGlobalInvariants();
  recordResult('t6AuditTrail', { ...record, globalInvariantViolations: invariants.violations }, T6_RESULTS_FILE);
  await closePool();
});

describe('T6.1 drive one full visit through the API', () => {
  it('book -> check-in -> priority override -> call -> start -> complete -> follow-up -> return booking -> resolve', async () => {
    session = await makeRunningSession(admin, { doctor: DOCTOR, startOffsetMin: -12 });
    returnSession = await makeFutureSession(admin, { doctor: DOCTOR });

    const appt = await book(patient, session.id);
    expect(appt.status, JSON.stringify(appt.body)).toBe(201);
    ids['appointment'] = appt.body.id;
    const checkIn = await reception.post(`/appointments/${appt.body.id}/check-in`, {});
    expect(checkIn.status, JSON.stringify(checkIn.body)).toBe(201);
    ids['queueEntry'] = checkIn.body.queueEntryId;
    ids['patient'] = seededPatientId(7);

    // A walk-in the doctor escalates: this is the queue override whose audit row we must be able to explain.
    const [walkPatient] = await registerPatients(reception, 1, 'T6 priority');
    const [walkin] = await admitWalkIns(reception, session.id, [walkPatient as string]);
    ids['priorityEntry'] = walkin.queueEntryId;
    const entryVersion = (await sqlRows(`SELECT version FROM queue_entries WHERE id = $1`, [walkin.queueEntryId]))[0]?.[
      'version'
    ];
    const prio = await doctor.post(`/queue-entries/${walkin.queueEntryId}/priority`, {
      priorityClass: 1,
      reason: 'Chest pain on arrival',
      expectedVersion: entryVersion,
    });
    expect(prio.status, JSON.stringify(prio.body)).toBe(200);

    // 1st call: the priority walk-in; 2nd call: the booked patient.
    const first = await doctor.post(`/sessions/${session.id}/call-next`, {});
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    expect(first.body.entry.id).toBe(walkin.queueEntryId);
    expect((await doctor.post(`/visits/${first.body.entry.visitId}/start`, {})).status).toBe(200);
    expect((await doctor.post(`/visits/${first.body.entry.visitId}/complete`, {})).status).toBe(200);

    const second = await doctor.post(`/sessions/${session.id}/call-next`, {});
    expect(second.status, JSON.stringify(second.body)).toBe(200);
    expect(second.body.entry.id).toBe(ids['queueEntry']);
    ids['visit'] = second.body.entry.visitId;
    expect((await doctor.post(`/visits/${ids['visit']}/start`, {})).status).toBe(200);
    expect((await doctor.post(`/visits/${ids['visit']}/complete`, {})).status).toBe(200);

    // The follow-up loop: doctor creates the task, follow-up staff acknowledge, book the return, resolve.
    const task = await doctor.post('/follow-up-tasks', {
      patientId: ids['patient'],
      sourceVisitId: ids['visit'],
      kind: 'post_visit',
      title: 'Review in two weeks',
      detail: 'Check recovery and renew the plan if needed.',
      dueAt: futureIso(48),
    });
    expect(task.status, JSON.stringify(task.body)).toBe(201);
    ids['task'] = task.body.id;
    // D-028: a doctor-created task without ownerId gets a DEFAULT owner (a follow-up user assigned to this doctor,
    // fewest open tasks first). Resolve, cancel and the return booking are then done by THAT owner.
    expect(task.body.ownerId, 'default owner assigned').toBeTruthy();
    const owner = (
      await sqlRows(
        `SELECT u.id, u.email, u.role,
                EXISTS (SELECT 1 FROM staff_assignments sa WHERE sa.user_id = u.id AND sa.doctor_id = $2) AS assigned
           FROM users u WHERE u.id = $1`,
        [task.body.ownerId, doctorId(DOCTOR)],
      )
    )[0];
    expect(owner?.['role']).toBe('followup');
    expect(owner?.['assigned'], 'the default owner is assigned to the visit doctor').toBe(true);
    followup = await loginAs(owner?.['email'] as string);
    followupUserId = owner?.['id'] as string;
    record['defaultOwner'] = { role: 'followup', assignedToDoctor: true };
    // a different follow-up user (not the owner, unowned-takeover does not apply) is refused
    const other = await loginAs(
      owner?.['email'] === 'followup@hqms.test' ? 'followup3@hqms.test' : 'followup@hqms.test',
    );
    expect((await other.post(`/follow-up-tasks/${ids['task']}/acknowledge`, {})).status).toBe(403);
    expect((await followup.post(`/follow-up-tasks/${ids['task']}/acknowledge`, {})).status).toBe(200);
    const ret = await followup.post(`/follow-up-tasks/${ids['task']}/return-booking`, { sessionId: returnSession.id });
    expect(ret.status, JSON.stringify(ret.body)).toBe(201);
    ids['returnAppointment'] = ret.body.id;
    const done = await followup.post(`/follow-up-tasks/${ids['task']}/resolve`, {
      disposition: 'return_booked',
      returnAppointmentId: ids['returnAppointment'],
      outcomeNote: 'Return visit booked.',
    });
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    expect(done.body.status).toBe('resolved');
  });
});

describe('T6.2 the audit trail alone reconstructs the visit (FR-15-a)', () => {
  it('GET /audit is admin-only', async () => {
    for (const c of [patient, reception, doctor, followup]) expect((await c.get('/audit')).status).toBe(403);
    const ok = await admin.get('/audit?limit=5');
    expect(ok.status).toBe(200);
    expect(ok.body.length).toBeLessThanOrEqual(5);
  });

  it('every material change has actor, time, entity and operation; timestamps are inside the test window', async () => {
    const res = await admin.get(`/audit?from=${encodeURIComponent(startedAt)}&limit=500`);
    expect(res.status).toBe(200);
    // Restrict to the entities of THIS visit (other suites may have written rows in the window).
    const mine = new Set(Object.values(ids));
    const walkVisit = (await sqlRows(`SELECT visit_id FROM queue_entries WHERE id = $1`, [ids['priorityEntry']]))[0]?.[
      'visit_id'
    ];
    const sessionIds = new Set([session.id, returnSession.id]);
    trail = (res.body as any[])
      .filter((e) => mine.has(e.entityId) || sessionIds.has(e.entityId) || e.entityId === walkVisit)
      .reverse(); // oldest first
    expect(trail.length).toBeGreaterThanOrEqual(12);

    const now = Date.now();
    for (const e of trail) {
      expect(typeof e.id).toBe('number');
      expect(e.actorRole, `row ${e.id}`).toBeTruthy();
      expect(e.operation, `row ${e.id}`).toBeTruthy();
      expect(e.entityType, `row ${e.id}`).toBeTruthy();
      expect(e.entityId, `row ${e.id}`).toMatch(/^[0-9a-f-]{36}$/);
      const t = new Date(e.occurredAt).getTime();
      expect(t, `row ${e.id} time`).toBeGreaterThanOrEqual(new Date(startedAt).getTime() - 1000);
      expect(t, `row ${e.id} time`).toBeLessThanOrEqual(now + 1000);
      // Every human action names its actor; only the worker/system may leave actorId null.
      if (e.actorRole !== 'system') expect(e.actorId, `row ${e.id} ${e.operation}`).toBeTruthy();
    }
    // chronological order: ids and times never go backwards
    for (let i = 1; i < trail.length; i += 1) {
      expect(trail[i].id).toBeGreaterThan(trail[i - 1].id);
      expect(new Date(trail[i].occurredAt).getTime()).toBeGreaterThanOrEqual(
        new Date(trail[i - 1].occurredAt).getTime(),
      );
    }
    record['trailRows'] = trail.length;
    record['trailOperations'] = trail.map((e) => `${e.actorRole}:${e.operation}:${e.entityType}`);
    record['trailTable'] = trail.map((e) => ({
      operation: e.operation,
      actorRole: e.actorRole,
      entityType: e.entityType,
      hasActorId: e.actorId !== null,
      policyVersion: e.policyVersion,
      reason: e.reason,
    }));
  });

  it('the trail names the right actor for each step of the visit, in order', async () => {
    const find = (operation: string, entityId?: string) =>
      trail.filter((e) => e.operation === operation && (entityId === undefined || e.entityId === entityId));
    const one = (operation: string, entityId?: string): any => {
      const rows = find(operation, entityId);
      expect(rows.length, `audit rows for ${operation} ${entityId ?? ''}`).toBeGreaterThanOrEqual(1);
      return rows[0];
    };

    const book1 = one('appointment.book', ids['appointment']);
    expect(book1.actorRole).toBe('patient');
    expect(book1.actorId).toBe(patientUserId);
    // check-in, start and complete are audited on the VISIT (entity type 'visit'); call-next on the queue entry.
    const checkIn = one('visit.check_in', ids['visit']);
    expect(checkIn.actorRole).toBe('reception');
    expect(checkIn.actorId).toBe(receptionUserId);

    const call = one('queue.call_next', ids['queueEntry']);
    expect(call.actorRole).toBe('doctor');
    expect(call.actorId).toBe(doctorUserId);
    expect(call.next.token).toBeTruthy();
    expect(call.next.reason, 'selection reason recorded').toBeTruthy();
    const start = one('consultation.start', ids['visit']);
    const complete = one('consultation.complete', ids['visit']);
    expect(start.actorRole).toBe('doctor');
    expect(start.actorId).toBe(doctorUserId);
    expect(complete.actorRole).toBe('doctor');
    expect(complete.actorId).toBe(doctorUserId);
    expect(new Date(complete.occurredAt).getTime()).toBeGreaterThanOrEqual(new Date(start.occurredAt).getTime());
    expect(new Date(start.occurredAt).getTime()).toBeGreaterThanOrEqual(new Date(call.occurredAt).getTime());

    const created = one('follow_up.create', ids['task']);
    expect(created.actorRole).toBe('doctor');
    expect(created.actorId).toBe(doctorUserId);
    expect(created.next.ownerId, 'the audit row records the default owner (D-028)').toBe(followupUserId);
    const ack = one('follow_up.acknowledge', ids['task']);
    expect(ack.actorRole).toBe('followup');
    expect(ack.actorId).toBe(followupUserId);
    const returned = one('follow_up.return_booking', ids['task']);
    expect(returned.actorId).toBe(followupUserId);
    expect(returned.next.returnAppointmentId).toBe(ids['returnAppointment']);
    const resolved = one('follow_up.resolve', ids['task']);
    expect(resolved.actorId).toBe(followupUserId);
    expect(resolved.reason).toBe('Return visit booked.');
    expect(resolved.next.disposition).toBe('return_booked');

    // The return booking is audited as a booking of the linked appointment too.
    const returnBook = trail.find((e) => e.entityId === ids['returnAppointment'] && /book/.test(e.operation));
    expect(returnBook, 'booking audit row of the return appointment').toBeDefined();
    expect(returnBook.actorId).toBe(followupUserId);
    record['actors'] = { patient: 'patient', reception: 'reception', doctor: 'doctor', followup: 'followup' };
  });

  it('every queue operation records the policy version in force', async () => {
    // Queue operations: call-next, priority, check-in, walk-in, consultation start/complete, session open.
    const isQueueOp = (op: string): boolean =>
      /^(queue\.|consultation\.|visit\.(check_in|walk_in)|session\.(open|pause|resume|close|unavailable))/.test(op);
    const queueRows = trail.filter((e) => isQueueOp(e.operation));
    // 2 x (check-in or walk-in, call, start, complete) + priority + session open
    expect(queueRows.length).toBeGreaterThanOrEqual(10);
    for (const e of queueRows) {
      expect(e.policyVersion, `${e.operation} (row ${e.id}) policy version`).toBe(policyVersion);
    }
    record['queueOperationsChecked'] = queueRows.length;
    // arrival and booking operations carry it too when the policy took part in the decision
    const withPolicy = trail.filter((e) => e.policyVersion !== null);
    record['rowsWithPolicyVersion'] = { withPolicy: withPolicy.length, total: trail.length, policyVersion };
  });

  it('a priority override shows doctor, time, entity, reason and policy version (FR-15-a)', async () => {
    const rows = trail.filter((e) => e.entityId === ids['priorityEntry'] && /priority/.test(e.operation));
    expect(rows).toHaveLength(1);
    const o = rows[0];
    expect(o.actorRole).toBe('doctor');
    expect(o.actorId).toBe(doctorUserId);
    expect(o.entityType).toBe('queue_entry');
    expect(o.entityId).toBe(ids['priorityEntry']);
    expect(o.reason).toBe('Chest pain on arrival');
    expect(o.policyVersion).toBe(policyVersion);
    expect(new Date(o.occurredAt).getTime()).toBeGreaterThan(new Date(startedAt).getTime());
    // before/after of the override are in the row
    expect(JSON.stringify(o.previous)).toBeTruthy();
    expect(JSON.stringify(o.next)).toContain('1');
    // and the same override is explainable from the decision log: the next call cites clinical priority
    const decisions = await doctor.get(`/sessions/${session.id}/decisions`);
    const first = (decisions.body as any[]).at(-1);
    expect(first.reason).toBe('CLINICAL_PRIORITY');
    expect(first.policyVersion).toBe(policyVersion);
    record['override'] = {
      operation: o.operation,
      actor: 'doctor',
      reason: o.reason,
      policyVersion: o.policyVersion,
      occurredAt: o.occurredAt,
      nextDecision: first.reason,
    };
  });

  it('reception cannot make the override (403) and a refused attempt leaves no override row', async () => {
    const before = (
      await sqlRows(`SELECT count(*)::int AS n FROM audit_events WHERE operation LIKE 'queue.priority%'`)
    )[0]?.['n'];
    const r = await reception.post(`/queue-entries/${ids['priorityEntry']}/priority`, {
      priorityClass: 2,
      reason: 'Pushy relative',
    });
    expect(r.status).toBe(403);
    const after = (
      await sqlRows(`SELECT count(*)::int AS n FROM audit_events WHERE operation LIKE 'queue.priority%'`)
    )[0]?.['n'];
    expect(after).toBe(before);
  });

  it('the filters of GET /audit narrow by entity, and the append-only property is reported honestly', async () => {
    const byEntity = await admin.get(`/audit?entityType=follow_up_task&entityId=${ids['task']}`);
    expect(byEntity.status).toBe(200);
    expect((byEntity.body as any[]).map((e) => e.operation).reverse()).toEqual([
      'follow_up.create',
      'follow_up.acknowledge',
      'follow_up.return_booking',
      'follow_up.resolve',
    ]);
    // Migration 0006: the audit trail is append-only at database level. UPDATE and DELETE of a row of this visit fail.
    const probe = await sqlRows(
      `SELECT count(*)::int AS triggers FROM pg_trigger WHERE tgrelid = 'audit_events'::regclass AND NOT tgisinternal`,
    );
    record['auditTableTriggers'] = probe[0]?.['triggers'];
    expect(probe[0]?.['triggers']).toBeGreaterThanOrEqual(1);
    const target = trail[0];
    const beforeRow = (
      await sqlRows(`SELECT operation, reason, actor_id::text AS actor_id FROM audit_events WHERE id = $1`, [target.id])
    )[0];
    const client = new pg.Client({ connectionString: databaseUrl() });
    await client.connect();
    const outcomes: Record<string, string> = {};
    try {
      for (const [label, text] of [
        ['update reason', `UPDATE audit_events SET reason = 'tampered' WHERE id = $1`],
        ['update actor', `UPDATE audit_events SET actor_id = NULL WHERE id = $1`],
        ['delete row', `DELETE FROM audit_events WHERE id = $1`],
      ] as Array<[string, string]>) {
        let message = '';
        try {
          await client.query(text, [target.id]);
        } catch (e) {
          message = e instanceof Error ? e.message : String(e);
        }
        outcomes[label] = message || 'SUCCEEDED';
        expect(message, label).toMatch(/append-only/);
      }
    } finally {
      await client.end();
    }
    const afterRow = (
      await sqlRows(`SELECT operation, reason, actor_id::text AS actor_id FROM audit_events WHERE id = $1`, [target.id])
    )[0];
    expect(afterRow).toEqual(beforeRow);
    record['auditAppendOnly'] = outcomes;
  });
});

describe('T6.3 operations report separates targets from measured values (FR-15-b)', () => {
  it('GET /reports/operations returns target rows and measured rows, never a target presented as measured', async () => {
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());
    const res = await admin.get(`/reports/operations?from=${today}&to=${today}`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const rep = res.body;
    expect(rep.throughput.completedVisits).toBeGreaterThanOrEqual(2); // this suite's two completed visits
    expect(rep.throughput.sessions).toBeGreaterThanOrEqual(1);
    expect(rep.waitsByGroup.length).toBeGreaterThan(0);
    expect(rep.decisionsByReason.some((d: any) => d.reason === 'CLINICAL_PRIORITY')).toBe(true);

    const targets = rep.metrics.filter((m: any) => m.kind === 'target');
    const measured = rep.metrics.filter((m: any) => m.kind === 'measured');
    expect(targets.length).toBeGreaterThanOrEqual(5);
    expect(measured.length).toBeGreaterThanOrEqual(1);
    for (const m of targets) {
      expect(m.sampleSize, `target "${m.name}" has no sample`).toBeNull();
      expect(m.note ?? '').toMatch(/target/i);
      expect(m.value).not.toBeNull();
    }
    for (const m of measured) {
      expect(m.sampleSize, `measured "${m.name}" states its sample size`).not.toBeNull();
      expect(m.note ?? '').not.toMatch(/Phase 1 target, not measured/);
    }
    // a metric name never appears as both
    const names = new Set(targets.map((m: any) => m.name));
    for (const m of measured) expect(names.has(m.name), m.name).toBe(false);
    // non-admin roles cannot read it
    for (const c of [patient, reception, doctor, followup])
      expect((await c.get('/reports/operations')).status).toBe(403);
    // bad range
    expect((await admin.get('/reports/operations?from=2030-02-01&to=2030-01-01')).status).toBe(400);
    record['report'] = {
      completedVisits: rep.throughput.completedVisits,
      targetRows: targets.length,
      measuredRows: measured.length,
      targetNames: targets.map((m: any) => `${m.name} = ${m.value} ${m.unit}`),
      measuredNames: measured.map((m: any) => `${m.name} = ${m.value} ${m.unit} (n=${m.sampleSize})`),
      waitsByGroup: rep.waitsByGroup,
    };
  });
});

describe('T6.4 release record', () => {
  it('records migrations applied, policy version and constants of the database under test', async () => {
    const migrations = await sqlRows(`SELECT version, checksum FROM schema_migrations ORDER BY version`);
    expect(migrations.length).toBeGreaterThanOrEqual(5);
    const policies = await sqlRows(
      `SELECT version, rotation, early_eligibility_min, late_grace_min, aging_trigger_min, called_timeout_sec,
              ewma_alpha::float AS ewma_alpha, initial_estimate_min::float AS initial_estimate_min,
              default_booked_capacity, default_walkin_capacity
         FROM queue_policies ORDER BY version`,
    );
    const p = policies.at(-1) as any;
    expect(p.version).toBe(policyVersion);
    expect(p.rotation).toEqual(['A', 'A', 'W']);
    expect([p.early_eligibility_min, p.late_grace_min, p.aging_trigger_min, p.called_timeout_sec]).toEqual([
      10, 15, 45, 120,
    ]);
    expect([p.ewma_alpha, p.initial_estimate_min, p.default_booked_capacity, p.default_walkin_capacity]).toEqual([
      0.2, 12, 10, 5,
    ]);
    // every session the suite created references the policy version it ran under
    const sess = await sqlRows(
      `SELECT p.version FROM sessions s JOIN queue_policies p ON p.id = s.policy_id WHERE s.id = $1`,
      [session.id],
    );
    expect(sess[0]?.['version']).toBe(policyVersion);
    record['release'] = {
      migrations: migrations.map((m) => m['version']),
      policy: p,
      doctor: doctorId(DOCTOR),
    };
  });
});
