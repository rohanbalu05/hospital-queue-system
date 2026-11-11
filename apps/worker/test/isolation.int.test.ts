/*
 * NFR-07 failure isolation: provider failures (OCR, notifications, the whole worker being down) must never
 * block booking or queue operations. These tests inject failures into the worker side while real booking and
 * call-next style transactions run against the same database, then check core invariants.
 */
import type { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { capacityInvariant, enqueueJob, lockCapacity, lockDoctor, lockSession, withTransaction } from '@hqms/db';
import { defaultHandlers } from '../src/handlers/index.js';
import { OutboxDispatcher } from '../src/outbox.js';
import { JobRunner } from '../src/runner.js';
import type { JobHandler } from '../src/types.js';
import {
  bookAppointment,
  getJob,
  insertJob,
  makeEntry,
  makePool,
  makeWorld,
  must,
  sleep,
  testLog,
  type World,
} from './helpers.js';

let worker: Pool; // the worker's pool
let api: Pool; // stands in for the API's pool
let w: World;

beforeAll(() => {
  worker = makePool(8);
  api = makePool(8);
});
afterAll(async () => {
  await Promise.all([worker.end(), api.end()]);
});
beforeEach(async () => {
  await api.query(`DELETE FROM jobs`);
  await api.query(`UPDATE outbox_events SET dispatched_at = now() WHERE dispatched_at IS NULL`);
  w = await makeWorld(api, { booked: 30 });
});

async function waitFor(cond: () => Promise<boolean>, ms = 5000): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await cond()) return;
    await sleep(25);
  }
  throw new Error('condition not met in time');
}

/** What the API does on every booking/queue request: take the three guards in order and write. */
async function bookingBurst(n: number): Promise<number> {
  const t0 = Date.now();
  await Promise.all(
    Array.from({ length: n }, () => bookAppointment(api, w, { scheduledAt: new Date(Date.now() + 3_600_000) })),
  );
  return Date.now() - t0;
}

async function callNextLikeTx(): Promise<void> {
  await withTransaction(api, async (tx) => {
    await lockDoctor(tx, w.doctorId);
    await lockSession(tx, w.sessionId);
    await lockCapacity(tx, w.sessionId);
    await tx.query(`UPDATE sessions SET queue_version = queue_version + 1 WHERE id = $1`, [w.sessionId]);
  });
}

describe('NFR-07 failure injection', () => {
  it('an OCR provider that fails every time never blocks timers, booking or queue operations', async () => {
    const calledAt = new Date(Date.now() - 5 * 60_000);
    const e = await makeEntry(api, w, { calledAt });
    const appt = await bookAppointment(api, w, { scheduledAt: new Date(Date.now() - 3_600_000) });

    let ocrCalls = 0;
    const ocr: JobHandler = async () => {
      ocrCalls++;
      throw new Error('OCR provider unavailable (injected)');
    };
    const handlers = { ...defaultHandlers(), ocr_document: ocr };
    const runner = new JobRunner({
      pool: worker,
      workerId: 'iso-1',
      handlers,
      concurrency: 4,
      pollMs: 20,
      renewEveryMs: 0,
      backoffCapSec: 1,
      log: testLog,
    });

    const poison: string[] = [];
    for (let i = 0; i < 6; i++) {
      poison.push(
        await insertJob(api, {
          type: 'ocr_document',
          payload: { documentId: `doc-${i}` },
          maxAttempts: 2,
          runAt: new Date(Date.now() - 1000),
        }),
      );
    }
    const timer = await withTransaction(api, (tx) =>
      enqueueJob(tx, {
        jobType: 'call_timeout',
        payload: { queueEntryId: e.entryId, calledAt: calledAt.toISOString() },
        dedupeKey: `iso:ct:${e.entryId}`,
      }),
    );
    const release = await insertJob(api, {
      type: 'reservation_release',
      payload: { appointmentId: appt.appointmentId },
    });

    runner.start();
    try {
      // Bookings and queue transactions run while the provider is failing.
      const elapsed = await bookingBurst(10);
      await callNextLikeTx();
      expect(elapsed).toBeLessThan(5000);

      await waitFor(async () => {
        const rows = (await api.query(`SELECT state FROM jobs WHERE id = ANY($1::uuid[])`, [[timer, release]])).rows;
        return rows.every((r) => r.state === 'succeeded');
      });
    } finally {
      await runner.stop(5000);
    }

    // The timers did their work despite the poisoned jobs competing for slots.
    expect((await api.query(`SELECT state FROM queue_entries WHERE id = $1`, [e.entryId])).rows[0].state).toBe(
      'skipped',
    );
    expect(
      (await api.query(`SELECT status FROM appointments WHERE id = $1`, [appt.appointmentId])).rows[0].status,
    ).toBe('missed');

    // The failing provider's jobs are visible, not silently dropped: retried, then dead with the error.
    const drained = new JobRunner({
      pool: worker,
      workerId: 'iso-2',
      handlers,
      pollMs: 20,
      renewEveryMs: 0,
      log: testLog,
      clock: () => new Date(Date.now() + 60_000),
    });
    await drained.drain();
    for (const id of poison) {
      const j = await getJob(api, id);
      expect(j.state).toBe('dead');
      expect(j.attempts).toBe(2);
      expect(j.last_error).toContain('OCR provider unavailable');
    }
    expect(ocrCalls).toBe(12);

    // Core invariants unchanged by the failures.
    const inv = await withTransaction(api, (tx) => capacityInvariant(tx, w.sessionId));
    expect(inv.ok).toBe(true);
  });

  it('a provider call that hangs forever holds no database lock and does not stop other jobs', async () => {
    const e = await makeEntry(api, w, { calledAt: new Date(Date.now() - 5 * 60_000) });
    let hungStarted = false;
    const hang: JobHandler = () => {
      hungStarted = true;
      return new Promise(() => {}); // never settles
    };
    const handlers = { ...defaultHandlers(), ocr_document: hang };
    const runner = new JobRunner({
      pool: worker,
      workerId: 'iso-hang',
      handlers,
      concurrency: 2,
      pollMs: 20,
      renewEveryMs: 0,
      handlerTimeoutMs: 60_000,
      log: testLog,
    });
    const hung = await insertJob(api, { type: 'ocr_document', payload: { documentId: 'doc-hang' } });
    const timer = await insertJob(api, {
      type: 'call_timeout',
      payload: {
        queueEntryId: e.entryId,
        calledAt: (await api.query(`SELECT called_at FROM queue_entries WHERE id = $1`, [e.entryId])).rows[0].called_at,
      },
    });

    runner.start();
    try {
      await waitFor(async () => hungStarted);
      await waitFor(async () => (await getJob(api, timer)).state === 'succeeded');
      expect(runner.inFlight).toBe(1); // the hung handler occupies one slot, the other slot kept working

      // No guard row is held by the hung job: a NOWAIT lock on all three succeeds immediately.
      await withTransaction(api, async (tx) => {
        await tx.query(`SELECT id FROM doctors WHERE id = $1 FOR NO KEY UPDATE NOWAIT`, [w.doctorId]);
        await tx.query(`SELECT id FROM sessions WHERE id = $1 FOR NO KEY UPDATE NOWAIT`, [w.sessionId]);
        await tx.query(`SELECT session_id FROM session_capacity WHERE session_id = $1 FOR NO KEY UPDATE NOWAIT`, [
          w.sessionId,
        ]);
      });
      // And no transaction of the worker is sitting open.
      const idle = await api.query(
        `SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND state = 'idle in transaction' AND application_name = 'worker-test'`,
      );
      expect(idle.rows[0].n).toBe(0);

      expect(await bookingBurst(5)).toBeLessThan(5000);
      expect((await getJob(api, hung)).state).toBe('running');
    } finally {
      // Gives up on the hung handler; it writes no outcome, its lease expires and the job is re-claimed.
      await expect(runner.stop(200)).resolves.toEqual({ abandoned: 1 });
    }
    expect((await getJob(api, hung)).state).toBe('running');
  });

  it('with no worker running at all, booking and queue operations work and job intent waits durably', async () => {
    const e = await makeEntry(api, w, { calledAt: new Date() });
    const id = await withTransaction(api, (tx) =>
      enqueueJob(tx, {
        jobType: 'call_timeout',
        payload: { queueEntryId: e.entryId, calledAt: new Date().toISOString() },
        dedupeKey: `iso:down:${e.entryId}`,
      }),
    );
    await bookingBurst(8);
    await callNextLikeTx();
    expect((await getJob(api, must(id))).state).toBe('pending');
    const inv = await withTransaction(api, (tx) => capacityInvariant(tx, w.sessionId));
    expect(inv.ok).toBe(true);
    expect(inv.counters.bookedReserved).toBe(8);
  });

  it('a notification fan-out that fails for every event does not affect booking, and events stay pending', async () => {
    const dispatcher = new OutboxDispatcher({
      pool: worker,
      pollMs: 20,
      log: testLog,
      render: async () => {
        throw new Error('notification backend down (injected)');
      },
    });
    dispatcher.start();
    try {
      const elapsed = await bookingBurst(10);
      await callNextLikeTx();
      expect(elapsed).toBeLessThan(5000);
      await sleep(100);
    } finally {
      await dispatcher.stop();
    }
    const n = await api.query(
      `SELECT count(*)::int AS n FROM notifications WHERE kind = 'AppointmentBooked' AND created_at > now() - interval '1 minute'`,
    );
    expect(n.rows[0].n).toBe(0);
    const inv = await withTransaction(api, (tx) => capacityInvariant(tx, w.sessionId));
    expect(inv.ok).toBe(true);
    expect(inv.counters.bookedReserved).toBe(10);
  });

  it('losing the database connection for the worker only affects the worker; its loop keeps running', async () => {
    const dead = makePool(2);
    const runner = new JobRunner({
      pool: dead,
      workerId: 'iso-db',
      handlers: defaultHandlers(),
      pollMs: 20,
      renewEveryMs: 0,
      log: testLog,
    });
    runner.start();
    await dead.end(); // every later claim fails with "pool has ended"
    try {
      expect(await bookingBurst(3)).toBeLessThan(5000);
      await sleep(100);
    } finally {
      await expect(runner.stop(1000)).resolves.toEqual({ abandoned: 0 });
    }
  });
});
