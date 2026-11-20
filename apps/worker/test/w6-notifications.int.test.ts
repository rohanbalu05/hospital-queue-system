/* eslint-disable @typescript-eslint/no-non-null-assertion -- tests index rows they have just created */
import type { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { NOTIFICATION_LINKS } from '@hqms/contracts';
import { withTransaction, writeOutbox, type OutboxInput } from '@hqms/db';
import { dispatchOutboxBatch } from '../src/outbox.js';
import { bookAppointment, makeEntry, makePatient, makePool, makeWorld } from './helpers.js';

/** PR-30: a reopened session tells people the doctor is available again. PR-14: a follow-up reply is announced, never quoted. */

let pool: Pool;
beforeAll(() => {
  pool = makePool(6);
});
afterAll(async () => {
  await pool.query(`UPDATE jobs SET state = 'cancelled' WHERE job_type = 'deliver_notification' AND state IN ('pending', 'failed')`);
  await pool.end();
});
beforeEach(async () => {
  await pool.query(`UPDATE outbox_events SET dispatched_at = now() WHERE dispatched_at IS NULL`);
});

const emit = (e: OutboxInput) => withTransaction(pool, (tx) => writeOutbox(tx, e));
const rowsFor = async (userId: string) =>
  (await pool.query(`SELECT kind, body, link, severity FROM notifications WHERE recipient_user_id = $1 ORDER BY created_at`, [userId])).rows;

describe('SessionResumed with reopened = true (PR-30)', () => {
  it('patients and reception are told the doctor is available again, with the right wording and links', async () => {
    const w = await makeWorld(pool);
    await pool.query(`INSERT INTO staff_assignments (user_id, doctor_id) VALUES ($1, $2)`, [w.receptionUserId, w.doctorId]);
    const name = (await pool.query(`SELECT full_name FROM doctors WHERE id = $1`, [w.doctorId])).rows[0].full_name as string;
    const dr = /^dr\.?\s/i.test(name) ? name : `Dr ${name}`;
    const waiting = await makeEntry(pool, w, { state: 'waiting', login: true });
    const appt = new Date('2030-03-01T05:30:00Z'); // 11:00 am IST
    const booked = await bookAppointment(pool, w, { scheduledAt: appt, login: true });

    await emit({
      eventType: 'SessionResumed',
      entityType: 'session',
      entityId: w.sessionId,
      entityVersion: 5,
      sessionId: w.sessionId,
      payload: { queueVersion: 9, status: 'open', pauseUntil: null, update: false, doctorId: w.doctorId, reopened: true },
    });
    const r = await dispatchOutboxBatch(pool);
    expect(r.failed).toEqual([]);

    expect(await rowsFor(waiting.userId!)).toEqual([
      {
        kind: 'SessionResumed',
        body: `${dr} is available again for this session. Your place in the queue is kept.`,
        link: NOTIFICATION_LINKS.patientVisit(w.sessionId),
        severity: 'info',
      },
    ]);
    expect(await rowsFor(booked.userId!)).toEqual([
      {
        kind: 'SessionResumed',
        body: `${dr} is available again for this session. Your 11:00 am appointment stands.`,
        link: NOTIFICATION_LINKS.patientToday(),
        severity: 'info',
      },
    ]);
    expect(await rowsFor(w.receptionUserId)).toEqual([
      {
        kind: 'SessionResumed',
        body: `${dr} is available again (session reopened by admin).`,
        link: NOTIFICATION_LINKS.receptionSession(w.sessionId),
        severity: 'info',
      },
    ]);
  });

  it('an ordinary "I\'m back" keeps its old wording', async () => {
    const w = await makeWorld(pool);
    const waiting = await makeEntry(pool, w, { state: 'waiting', login: true });
    await emit({
      eventType: 'SessionResumed',
      entityType: 'session',
      entityId: w.sessionId,
      entityVersion: 3,
      sessionId: w.sessionId,
      payload: { queueVersion: 4, status: 'open', pauseUntil: null, update: false, doctorId: w.doctorId },
    });
    await dispatchOutboxBatch(pool);
    const rows = await rowsFor(waiting.userId!);
    expect(rows[0]!.body).toMatch(/is back and seeing patients again\. Your place in the queue is unchanged\.$/);
  });
});

describe('FollowUpResolved with a patient reply (PR-14)', () => {
  async function task(opts: { reply: string | null; kind?: string; login?: boolean }) {
    const w = await makeWorld(pool);
    const p = await makePatient(pool, w, { login: opts.login ?? true });
    const id = (
      await pool.query(
        `INSERT INTO follow_up_tasks (patient_id, kind, title, due_at, owner_id, status, disposition, outcome_note, resolved_at, patient_reply, patient_reply_at, created_at)
         VALUES ($1, $2, 'Call patient', now() + interval '1 day', $3, 'resolved', 'advice_given', 'Staff note', now(), $4, CASE WHEN $4::text IS NULL THEN NULL ELSE now() END, '2030-03-01T05:30:00Z')
         RETURNING id`,
        [p.patientId, opts.kind ?? 'assistant_escalation', w.receptionUserId, opts.reply],
      )
    ).rows[0].id as string;
    return { id, p };
  }
  const resolved = (id: string, patientId: string, payload: Record<string, unknown>) =>
    emit({ eventType: 'FollowUpResolved', entityType: 'follow_up_task', entityId: id, entityVersion: 2, patientId, payload });

  it('tells the patient a reply is waiting: in-app only, link to Follow-ups, never the reply text', async () => {
    const { id, p } = await task({ reply: 'SECRETREPLY keep taking the tablet' });
    await pool.query(`UPDATE patients SET phone = '+91 9000000001' WHERE id = $1`, [p.patientId]);
    await resolved(id, p.patientId, { disposition: 'advice_given', hasReply: true });
    expect((await dispatchOutboxBatch(pool)).failed).toEqual([]);
    const rows = await rowsFor(p.userId!);
    expect(rows).toEqual([
      {
        kind: 'FollowUpResolved',
        body: 'The care team has replied about your question from 1 Mar. Open Follow-ups to read it.',
        link: NOTIFICATION_LINKS.patientFollowUps(),
        severity: 'info',
      },
    ]);
    expect(JSON.stringify(rows)).not.toContain('SECRETREPLY');
    // in-app only: no SMS or email delivery rows
    const channels = await pool.query(`SELECT channel FROM notification_deliveries WHERE patient_id = $1`, [p.patientId]);
    expect(channels.rows.map((r) => r.channel)).toEqual(['in_app']);
  });

  it('other kinds say "follow-up"; no reply, a cancelled task, or a patient without a login notify nobody', async () => {
    const other = await task({ reply: 'Come on Monday please', kind: 'post_visit' });
    await resolved(other.id, other.p.patientId, { disposition: 'advice_given', hasReply: true });
    const noReply = await task({ reply: null });
    await resolved(noReply.id, noReply.p.patientId, { disposition: 'no_action_needed', hasReply: false });
    const cancelled = await task({ reply: 'Reply that should not be announced' });
    await resolved(cancelled.id, cancelled.p.patientId, { cancelled: true });
    const noLogin = await task({ reply: 'Visit reception to collect', login: false });
    await resolved(noLogin.id, noLogin.p.patientId, { disposition: 'advice_given', hasReply: true });
    await dispatchOutboxBatch(pool);

    expect((await rowsFor(other.p.userId!))[0]!.body).toBe('The care team has replied about your follow-up from 1 Mar. Open Follow-ups to read it.');
    expect(await rowsFor(noReply.p.userId!)).toEqual([]);
    expect(await rowsFor(cancelled.p.userId!)).toEqual([]);
    expect((await pool.query(`SELECT 1 FROM notifications WHERE kind = 'FollowUpResolved' AND body LIKE '%should not%'`)).rowCount).toBe(0);
  });

  it('replaying the event adds nothing', async () => {
    const { id, p } = await task({ reply: 'A reply for you' });
    await resolved(id, p.patientId, { disposition: 'advice_given', hasReply: true });
    await dispatchOutboxBatch(pool);
    await pool.query(`UPDATE outbox_events SET dispatched_at = NULL WHERE entity_id = $1`, [id]);
    await dispatchOutboxBatch(pool);
    expect(await rowsFor(p.userId!)).toHaveLength(1);
  });
});
