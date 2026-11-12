/**
 * Idempotent demo seed (report Table 3 staff, Table 7 capacity). Safe to re-run: every row has a stable
 * id derived from a natural key and is inserted with ON CONFLICT DO NOTHING, and sessions for new dates are
 * added when it runs on a later day. Appointments go through the real capacity primitives, so counters
 * always match allocation rows. Demo password for every account: demo1234.
 */
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import {
  createPool,
  createSession,
  DEFAULT_DATABASE_URL,
  getPolicyByVersion,
  hashPassword,
  insertAppointment,
  lockCapacity,
  lockDoctor,
  lockSession,
  reserveBooked,
  type Pool,
  withTransaction,
  writeAudit,
} from '../../packages/db/src/index.js';

export const DEMO_PASSWORD = 'demo1234';
export const SEED_DAYS = 7;

/** Element at `i`, or a RangeError (no non-null assertions in the seed). */
function at<T>(items: readonly T[], i: number): T {
  const v = items[i];
  if (v === undefined) throw new RangeError(`seed: index ${i} out of range (${items.length})`);
  return v;
}

/** Deterministic UUID (v5-shaped) from a natural key. */
export function stableId(name: string): string {
  const b = createHash('sha1').update(`hqms-seed:${name}`).digest().subarray(0, 16);
  b.writeUInt8((b.readUInt8(6) & 0x0f) | 0x50, 6);
  b.writeUInt8((b.readUInt8(8) & 0x3f) | 0x80, 8);
  const h = b.toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

const DOCTORS: Array<{ name: string; department: string; room: string }> = [
  { name: 'Dr. Suresh Hegde', department: 'General Medicine', room: 'OPD 1' },
  { name: 'Dr. Lakshmi Narayan', department: 'General Medicine', room: 'OPD 2' },
  { name: 'Dr. Meera Krishnamurthy', department: 'Paediatrics', room: 'OPD 5' },
  { name: 'Dr. Arjun Shetty', department: 'Paediatrics', room: 'OPD 6' },
  { name: 'Dr. Kavitha Reddy', department: 'ENT', room: 'OPD 9' },
  { name: 'Dr. Mohammed Irfan', department: 'ENT', room: 'OPD 10' },
  { name: 'Dr. Prakash Naik', department: 'Orthopaedics', room: 'OPD 12' },
  { name: 'Dr. Deepa Venkatesh', department: 'Orthopaedics', room: 'OPD 13' },
  { name: 'Dr. Shweta Kulkarni', department: 'Dermatology', room: 'OPD 15' },
  { name: 'Dr. Vikram Bhat', department: 'Dermatology', room: 'OPD 16' },
];

const RECEPTION = ['Asha Menon', 'Rohit Jain', 'Sneha Patil', 'Imran Pasha', 'Divya Nair', 'Gopal Rao'];
const FOLLOWUP = ['Priya Iyer', 'Nandini Gowda', 'Harish Babu', 'Fatima Sheikh'];
const ADMINS = ['Dr. Anand Murthy', 'Rekha Subramanian'];

const PATIENT_NAMES = [
  'Ramesh Kumar', 'Sunita Devi', 'Manjunath Gowda', 'Anitha Shankar', 'Rahul Verma',
  'Pooja Hegde', 'Mohan Das', 'Lakshmi Bai', 'Santosh Patil', 'Farida Begum',
  'Karthik Raman', 'Divya Prakash', 'Naveen Reddy', 'Shobha Rani', 'Imran Khan',
  'Geetha Nayak', 'Vinay Joshi', 'Rukmini Amma', 'Sandeep Shetty', 'Asha Kumari',
  'Basavaraj Patil', 'Meenakshi Iyer', 'Faisal Ahmed', 'Roopa Murthy', 'Girish Kamath',
  'Nirmala Devi', 'Tejas Rao', 'Savitha Bhat', 'Yusuf Pasha', 'Jyothi Lakshmi',
  'Harsha Vardhan', 'Padma Priya', 'Anil Kumar', 'Kusuma Gowda', 'Dinesh Naik',
  'Bhavana Sridhar', 'Rajesh Menon', 'Zainab Fathima', 'Chandrashekar R', 'Usha Kiran',
];

export interface SeedSummary {
  hospitalId: string;
  doctors: number;
  staff: number;
  patients: number;
  patientLogins: number;
  sessionsCreated: number;
  appointmentsCreated: number;
}

/** Hospital-local (Asia/Kolkata) calendar date `offset` days from now, as YYYY-MM-DD. */
export function istDate(offset: number, now = new Date()): string {
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
  const [y, m, d] = today.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + offset)).toISOString().slice(0, 10);
}

const SLOTS = {
  morning: { start: '09:00:00', end: '13:00:00' },
  afternoon: { start: '14:00:00', end: '18:00:00' },
} as const;

/** Thrown when the demo seed is asked to run with NODE_ENV=production and ALLOW_DEMO_SEED is not "true". */
export class SeedRefusedError extends Error {
  constructor() {
    super(
      'refusing to seed demo accounts (password demo1234) with NODE_ENV=production; set ALLOW_DEMO_SEED=true if this is a demo deployment',
    );
    this.name = 'SeedRefusedError';
  }
}

export function assertSeedAllowed(env: Record<string, string | undefined>): void {
  if (env['NODE_ENV'] === 'production' && env['ALLOW_DEMO_SEED'] !== 'true') throw new SeedRefusedError();
}

export async function seed(
  pool: Pool,
  opts: { now?: Date; log?: (m: string) => void; env?: Record<string, string | undefined> } = {},
): Promise<SeedSummary> {
  assertSeedAllowed(opts.env ?? process.env);
  const log = opts.log ?? (() => {});
  const now = opts.now ?? new Date();
  const hospitalId = stableId('hospital');
  const policy = await getPolicyByVersion(pool, 1);
  if (!policy) throw new Error('queue policy v1 missing: run migrations first');

  const passwordHash = await hashPassword(DEMO_PASSWORD);

  await pool.query(
    `INSERT INTO hospitals (id, name, timezone) VALUES ($1, 'BMSIT Teaching Hospital, Yelahanka', 'Asia/Kolkata') ON CONFLICT DO NOTHING`,
    [hospitalId],
  );

  // Doctors
  const doctorIds = DOCTORS.map((_, i) => stableId(`doctor:${i + 1}`));
  for (const [i, d] of DOCTORS.entries()) {
    await pool.query(
      `INSERT INTO doctors (id, hospital_id, full_name, department, room) VALUES ($1, $2, $3, $4, $5) ON CONFLICT DO NOTHING`,
      [doctorIds[i], hospitalId, d.name, d.department, d.room],
    );
  }

  const insertUser = (key: string, email: string, displayName: string, role: string, extra: { patientId?: string; doctorId?: string } = {}) =>
    pool.query(
      `INSERT INTO users (id, hospital_id, email, display_name, role, password_hash, patient_id, doctor_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) ON CONFLICT DO NOTHING`,
      [stableId(`user:${key}`), hospitalId, email, displayName, role, passwordHash, extra.patientId ?? null, extra.doctorId ?? null],
    );
  const assign = (userKey: string, doctorIdx: number[]) =>
    Promise.all(
      doctorIdx.map((i) =>
        pool.query(`INSERT INTO staff_assignments (user_id, doctor_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [
          stableId(`user:${userKey}`),
          doctorIds[i],
        ]),
      ),
    );
  const suffix = (n: number) => (n === 1 ? '' : String(n));
  const all = DOCTORS.map((_, i) => i);

  // Staff: 10 doctors + 6 reception + 4 follow-up + 2 admin = 22
  for (const [i, d] of DOCTORS.entries()) {
    await insertUser(`doctor${i + 1}`, `doctor${suffix(i + 1)}@hqms.test`, d.name, 'doctor', { doctorId: at(doctorIds, i) });
  }
  const receptionScopes = [all, [0, 1], [2, 3], [4, 5], [6, 7], [8, 9]];
  for (const [i, name] of RECEPTION.entries()) {
    await insertUser(`reception${i + 1}`, `reception${suffix(i + 1)}@hqms.test`, name, 'reception');
    await assign(`reception${i + 1}`, at(receptionScopes, i));
  }
  const followupScopes = [all, [0, 1, 2, 3], [4, 5, 6, 7], [8, 9]];
  for (const [i, name] of FOLLOWUP.entries()) {
    await insertUser(`followup${i + 1}`, `followup${suffix(i + 1)}@hqms.test`, name, 'followup');
    await assign(`followup${i + 1}`, at(followupScopes, i));
  }
  for (const [i, name] of ADMINS.entries()) {
    await insertUser(`admin${i + 1}`, `admin${suffix(i + 1)}@hqms.test`, name, 'admin');
  }

  // Patients: 40, the first 10 have logins (patient@, patient2@ ... patient10@)
  const patientIds = PATIENT_NAMES.map((_, i) => stableId(`patient:${i + 1}`));
  for (const [i, name] of PATIENT_NAMES.entries()) {
    const n = i + 1;
    const dob = `${1948 + ((n * 17) % 62)}-${String(1 + ((n * 5) % 12)).padStart(2, '0')}-${String(1 + ((n * 11) % 28)).padStart(2, '0')}`;
    const phone = `+91 98${String(45_000_000 + n * 123_457).padStart(8, '0').slice(0, 8)}`;
    await pool.query(
      `INSERT INTO patients (id, hospital_id, mrn, full_name, phone, date_of_birth) VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT DO NOTHING`,
      [patientIds[i], hospitalId, `BLR-${String(n).padStart(6, '0')}`, name, phone, dob],
    );
    if (n <= 10) await insertUser(`patient${n}`, `patient${suffix(n)}@hqms.test`, name, 'patient', { patientId: at(patientIds, i) });
  }

  // Sessions: today .. today+6 (IST), morning 09:00-13:00 and afternoon 14:00-18:00, 10 booked + 5 walk-in
  let sessionsCreated = 0;
  const sessionId = (di: number, day: number, label: 'morning' | 'afternoon') => stableId(`session:${di + 1}:${istDate(day, now)}:${label}`);
  await withTransaction(pool, async (tx) => {
    for (let di = 0; di < DOCTORS.length; di++) {
      for (let day = 0; day < SEED_DAYS; day++) {
        const date = istDate(day, now);
        for (const label of ['morning', 'afternoon'] as const) {
          const id = await createSession(tx, {
            id: sessionId(di, day, label),
            doctorId: at(doctorIds, di),
            sessionDate: date,
            label,
            startsAt: `${date}T${SLOTS[label].start}+05:30`,
            endsAt: `${date}T${SLOTS[label].end}+05:30`,
            slotMinutes: 20,
            status: day === 0 ? 'open' : 'scheduled',
            bookedCapacity: 10,
            walkinCapacity: 5,
            policyId: policy.id,
          });
          if (id) sessionsCreated++;
        }
      }
    }
  });

  // Appointments (through the capacity primitives). [patient#, doctor#, dayOffset, label, slotIndex]
  const demoBookings: Array<[number, number, number, 'morning' | 'afternoon', number]> = [
    [1, 1, 0, 'morning', 1], [3, 1, 0, 'morning', 0], [4, 1, 0, 'morning', 2],
    [5, 2, 0, 'morning', 0], [6, 2, 0, 'morning', 1],
    [7, 3, 0, 'morning', 0], [8, 3, 0, 'morning', 1], [9, 3, 0, 'morning', 2],
    [11, 4, 0, 'afternoon', 0], [12, 4, 0, 'afternoon', 1],
    [2, 3, 1, 'morning', 0], [13, 1, 1, 'morning', 0], [14, 1, 1, 'morning', 1],
    [15, 5, 1, 'afternoon', 0], [16, 7, 1, 'morning', 0],
  ];
  const bookedBy = stableId('user:reception1');
  let appointmentsCreated = 0;
  for (const [pn, dn, day, label, slot] of demoBookings) {
    const apptId = stableId(`appointment:${pn}:${dn}:${day}:${label}:${slot}`);
    const created = await withTransaction(pool, async (tx) => {
      const sid = sessionId(dn - 1, day, label);
      await lockDoctor(tx, at(doctorIds, dn - 1));
      const session = await lockSession(tx, sid);
      await lockCapacity(tx, sid);
      const exists = await tx.query('SELECT 1 FROM appointments WHERE id = $1', [apptId]);
      if (exists.rowCount) return false;
      const allocationId = await reserveBooked(tx, sid);
      const scheduledAt = new Date(new Date(session.startsAt).getTime() + slot * session.slotMinutes * 60_000).toISOString();
      const appt = await insertAppointment(tx, {
        id: apptId,
        patientId: at(patientIds, pn - 1),
        sessionId: sid,
        doctorId: at(doctorIds, dn - 1),
        scheduledAt,
        allocationId,
        bookedBy,
      });
      await writeAudit(tx, {
        actorId: bookedBy,
        actorRole: 'reception',
        operation: 'appointment.book',
        entityType: 'appointment',
        entityId: appt.id,
        next: { status: appt.status, sessionId: sid, scheduledAt },
        reason: 'demo seed',
        policyVersion: policy.version,
      });
      return true;
    });
    if (created) appointmentsCreated++;
  }

  const summary: SeedSummary = {
    hospitalId,
    doctors: DOCTORS.length,
    staff: DOCTORS.length + RECEPTION.length + FOLLOWUP.length + ADMINS.length,
    patients: PATIENT_NAMES.length,
    patientLogins: 10,
    sessionsCreated,
    appointmentsCreated,
  };
  log(`seed: ${JSON.stringify(summary)}`);
  return summary;
}

// CLI: `tsx db/seed/seed.ts` (normally run through `pnpm --filter @hqms/db seed`)
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const pool = createPool(process.env['DATABASE_URL'] ?? DEFAULT_DATABASE_URL);
  seed(pool, { log: (m) => process.stdout.write(`${m}\n`) })
    .catch((err) => {
      console.error(err);
      process.exitCode = 1;
    })
    .finally(() => pool.end());
}
