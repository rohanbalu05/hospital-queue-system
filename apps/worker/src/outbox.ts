import type { Pool } from 'pg';
import { enqueueJob, withTransaction, type Tx } from '@hqms/db';
import { errorSummary, silentLogger, type Logger } from './log.js';
import { renderSessionEvent, renderTransfer, SESSION_FANOUT_EVENTS, type RenderedNotification } from './notifications.js';
import { systemClock, type Clock } from './types.js';

export type { RenderedNotification } from './notifications.js';

/*
 * Outbox dispatcher: turns committed domain events into in-app notifications and, for patients, SMS/email delivery
 * rows (report §6.7, D-034). One event can have many recipients (session availability changes fan out to the
 * session's patients and reception).
 *
 * One short transaction per batch: claim undispatched events FOR UPDATE SKIP LOCKED (two dispatchers get
 * disjoint batches), insert notifications, stamp dispatched_at, commit. The insert is also
 * ON CONFLICT (recipient_user_id, event_id) DO NOTHING, so at-least-once redelivery (crash before
 * commit, manual reset of dispatched_at) can never create a second notification.
 *
 * Every recipient also gets a notification_deliveries row per channel: in_app (written 'sent' with the notification),
 * sms and email ('queued' + a deliver_notification job with a stable dedupe key, in the same transaction). The
 * provider call itself happens later in the worker, outside any transaction. The unique keys on notifications
 * (recipient, event) and deliveries (event, channel, address) make redelivery a no-op.
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

/** A renderer may return nothing, one notification (the original contract) or many (fan-out). */
export type NotificationRenderer = (
  tx: Tx,
  ev: OutboxEventRow,
) => Promise<RenderedNotification | RenderedNotification[] | null>;

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

/**
 * Wording for ReservationReleased by `payload.reason` ('timer' | 'cancelled' | 'rescheduled' | 'late_admission').
 * A missing or unknown reason gets a neutral sentence that never blames the patient.
 */
export function reservationReleasedBody(reason: unknown, when: string | null): string {
  const place = when ? `Your reserved place on ${when}` : 'Your reserved place';
  switch (reason) {
    case 'timer':
      return `${place} was released because you had not checked in. Please speak to reception if you are here.`;
    case 'cancelled':
      return `${place} was released because the appointment was cancelled.`;
    case 'rescheduled':
      return `${place} was released because the appointment was moved to another time.`;
    case 'late_admission':
      return `${place} was released because you were admitted as a late arrival. You are in today's queue.`;
    default:
      return `${place} was released.`;
  }
}

/** Default renderer: availability events and transfers fan out; the other patient-facing events notify one login. */
export const renderNotification = async (tx: Tx, ev: OutboxEventRow): Promise<RenderedNotification[]> => {
  if (SESSION_FANOUT_EVENTS.has(ev.eventType)) return renderSessionEvent(tx, ev);
  if (ev.eventType === 'QueuePatientTransferred') return renderTransfer(tx, ev);
  const single = await renderSingle(tx, ev);
  return single ? [single] : [];
};

/** Patient-facing events with one recipient: the patient's login, if any (wording unchanged since W2). */
const renderSingle = async (tx: Tx, ev: OutboxEventRow): Promise<RenderedNotification | null> => {
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
      body = reservationReleasedBody(ev.payload['reason'], f?.when ?? null);
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
  return { recipientUserId, patientId, kind: ev.eventType, body };
};

/** The "no login" in-app address: one per recipient, so the (event, channel, address) key stays unique per person. */
const inAppAddress = (userId: string): string => `in-app:${userId}`;

/**
 * Write one recipient's notification and delivery rows. Everything is ON CONFLICT DO NOTHING, so replaying an event
 * adds nothing. Returns how many notifications were inserted (0 or 1).
 */
async function writeRecipient(tx: Tx, ev: OutboxEventRow, n: RenderedNotification): Promise<number> {
  let inserted = 0;
  let notificationId: string | null = null;
  if (n.recipientUserId) {
    const ins = await tx.query<{ id: string }>(
      `INSERT INTO notifications (recipient_user_id, event_id, kind, body, link, severity)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (recipient_user_id, event_id) DO NOTHING
       RETURNING id`,
      [n.recipientUserId, ev.id, n.kind, n.body, n.link ?? null, n.severity ?? 'info'],
    );
    inserted = ins.rowCount ?? 0;
    notificationId =
      ins.rows[0]?.id ??
      (
        await tx.query<{ id: string }>(`SELECT id FROM notifications WHERE recipient_user_id = $1 AND event_id = $2`, [
          n.recipientUserId,
          ev.id,
        ])
      ).rows[0]?.id ??
      null;
    if (notificationId) {
      await tx.query(
        `INSERT INTO notification_deliveries
           (event_id, notification_id, recipient_user_id, patient_id, channel, address, body, status, session_id, sent_at)
         VALUES ($1, $2, $3, $4, 'in_app', $5, $6, 'sent', $7, now())
         ON CONFLICT (event_id, channel, address) DO NOTHING`,
        [ev.id, notificationId, n.recipientUserId, n.patientId ?? null, inAppAddress(n.recipientUserId), n.body, ev.sessionId],
      );
    }
  }
  for (const [channel, address] of [
    ['sms', n.sms],
    ['email', n.email],
  ] as const) {
    if (!address || !n.patientId) continue;
    const row = await tx.query<{ id: string }>(
      `INSERT INTO notification_deliveries
         (event_id, recipient_user_id, patient_id, channel, address, body, status, session_id)
       VALUES ($1, $2, $3, $4, $5, $6, 'queued', $7)
       ON CONFLICT (event_id, channel, address) DO NOTHING
       RETURNING id`,
      [ev.id, n.recipientUserId, n.patientId, channel, address, n.body, ev.sessionId],
    );
    const id = row.rows[0]?.id;
    // The job is created in the same transaction as the row; the dedupe key makes a replay harmless.
    if (id) await enqueueJob(tx, { jobType: 'deliver_notification', payload: { deliveryId: id }, dedupeKey: `deliver_notification:${id}` });
  }
  return inserted;
}

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
        const rendered = await render(tx, ev);
        const list = rendered === null ? [] : Array.isArray(rendered) ? rendered : [rendered];
        for (const n of list) result.notifications += await writeRecipient(tx, ev, n);
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
