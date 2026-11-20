/* eslint-disable @typescript-eslint/no-non-null-assertion -- tests index rows they have just created */
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ApiError, Notification, NotificationDelivery, ReadAllResult, UnreadCount } from '@hqms/contracts';
import { type Client, type TestApp, createTestApp, loginAs, makeSession, patientId } from './helpers.js';

/** B2 (D-034), API read side: in-app notices with link and severity, unread count, read-all, and the admin delivery log. */

let t: TestApp;
let admin: Client;
let reception: Client;
let doctor: Client;
let followup: Client;
let patient1: Client;
let patient2: Client;
let userId: (email: string) => Promise<string>;

beforeAll(async () => {
  t = await createTestApp();
  admin = await loginAs(t.server, 'admin@hqms.test');
  reception = await loginAs(t.server, 'reception@hqms.test');
  doctor = await loginAs(t.server, 'doctor@hqms.test');
  followup = await loginAs(t.server, 'followup@hqms.test');
  patient1 = await loginAs(t.server, 'patient@hqms.test');
  patient2 = await loginAs(t.server, 'patient2@hqms.test');
  userId = async (email) => (await t.pool.query(`SELECT id FROM users WHERE email = $1`, [email])).rows[0]!.id as string;
});
afterAll(async () => {
  await t.close();
});

const errorCode = (body: unknown): string => ApiError.parse(body).error.code;

async function note(
  recipient: string,
  body: string,
  extra: { link?: string | null; severity?: 'info' | 'warning' | 'urgent'; readAt?: boolean; createdAt?: string } = {},
): Promise<string> {
  const r = await t.pool.query(
    `INSERT INTO notifications (recipient_user_id, kind, body, link, severity, read_at, created_at)
     VALUES ($1, 'SessionPaused', $2, $3, $4, CASE WHEN $5::boolean THEN now() END, COALESCE($6::timestamptz, now())) RETURNING id`,
    [recipient, body, extra.link ?? null, extra.severity ?? 'info', extra.readAt ?? false, extra.createdAt ?? null],
  );
  return r.rows[0]!.id as string;
}

describe('own notifications: list, unread count, read-all', () => {
  it('list carries link and severity; unread-count and read-all touch own rows only, for every role', async () => {
    for (const [client, email] of [
      [patient1, 'patient@hqms.test'],
      [reception, 'reception@hqms.test'],
      [doctor, 'doctor@hqms.test'],
      [followup, 'followup@hqms.test'],
      [admin, 'admin@hqms.test'],
    ] as const) {
      const me = await userId(email);
      await t.pool.query(`UPDATE notifications SET read_at = now() WHERE recipient_user_id = $1 AND read_at IS NULL`, [me]);
      await note(me, `warn for ${email}`, { link: '/patient', severity: 'warning', createdAt: '2041-01-01T10:00:00Z' });
      await note(me, `urgent for ${email}`, { link: '/reception?session=x', severity: 'urgent', createdAt: '2041-01-01T10:05:00Z' });
      await note(me, `old for ${email}`, { readAt: true, createdAt: '2041-01-01T09:00:00Z' });
      const list = await client.get('/notifications');
      expect(list.status).toBe(200);
      const parsed = (list.body as unknown[]).map((n) => Notification.parse(n));
      expect(parsed[0]).toMatchObject({ body: `urgent for ${email}`, severity: 'urgent', link: '/reception?session=x' });
      expect(parsed[1]).toMatchObject({ body: `warn for ${email}`, severity: 'warning', link: '/patient' });
      expect(parsed.find((n) => n.body.startsWith('old'))).toMatchObject({ severity: 'info', link: null });
      expect(parsed.find((n) => n.body.startsWith('old'))!.readAt).not.toBeNull();

      const count = UnreadCount.parse((await client.get('/notifications/unread-count')).body);
      expect(count.unreadCount).toBe(2);
    }
  });

  it('read-all marks only the caller own unread rows and answers how many; a second call updates none', async () => {
    const mine = await userId('patient@hqms.test');
    const other = await userId('patient2@hqms.test');
    await t.pool.query(`UPDATE notifications SET read_at = now() WHERE recipient_user_id = ANY($1::uuid[]) AND read_at IS NULL`, [[mine, other]]);
    await note(mine, 'a');
    await note(mine, 'b');
    const theirs = await note(other, 'not yours');
    expect(UnreadCount.parse((await patient1.get('/notifications/unread-count')).body).unreadCount).toBe(2);
    const first = ReadAllResult.parse((await patient1.post('/notifications/read-all', {}, null)).body);
    expect(first.updated).toBe(2);
    expect(UnreadCount.parse((await patient1.get('/notifications/unread-count')).body).unreadCount).toBe(0);
    expect(ReadAllResult.parse((await patient1.post('/notifications/read-all', {}, null)).body).updated).toBe(0);
    // the other patient's row is untouched and still unread for them
    expect((await t.pool.query(`SELECT read_at FROM notifications WHERE id = $1`, [theirs])).rows[0]!.read_at).toBeNull();
    expect(UnreadCount.parse((await patient2.get('/notifications/unread-count')).body).unreadCount).toBe(1);
    // mark-read stays own-only: someone else's id answers 404
    expect((await patient1.post(`/notifications/${theirs}/read`, {}, null)).status).toBe(404);
    expect((await patient2.post(`/notifications/${theirs}/read`, {}, null)).status).toBe(200);
  });

  it('needs a login', async () => {
    expect((await request(t.server).get('/notifications/unread-count')).status).toBe(401);
    expect((await request(t.server).post('/notifications/read-all').send({})).status).toBe(401);
  });
});

describe('GET /admin/notifications: the "Notifications sent" log', () => {
  const tag = randomUUID().slice(0, 8);
  let sessionId: string;
  const ids: Record<string, string> = {};

  async function delivery(d: {
    key: string;
    channel: 'in_app' | 'sms' | 'email';
    address: string;
    status: 'queued' | 'sent' | 'failed';
    patient?: number;
    user?: string;
    createdAt: string;
    lastError?: string;
    attempts?: number;
  }): Promise<void> {
    const r = await t.pool.query(
      `INSERT INTO notification_deliveries (recipient_user_id, patient_id, channel, address, body, status, provider, provider_message_id,
              attempts, last_error, session_id, created_at, sent_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::timestamptz, CASE WHEN $6 = 'sent' THEN $12::timestamptz END) RETURNING id`,
      [
        d.user ?? null,
        d.patient ? patientId(d.patient) : null,
        d.channel,
        d.address,
        `body ${d.key}`,
        d.status,
        d.status === 'sent' && d.channel !== 'in_app' ? 'fake' : null,
        d.status === 'sent' && d.channel !== 'in_app' ? `fake-${d.key}` : null,
        d.attempts ?? 0,
        d.lastError ?? null,
        sessionId,
        d.createdAt,
      ],
    );
    ids[d.key] = r.rows[0]!.id as string;
  }

  beforeAll(async () => {
    sessionId = (await makeSession(admin, { doctor: 3 })).id;
    await delivery({ key: 'sms-sent', channel: 'sms', address: '+91 98765 43210', status: 'sent', patient: 4, createdAt: '2041-02-01T10:00:00Z', attempts: 1 });
    await delivery({ key: 'email-queued', channel: 'email', address: 'anita.rao@example.org', status: 'queued', patient: 5, createdAt: '2041-02-01T10:01:00Z' });
    await delivery({
      key: 'sms-failed',
      channel: 'sms',
      address: '9812345678',
      status: 'failed',
      patient: 6,
      createdAt: '2041-02-01T10:02:00Z',
      attempts: 5,
      lastError: 'provider unavailable',
    });
    await delivery({ key: 'inapp-staff', channel: 'in_app', address: `in-app:${tag}`, status: 'sent', user: await userId('reception@hqms.test'), createdAt: '2041-02-01T10:03:00Z' });
  });

  it('is admin only: everyone else is 403, anonymous 401', async () => {
    expect((await request(t.server).get('/admin/notifications')).status).toBe(401);
    for (const who of [reception, doctor, followup, patient1]) {
      const res = await who.get('/admin/notifications');
      expect(res.status).toBe(403);
      expect(errorCode(res.body)).toBe('FORBIDDEN');
    }
    expect((await admin.get('/admin/notifications')).status).toBe(200);
  });

  it('lists newest first with recipient name and role, and masks every address', async () => {
    const res = await admin.get(`/admin/notifications?sessionId=${sessionId}`);
    expect(res.status).toBe(200);
    const rows = (res.body as unknown[]).map((r) => NotificationDelivery.parse(r));
    expect(rows.map((r) => r.id)).toEqual([ids['inapp-staff'], ids['sms-failed'], ids['email-queued'], ids['sms-sent']]);
    const by = (k: string) => rows.find((r) => r.id === ids[k])!;
    expect(by('sms-sent')).toMatchObject({ address: '******3210', channel: 'sms', status: 'sent', recipientRole: 'patient', provider: 'fake', providerMessageId: 'fake-sms-sent', attempts: 1 });
    expect(by('sms-sent').recipientName).toMatch(/\S/);
    expect(by('sms-sent').sentAt).not.toBeNull();
    expect(by('email-queued')).toMatchObject({ address: 'a***@example.org', status: 'queued', sentAt: null });
    expect(by('sms-failed')).toMatchObject({ address: '******5678', status: 'failed', lastError: 'provider unavailable', attempts: 5 });
    expect(by('inapp-staff')).toMatchObject({ address: 'in-app', channel: 'in_app', recipientRole: 'reception', sessionId });
    const receptionName = (await t.pool.query(`SELECT display_name FROM users WHERE email = 'reception@hqms.test'`)).rows[0]!.display_name;
    expect(by('inapp-staff').recipientName).toBe(receptionName);
    // the raw phone number and email address never leave the server
    const text = JSON.stringify(res.body);
    expect(text).not.toContain('98765 43210');
    expect(text).not.toContain('9812345678');
    expect(text).not.toContain('anita.rao');
  });

  it('filters by channel, status and session; limit bounds the page', async () => {
    const q = (qs: string) => admin.get(`/admin/notifications?sessionId=${sessionId}&${qs}`);
    expect(((await q('channel=sms')).body as unknown[]).length).toBe(2);
    expect(((await q('channel=email')).body as Array<{ id: string }>).map((r) => r.id)).toEqual([ids['email-queued']]);
    expect(((await q('status=failed')).body as Array<{ id: string }>).map((r) => r.id)).toEqual([ids['sms-failed']]);
    expect(((await q('channel=sms&status=sent')).body as Array<{ id: string }>).map((r) => r.id)).toEqual([ids['sms-sent']]);
    expect(((await q('limit=2')).body as unknown[]).length).toBe(2);
    expect((await q('limit=0')).status).toBe(400);
    expect((await q('channel=pigeon')).status).toBe(400);
    expect((await admin.get(`/admin/notifications?sessionId=${randomUUID()}`)).body).toEqual([]);
  });
});
