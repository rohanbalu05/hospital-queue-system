import { NOTIFICATION_LINKS, type NotificationSeverity } from '@hqms/contracts';
import type { Tx } from '@hqms/db';
import type { OutboxEventRow, RenderedNotification } from './types.js';

export type { RenderedNotification } from './types.js';

/*
 * Fan-out renderers (B2, D-034): one committed domain event -> many recipients.
 *
 * Text is built from routing data only: doctor name, IST times, token, room, counts. Never the free-text pause
 * reason (it is not in the event) and never anything clinical. The words are fixed here so the same event always
 * reads the same; redelivery is made harmless by the unique keys on notifications and notification_deliveries.
 */

const clockFmt = new Intl.DateTimeFormat('en-IN', {
  timeZone: 'Asia/Kolkata',
  hour: 'numeric',
  minute: '2-digit',
  hour12: true,
});

/** "10:45 am" in hospital-local time. */
export function formatClock(instant: string | Date): string {
  return clockFmt.format(new Date(instant)).replace(/\s?([AP]M)$/i, (_m, ap: string) => ` ${ap.toLowerCase()}`);
}

/** The doctor as patients say it: "Dr. Suresh Hegde" stays, "Rao" becomes "Dr Rao" (never "Dr Dr"). */
export function doctorTitle(fullName: string): string {
  return /^dr\.?\s/i.test(fullName.trim()) ? fullName.trim() : `Dr ${fullName.trim()}`;
}

export const SESSION_FANOUT_EVENTS = new Set(['SessionPaused', 'SessionResumed', 'SessionUnavailable']);

type Phase = 'away' | 'back' | 'unavailable';
const PHASE: Record<string, Phase> = { SessionPaused: 'away', SessionResumed: 'back', SessionUnavailable: 'unavailable' };
const SEVERITY: Record<Phase, NotificationSeverity> = { away: 'warning', back: 'info', unavailable: 'urgent' };

interface PatientContact {
  patientId: string;
  phone: string | null;
  userId: string | null;
  email: string | null;
}

/** Login and phone of each patient (an inactive login gets neither the in-app notice nor email). */
async function contacts(tx: Tx, patientIds: string[]): Promise<Map<string, PatientContact>> {
  const out = new Map<string, PatientContact>();
  if (patientIds.length === 0) return out;
  const r = await tx.query<{ id: string; phone: string | null; user_id: string | null; email: string | null }>(
    `SELECT p.id, NULLIF(btrim(p.phone), '') AS phone, u.id AS user_id, u.email
       FROM patients p LEFT JOIN users u ON u.patient_id = p.id AND u.active
      WHERE p.id = ANY($1::uuid[])`,
    [patientIds],
  );
  for (const row of r.rows) out.set(row.id, { patientId: row.id, phone: row.phone, userId: row.user_id, email: row.email });
  return out;
}

interface Wording {
  checkedIn: string;
  booked: (appointmentTime: string) => string;
  staff: (counts: { waiting: number; bookedNotArrived: number; affected: number }) => string;
}

function wording(
  phase: Phase,
  dr: string,
  label: string,
  department: string,
  until: string | null,
  update: boolean,
  reopened = false,
): Wording {
  const t = until === null ? null : formatClock(until);
  switch (phase) {
    case 'away': {
      const keep = 'Your place in the queue is kept';
      return {
        checkedIn:
          t !== null
            ? update
              ? `Update: ${dr} is now expected back about ${t}. ${keep}; your estimated wait now includes this break.`
              : `${dr} has stepped away and is expected back about ${t}. ${keep}; your estimated wait now includes this break.`
            : update
              ? `Update: ${dr} is still away and no return time has been given. ${keep}. We will tell you when the doctor is back.`
              : `${dr} has stepped away. ${keep}. We will tell you when the doctor is back.`,
        booked: (appt) =>
          t !== null
            ? update
              ? `Update: ${dr} is now expected back about ${t}. Your ${appt} appointment stands; you may be seen a little later.`
              : `${dr} is running behind: stepped away, expected back about ${t}. Your ${appt} appointment stands; you may be seen a little later.`
            : update
              ? `Update: ${dr} is still away and no return time has been given. Your ${appt} appointment stands; you may be seen a little later.`
              : `${dr} is running behind: stepped away, no return time given. Your ${appt} appointment stands; you may be seen a little later.`,
        staff: (c) => {
          const tail = `${c.waiting} waiting, ${c.bookedNotArrived} booked not arrived.`;
          return t !== null
            ? update
              ? `Update: ${dr} is now expected back about ${t}. ${tail}`
              : `${dr} stepped away (back about ${t}). ${tail}`
            : update
              ? `Update: ${dr} is still away and no return time has been given. ${tail}`
              : `${dr} stepped away (no return time given). ${tail}`;
        },
      };
    }
    case 'back':
      // PR-30: an admin reopened a session that had been marked unavailable. Patients already moved stay moved.
      if (reopened) {
        return {
          checkedIn: `${dr} is available again for this session. Your place in the queue is kept.`,
          booked: (appt) => `${dr} is available again for this session. Your ${appt} appointment stands.`,
          staff: () => `${dr} is available again (session reopened by admin).`,
        };
      }
      return {
        checkedIn: `${dr} is back and seeing patients again. Your place in the queue is unchanged.`,
        booked: (appt) => `${dr} is back and seeing patients. Your ${appt} appointment stands.`,
        staff: () => `${dr} is back.`,
      };
    case 'unavailable':
      return {
        checkedIn: `${dr} is not available for the rest of this session. Please see reception: they will move you to another doctor.`,
        booked: (appt) =>
          `${dr} is not available for the rest of today's ${label} session. Please rebook with another ${department} doctor or cancel your ${appt} appointment.`,
        staff: (c) =>
          `${dr} is unavailable for the rest of the session. ${c.affected} ${c.affected === 1 ? 'patient is' : 'patients are'} affected: open the session board to move them.`,
      };
  }
}

/**
 * The event is dispatched asynchronously, so by the time it is rendered the doctor may already be back (or away again).
 * A late "stepped away" after "I'm back", or an old return time after a newer one, would only mislead patients, so it is
 * skipped; the newer event carries the current truth. SessionUnavailable is never skipped: it is terminal for the
 * session and the affected patients must always be told.
 */
function isStaleSessionNotice(ev: OutboxEventRow, s: { status: string; pause_until: Date | string | null }): boolean {
  if (ev.eventType === 'SessionPaused') {
    if (s.status !== 'paused') return true;
    if ('pauseUntil' in ev.payload) {
      const sent = typeof ev.payload['pauseUntil'] === 'string' ? new Date(ev.payload['pauseUntil'] as string).getTime() : null;
      const now = s.pause_until === null ? null : new Date(s.pause_until).getTime();
      if (sent !== now) return true;
    }
    return false;
  }
  if (ev.eventType === 'SessionResumed') return s.status === 'paused' || s.status === 'unavailable';
  return false;
}

/**
 * SessionPaused (incl. updates), SessionResumed, SessionUnavailable. Recipients:
 *  (a) checked-in patients of the session whose entry is waiting, called, skipped or absent and whose visit is still open,
 *  (b) patients with a booked appointment in the session who have not arrived,
 *  (c) active reception users assigned to the session's doctor.
 * Patients also get SMS (phone on file) and email (login email); staff get in-app only.
 */
export async function renderSessionEvent(tx: Tx, ev: OutboxEventRow): Promise<RenderedNotification[]> {
  const phase = PHASE[ev.eventType];
  const sessionId = ev.sessionId ?? (ev.entityType === 'session' ? ev.entityId : null);
  if (!phase || !sessionId) return [];
  const s = (
    await tx.query<{
      doctor_id: string;
      label: string;
      full_name: string;
      department: string;
      status: string;
      pause_until: Date | string | null;
    }>(
      `SELECT s.doctor_id, s.label, d.full_name, d.department, s.status, s.pause_until
         FROM sessions s JOIN doctors d ON d.id = s.doctor_id WHERE s.id = $1`,
      [sessionId],
    )
  ).rows[0];
  if (!s) return [];
  if (isStaleSessionNotice(ev, s)) return [];

  const until = typeof ev.payload['pauseUntil'] === 'string' ? (ev.payload['pauseUntil'] as string) : null;
  const w = wording(phase, doctorTitle(s.full_name), s.label, s.department, until, ev.payload['update'] === true, ev.payload['reopened'] === true);
  const severity = SEVERITY[phase];

  const checkedIn = (
    await tx.query<{ patient_id: string; state: string }>(
      `SELECT v.patient_id, qe.state
         FROM queue_entries qe JOIN visits v ON v.id = qe.visit_id
        WHERE qe.session_id = $1 AND qe.state IN ('waiting', 'called', 'skipped', 'absent')
          AND v.status IN ('open', 'in_service')
        ORDER BY qe.seq`,
      [sessionId],
    )
  ).rows;
  const booked = (
    await tx.query<{ id: string; patient_id: string; scheduled_at: string }>(
      `SELECT id, patient_id, scheduled_at FROM appointments
        WHERE session_id = $1 AND status = 'booked' ORDER BY scheduled_at, id`,
      [sessionId],
    )
  ).rows;
  const staff = (
    await tx.query<{ id: string }>(
      `SELECT u.id FROM staff_assignments sa JOIN users u ON u.id = sa.user_id
        WHERE sa.doctor_id = $1 AND u.role = 'reception' AND u.active ORDER BY u.id`,
      [s.doctor_id],
    )
  ).rows;

  const checkedInIds = [...new Set(checkedIn.map((r) => r.patient_id))];
  const bookedRows = booked.filter((b) => !checkedInIds.includes(b.patient_id));
  const info = await contacts(tx, [...checkedInIds, ...new Set(bookedRows.map((b) => b.patient_id))]);
  const out: RenderedNotification[] = [];
  const patient = (patientId: string, body: string, link: string): void => {
    const c = info.get(patientId);
    if (!c) return;
    out.push({
      recipientUserId: c.userId,
      patientId,
      kind: ev.eventType,
      body,
      link,
      severity,
      sms: c.phone,
      email: c.userId ? c.email : null,
    });
  };

  for (const id of checkedInIds) patient(id, w.checkedIn, NOTIFICATION_LINKS.patientVisit(sessionId));
  for (const b of bookedRows) {
    patient(
      b.patient_id,
      w.booked(formatClock(b.scheduled_at)),
      phase === 'unavailable' ? NOTIFICATION_LINKS.patientRebook(b.id) : NOTIFICATION_LINKS.patientToday(),
    );
  }

  const waiting = checkedIn.filter((r) => r.state === 'waiting').length;
  const counts = { waiting, bookedNotArrived: booked.length, affected: checkedInIds.length + bookedRows.length };
  for (const u of staff) {
    out.push({
      recipientUserId: u.id,
      kind: ev.eventType,
      body: w.staff(counts),
      link: NOTIFICATION_LINKS.receptionSession(sessionId),
      severity,
    });
  }
  return out;
}

/** QueuePatientTransferred (entity = the NEW queue entry): the moved patient learns doctor, room and token. */
export async function renderTransfer(tx: Tx, ev: OutboxEventRow): Promise<RenderedNotification[]> {
  const r = (
    await tx.query<{ patient_id: string; token: string; session_id: string; full_name: string; room: string }>(
      `SELECT v.patient_id, qe.token, qe.session_id, d.full_name, d.room
         FROM queue_entries qe
         JOIN visits v ON v.id = qe.visit_id
         JOIN doctors d ON d.id = qe.doctor_id
        WHERE qe.id = $1`,
      [ev.entityId],
    )
  ).rows[0];
  if (!r) return [];
  const c = (await contacts(tx, [r.patient_id])).get(r.patient_id);
  if (!c) return [];
  return [
    {
      recipientUserId: c.userId,
      patientId: r.patient_id,
      kind: ev.eventType,
      body: `You have been moved to ${doctorTitle(r.full_name)} in ${r.room}. Your new token is ${r.token}.`,
      link: NOTIFICATION_LINKS.patientVisit(r.session_id),
      severity: 'warning',
      sms: c.phone,
      email: null, // in-app + sms only
    },
  ];
}

const replyDateFmt = new Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short' });

/**
 * FollowUpResolved (PR-14): when staff resolved the task WITH a reply for the patient, the patient's login gets one
 * in-app notice that a reply is waiting. In-app only, and never the reply text (it is read on the Follow-ups page,
 * behind the patient's own login). A cancelled task, a task without a reply and a patient without a login get nothing.
 */
export async function renderFollowUpReply(tx: Tx, ev: OutboxEventRow): Promise<RenderedNotification[]> {
  if (ev.payload['cancelled'] === true) return [];
  const t = (
    await tx.query<{ patient_id: string; kind: string; created_at: string; status: string; has_reply: boolean; user_id: string | null }>(
      `SELECT t.patient_id, t.kind, t.created_at, t.status, t.patient_reply IS NOT NULL AS has_reply,
              (SELECT u.id FROM users u WHERE u.patient_id = t.patient_id AND u.active) AS user_id
         FROM follow_up_tasks t WHERE t.id = $1`,
      [ev.entityId],
    )
  ).rows[0];
  if (!t || t.status !== 'resolved' || !t.has_reply || !t.user_id) return [];
  const about = t.kind === 'assistant_escalation' ? 'your question' : 'your follow-up';
  return [
    {
      recipientUserId: t.user_id,
      patientId: t.patient_id,
      kind: ev.eventType,
      body: `The care team has replied about ${about} from ${replyDateFmt.format(new Date(t.created_at))}. Open Follow-ups to read it.`,
      link: NOTIFICATION_LINKS.patientFollowUps(),
      severity: 'info',
    },
  ];
}
