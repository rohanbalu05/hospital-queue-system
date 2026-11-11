import type { Pool } from 'pg';
import { withTransaction, type Tx } from '@hqms/db';
import { errorSummary, silentLogger, type Logger } from './log.js';
import { systemClock, type Clock } from './types.js';

/*
 * Outbox dispatcher: turns committed domain events into in-app notifications (report §6.7).
 *
 * One short transaction per batch: claim undispatched events FOR UPDATE SKIP LOCKED (two dispatchers get
 * disjoint batches), insert notifications, stamp dispatched_at, commit. The insert is also
 * ON CONFLICT (recipient_user_id, event_id) DO NOTHING, so at-least-once redelivery (crash before
 * commit, manual reset of dispatched_at) can never create a second notification.
 *
 * Notification text is short plain language built from routing data only: token, room, time, doctor name.
 * No clinical text ever reaches a notification (the events do not carry any).
 *
 * dispatched_at records "notification fan-out done". The SSE stream reads outbox_events by position and
 * must not depend on it.
 */

export interface OutboxEventRow {
  position: number;
  id: string;
  eventType: string;
  entityType: string;
  entityId: string;
  entityVersion: number;
  sessionId: string | null;
  patientId: string | null;
  payload: Record<string, unknown>;
}

export interface RenderedNotification {
  recipientUserId: string;
  kind: string;
  body: string;
}

export type NotificationRenderer = (tx: Tx, ev: OutboxEventRow) => Promise<RenderedNotification | null>;

const PATIENT_EVENTS = new Set([
  'AppointmentBooked',
  'AppointmentRescheduled',
  'AppointmentCancelled',
  'ReservationReleased',
  'QueuePatientCalled',
  'QueuePatientSkipped',
  'FollowUpOpened',
]);

const whenFmt = new Intl.DateTimeFormat('en-IN', {
  timeZone: 'Asia/Kolkata',
  day: 'numeric',
  month: 'short',
  hour: 'numeric',
  minute: '2-digit',
  hour12: true,
});

/** "12 Nov, 10:20 am" in hospital-local time. */
export function formatWhen(instant: string | Date): string {
  return whenFmt.format(new Date(instant));
}

async function resolvePatientId(tx: Tx, ev: OutboxEventRow): Promise<string | null> {
  if (ev.patientId) return ev.patientId;
  const sql: Record<string, string> = {
    appointment: `SELECT patient_id FROM appointments WHERE id = $1`,
    queue_entry: `SELECT v.patient_id FROM queue_entries qe JOIN visits v ON v.id = qe.visit_id WHERE qe.id = $1`,
    follow_up_task: `SELECT patient_id FROM follow_up_tasks WHERE id = $1`,
  };
  const q = sql[ev.entityType];
  if (!q) return null;
  return (await tx.query<{ patient_id: string }>(q, [ev.entityId])).rows[0]?.patient_id ?? null;
}

async function appointmentFacts(tx: Tx, appointmentId: string): Promise<{ when: string; doctor: string } | null> {
  const r = await tx.query<{ scheduled_at: string; full_name: string }>(
    `SELECT a.scheduled_at, d.full_name FROM appointments a JOIN doctors d ON d.id = a.doctor_id WHERE a.id = $1`,
    [appointmentId],
  );
  const row = r.rows[0];
  return row ? { when: formatWhen(row.scheduled_at), doctor: row.full_name } : null;
}

async function queueFacts(tx: Tx, ev: OutboxEventRow): Promise<{ token: string; room: string } | null> {
  const r = await tx.query<{ token: string; room: string }>(
    `SELECT qe.token, d.room FROM queue_entries qe JOIN doctors d ON d.id = qe.doctor_id WHERE qe.id = $1`,
    [ev.entityId],
  );
  const row = r.rows[0];
  if (!row) return null;
  const payloadToken = typeof ev.payload['token'] === 'string' ? (ev.payload['token'] as string) : null;
  return { token: payloadToken ?? row.token, room: row.room };
}

/** Default renderer: patient-facing events -> one in-app notification for the patient's login, if any. */
export const renderNotification: NotificationRenderer = async (tx, ev) => {
  if (!PATIENT_EVENTS.has(ev.eventType)) return null;
  const patientId = await resolvePatientId(tx, ev);
  if (!patientId) return null;
  const user = await tx.query<{ id: string }>(`SELECT id FROM users WHERE patient_id = $1 AND active`, [patientId]);
  const recipientUserId = user.rows[0]?.id;
  if (!recipientUserId) return null; // patient without a login (assisted registration): nothing to notify

  let body: string;
  switch (ev.eventType) {
    case 'AppointmentBooked': {
      const f = await appointmentFacts(tx, ev.entityId);
      body = f ? `Your appointment with ${f.doctor} on ${f.when} is confirmed.` : 'Your appointment is confirmed.';
      break;
    }
    case 'AppointmentRescheduled': {
      const f = await appointmentFacts(tx, ev.entityId);
      body = f
        ? `Your appointment with ${f.doctor} has been moved to ${f.when}.`
        : 'Your appointment has been rescheduled.';
      break;
    }
    case 'AppointmentCancelled': {
      const f = await appointmentFacts(tx, ev.entityId);
      body = f
        ? `Your appointment with ${f.doctor} on ${f.when} has been cancelled.`
        : 'Your appointment has been cancelled.';
      break;
    }
    case 'ReservationReleased': {
      const f = await appointmentFacts(tx, ev.entityId);
      body = f
        ? `Your reserved place on ${f.when} was released because you had not checked in. Please speak to reception if you are here.`
        : 'Your reserved place was released because you had not checked in. Please speak to reception if you are here.';
      break;
    }
    case 'QueuePatientCalled': {
      const f = await queueFacts(tx, ev);
      body = f
        ? `Your token ${f.token} has been called. Please go to ${f.room}.`
        : 'You have been called. Please go to the consultation room.';
      break;
    }
    case 'QueuePatientSkipped': {
      const f = await queueFacts(tx, ev);
      body = f
        ? `Your token ${f.token} was skipped because there was no answer to the call. Please see reception to rejoin the queue.`
        : 'Your call was skipped because there was no answer. Please see reception to rejoin the queue.';
      break;
    }
    default:
      body = 'A follow-up has been opened for you. Please check your follow-ups.';
  }
  return { recipientUserId, kind: ev.eventType, body };
};

export interface DispatchResult {
  /** Events stamped dispatched in this batch. */
  dispatched: number;
  /** Notifications actually inserted (conflicts excluded). */
  notifications: number;
  /** Event ids that failed to render/insert and were left undispatched for a later retry. */
  failed: string[];
}

export interface DispatchOptions {
  batch?: number;
  render?: NotificationRenderer;
  log?: Logger;
  /** Position values to skip (events in a failure cool-down). */
  excludePositions?: readonly number[];
}

/** Claim and process one batch. Safe to run from several processes at once. */
export async function dispatchOutboxBatch(
  pool: Pool,
  opts: DispatchOptions = {},
): Promise<DispatchResult & { failedPositions: number[] }> {
  const render = opts.render ?? renderNotification;
  const log = opts.log ?? silentLogger;
  return withTransaction(pool, async (tx) => {
    const claimed = await tx.query(
      `SELECT position, id, event_type, entity_type, entity_id, entity_version, session_id, patient_id, payload
         FROM outbox_events
        WHERE dispatched_at IS NULL AND NOT (position = ANY($2::bigint[]))
        ORDER BY position
        LIMIT $1
          FOR UPDATE SKIP LOCKED`,
      [opts.batch ?? 50, opts.excludePositions ? [...opts.excludePositions] : []],
    );
    const result: DispatchResult & { failedPositions: number[] } = {
      dispatched: 0,
      notifications: 0,
      failed: [],
      failedPositions: [],
    };
    const doneIds: string[] = [];
    for (const r of claimed.rows) {
      const ev: OutboxEventRow = {
        position: r.position,
        id: r.id,
        eventType: r.event_type,
        entityType: r.entity_type,
        entityId: r.entity_id,
        entityVersion: r.entity_version,
        sessionId: r.session_id,
        patientId: r.patient_id,
        payload: r.payload ?? {},
      };
      // One poisoned event must not roll back (or block) the rest of the batch.
      await tx.query('SAVEPOINT ev');
      try {
        const n = await render(tx, ev);
        if (n) {
          const ins = await tx.query(
            `INSERT INTO notifications (recipient_user_id, event_id, kind, body)
             VALUES ($1, $2, $3, $4)
             ON CONFLICT (recipient_user_id, event_id) DO NOTHING`,
            [n.recipientUserId, ev.id, n.kind, n.body],
          );
          result.notifications += ins.rowCount ?? 0;
        }
        await tx.query('RELEASE SAVEPOINT ev');
        doneIds.push(ev.id);
      } catch (err) {
        await tx.query('ROLLBACK TO SAVEPOINT ev');
        result.failed.push(ev.id);
        result.failedPositions.push(ev.position);
        log.error('outbox.event_failed', { eventId: ev.id, eventType: ev.eventType, error: errorSummary(err) });
      }
    }
    if (doneIds.length > 0) {
      await tx.query(`UPDATE outbox_events SET dispatched_at = now() WHERE id = ANY($1::uuid[])`, [doneIds]);
    }
    result.dispatched = doneIds.length;
    return result;
  });
}

export interface DispatcherOptions {
  pool: Pool;
  pollMs?: number;
  batch?: number;
  render?: NotificationRenderer;
  log?: Logger;
  clock?: Clock;
}

/** Polling loop around dispatchOutboxBatch with a per-event failure cool-down (never blocks other events). */
export class OutboxDispatcher {
  private readonly pool: Pool;
  private readonly pollMs: number;
  private readonly batch: number;
  private readonly render: NotificationRenderer | undefined;
  private readonly log: Logger;
  private readonly clock: Clock;
  private stopping = false;
  private loopPromise: Promise<void> | null = null;
  private wake: (() => void) | null = null;
  /** position -> { failures, retryAfter } */
  private readonly cooldown = new Map<number, { failures: number; retryAfter: number }>();

  constructor(o: DispatcherOptions) {
    this.pool = o.pool;
    this.pollMs = o.pollMs ?? 500;
    this.batch = o.batch ?? 50;
    this.render = o.render;
    this.log = (o.log ?? silentLogger).child({ component: 'outbox' });
    this.clock = o.clock ?? systemClock;
  }

  /** Dispatch batches until none is pending. Returns totals. */
  async drain(): Promise<{ dispatched: number; notifications: number }> {
    let dispatched = 0;
    let notifications = 0;
    for (;;) {
      const nowMs = this.clock().getTime();
      const exclude = [...this.cooldown.entries()].filter(([, c]) => c.retryAfter > nowMs).map(([p]) => p);
      const r = await dispatchOutboxBatch(this.pool, {
        batch: this.batch,
        log: this.log,
        excludePositions: exclude,
        ...(this.render ? { render: this.render } : {}),
      });
      dispatched += r.dispatched;
      notifications += r.notifications;
      for (const p of r.failedPositions) {
        const failures = (this.cooldown.get(p)?.failures ?? 0) + 1;
        this.cooldown.set(p, { failures, retryAfter: nowMs + Math.min(300, 2 ** failures) * 1000 });
      }
      // Nothing left, or only failing events (now cooling down): stop for this poll.
      if (r.dispatched === 0) return { dispatched, notifications };
    }
  }

  start(): void {
    if (this.loopPromise) return;
    this.stopping = false;
    this.loopPromise = this.loop();
  }

  async stop(): Promise<void> {
    this.stopping = true;
    this.wake?.();
    await this.loopPromise;
    this.loopPromise = null;
  }

  private async loop(): Promise<void> {
    this.log.info('outbox.started');
    while (!this.stopping) {
      try {
        await this.drain();
      } catch (err) {
        // Database trouble must never crash the process or the runner; retry next poll.
        this.log.error('outbox.drain_failed', { error: errorSummary(err) });
      }
      if (this.stopping) break;
      await new Promise<void>((resolve) => {
        const done = () => {
          clearTimeout(timer);
          if (this.wake === done) this.wake = null;
          resolve();
        };
        const timer = setTimeout(done, this.pollMs);
        this.wake = done;
      });
    }
    this.log.info('outbox.stopped');
  }
}
