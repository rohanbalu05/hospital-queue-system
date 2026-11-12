/* eslint-disable @typescript-eslint/no-non-null-assertion -- tests index rows they have just created */
import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import { Test } from '@nestjs/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import type { Pool } from '@hqms/db';
import { AppModule } from '../src/app.module.js';
import { FakeClock } from '../src/common/clock.js';
import { loadConfig } from '../src/common/config.js';
import { CLOCK, DB_POOL, LLM_PROVIDER, OBJECT_STORAGE } from '../src/common/tokens.js';
import type { LlmProvider, ObjectStorage } from '../src/providers/ports.js';
import { configureApp } from '../src/setup.js';
import { stableId } from '../../../db/seed/seed.js';

export const PASSWORD = 'demo1234';

export interface TestApp {
  app: NestExpressApplication;
  server: Server;
  pool: Pool;
  clock: FakeClock;
  close(): Promise<void>;
}

/** The real application against the real scratch database; only the clock is replaced. */
export async function createTestApp(opts: { storage?: ObjectStorage; llm?: LlmProvider } = {}): Promise<TestApp> {
  const clock = new FakeClock();
  let builder = Test.createTestingModule({ imports: [AppModule] }).overrideProvider(CLOCK).useValue(clock);
  if (opts.storage) builder = builder.overrideProvider(OBJECT_STORAGE).useValue(opts.storage);
  if (opts.llm) builder = builder.overrideProvider(LLM_PROVIDER).useValue(opts.llm);
  const moduleRef = await builder.compile();
  const app = moduleRef.createNestApplication<NestExpressApplication>();
  configureApp(app, loadConfig());
  await app.init();
  return {
    app,
    server: app.getHttpServer() as Server,
    pool: app.get<Pool>(DB_POOL),
    clock,
    close: () => app.close(),
  };
}

/** A logged-in caller. */
export class Client {
  constructor(
    private readonly server: Server,
    readonly cookie: string,
  ) {}

  get(path: string) {
    return request(this.server).get(path).set('Cookie', this.cookie);
  }

  post(path: string, body: object = {}, key: string | null = randomUUID()) {
    const r = request(this.server).post(path).set('Cookie', this.cookie);
    if (key !== null) r.set('Idempotency-Key', key);
    return r.send(body);
  }

  /** multipart upload (field "file" + text fields). */
  upload(path: string, file: Buffer, fields: Record<string, string>, filename = 'scan.png', contentType = 'image/png') {
    const r = request(this.server).post(path).set('Cookie', this.cookie);
    for (const [k, v] of Object.entries(fields)) r.field(k, v);
    return r.attach('file', file, { filename, contentType });
  }

  patch(path: string, body: object = {}) {
    return request(this.server).patch(path).set('Cookie', this.cookie).send(body);
  }
}

export async function loginAs(server: Server, email: string, password = PASSWORD): Promise<Client> {
  const res = await request(server).post('/auth/login').send({ email, password });
  if (res.status !== 200) throw new Error(`login as ${email} failed: ${res.status}`);
  const cookies = res.headers['set-cookie'] as unknown as string[] | undefined;
  const cookie = cookies?.find((c) => c.startsWith('hqms_session='));
  if (!cookie) throw new Error('no session cookie');
  return new Client(server, cookie.split(';')[0]!);
}

/** Seeded ids (db/seed/seed.ts is deterministic). */
export const doctorId = (n: number): string => stableId(`doctor:${n}`);
export const patientId = (n: number): string => stableId(`patient:${n}`);

/** One far-future date per call so sessions never collide on (doctor, starts_at). Hospital-local YYYY-MM-DD. */
let dayCursor = Math.floor(Math.random() * 20_000);
export function nextFutureDate(): string {
  dayCursor += 1;
  return new Date(Date.UTC(2040, 0, 1 + dayCursor)).toISOString().slice(0, 10);
}

export interface MadeSession {
  id: string;
  date: string;
  /** 09:00 IST, the first slot. */
  startsAt: string;
}

/** Create a morning session (09:00-13:00 IST, 20-minute slots) through the admin API. */
export async function makeSession(
  admin: Client,
  opts: { doctor?: number; booked?: number; walkin?: number } = {},
): Promise<MadeSession> {
  const date = nextFutureDate();
  const startsAt = `${date}T09:00:00+05:30`;
  const res = await admin.post(
    '/sessions',
    {
      doctorId: doctorId(opts.doctor ?? 1),
      sessionDate: date,
      label: 'morning',
      startsAt,
      endsAt: `${date}T13:00:00+05:30`,
      bookedCapacity: opts.booked ?? 10,
      walkinCapacity: opts.walkin ?? 5,
    },
    null,
  );
  if (res.status !== 201) throw new Error(`could not create session: ${res.status} ${JSON.stringify(res.body)}`);
  return { id: res.body.id as string, date, startsAt: new Date(startsAt).toISOString() };
}

/** Minutes after a session's 09:00 IST start. */
export const at = (s: MadeSession, minutes: number): Date =>
  new Date(new Date(s.startsAt).getTime() + minutes * 60_000);

export interface CapacityRow {
  booked_capacity: number;
  walkin_capacity: number;
  booked_reserved: number;
  walkin_used: number;
}

export async function capacityOf(pool: Pool, sessionId: string): Promise<CapacityRow> {
  const r = await pool.query<CapacityRow>(
    `SELECT booked_capacity, walkin_capacity, booked_reserved, walkin_used FROM session_capacity WHERE session_id = $1`,
    [sessionId],
  );
  return r.rows[0]!;
}

export async function count(pool: Pool, sql: string, params: unknown[] = []): Promise<number> {
  const r = await pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM (${sql}) t`, params);
  return r.rows[0]!.n;
}

/** Register a fresh patient (reception, assisted registration). */
export async function newPatient(reception: Client, name = 'Test Patient'): Promise<string> {
  const res = await reception.post('/patients', { fullName: name }, null);
  if (res.status !== 201) throw new Error(`could not register patient: ${res.status}`);
  return res.body.id as string;
}

/** Link a patient to a doctor the way the product does: an appointment in a fresh session (reception books). */
export async function linkPatient(
  admin: Client,
  reception: Client,
  patient: string,
  doctor = 1,
  opts: { booked?: number; walkin?: number } = {},
): Promise<{ session: MadeSession; appointmentId: string }> {
  const session = await makeSession(admin, { doctor, ...opts });
  const res = await reception.post('/appointments', { sessionId: session.id, patientId: patient });
  if (res.status !== 201) throw new Error(`could not link patient: ${res.status} ${JSON.stringify(res.body)}`);
  return { session, appointmentId: res.body.id as string };
}

/**
 * A brand-new patient WITH a login, linked to nothing. Test files share one database, so the seeded logins
 * (patient@ ... patient10@) may already be linked to other doctors by earlier files; isolation tests need a
 * patient whose links are exactly what the test creates.
 */
export async function newLoginPatient(
  t: TestApp,
  reception: Client,
  name = 'Isolated Patient',
): Promise<{ id: string; client: Client }> {
  const id = await newPatient(reception, name);
  const tag = randomUUID().slice(0, 8);
  await t.pool.query(
    `INSERT INTO users (hospital_id, email, display_name, role, password_hash, patient_id)
     SELECT hospital_id, $1, $2, 'patient', password_hash, $3 FROM users WHERE email = 'patient@hqms.test'`,
    [`w3-${tag}@hqms.test`, name, id],
  );
  return { id, client: await loginAs(t.server, `w3-${tag}@hqms.test`) };
}
