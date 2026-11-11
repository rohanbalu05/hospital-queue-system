import type { Patient } from '@hqms/contracts';
import { firstRow, maybeOne, many, required, type Queryable, type QueryResultRow } from '../pool.js';
import type { Tx } from '../tx.js';

const SELECT_PATIENT = `
  SELECT p.id, p.mrn, p.full_name, p.phone, p.date_of_birth, p.created_at,
         EXISTS (SELECT 1 FROM users u WHERE u.patient_id = p.id) AS has_login
    FROM patients p`;

const mapPatient = (r: QueryResultRow): Patient => ({
  id: r.id,
  mrn: r.mrn,
  fullName: r.full_name,
  phone: r.phone,
  dateOfBirth: r.date_of_birth,
  hasLogin: r.has_login,
  createdAt: r.created_at,
});

export async function getPatient(db: Queryable, id: string): Promise<Patient | null> {
  const r = await maybeOne(db, `${SELECT_PATIENT} WHERE p.id = $1`, [id]);
  return r ? mapPatient(r) : null;
}

/** Patient by MRN (exact, case-insensitive). */
export async function getPatientByMrn(db: Queryable, mrn: string): Promise<Patient | null> {
  const r = await maybeOne(db, `${SELECT_PATIENT} WHERE upper(p.mrn) = upper($1)`, [mrn]);
  return r ? mapPatient(r) : null;
}

/**
 * Staff search by name (substring, case-insensitive), phone (digits substring) or MRN (prefix/substring).
 * Authorisation (which staff may search) is the API layer's job.
 */
export async function searchPatients(db: Queryable, q: string, limit = 20): Promise<Patient[]> {
  const term = q.trim();
  if (!term) return [];
  const like = `%${term.replace(/[\\%_]/g, (c) => '\\' + c)}%`;
  const digits = term.replace(/\D/g, '');
  const rows = await many(
    db,
    `${SELECT_PATIENT}
      WHERE p.full_name ILIKE $1
         OR p.mrn ILIKE $1
         OR ($2 <> '' AND regexp_replace(coalesce(p.phone, ''), '\\D', '', 'g') LIKE '%' || $2 || '%')
      ORDER BY (lower(p.full_name) = lower($3)) DESC, p.full_name, p.mrn
      LIMIT $4`,
    [like, digits, term, limit],
  );
  return rows.map(mapPatient);
}

export interface CreatePatientInput {
  fullName: string;
  phone?: string | null;
  dateOfBirth?: string | null;
  createdBy?: string | null;
  /** Defaults to the (single) hospital. */
  hospitalId?: string;
  /** Override the generated MRN (seed only). */
  mrn?: string;
  /** Stable id (seed only). */
  id?: string;
}

/** Create a patient with a generated MRN like `BLR-001000` (sequence-backed, lock-free). */
export async function createPatient(tx: Tx, p: CreatePatientInput): Promise<Patient> {
  const res = await tx.query<{ id: string }>(
    `INSERT INTO patients (id, hospital_id, mrn, full_name, phone, date_of_birth, created_by)
     VALUES (
       COALESCE($1::uuid, gen_random_uuid()),
       COALESCE($2::uuid, (SELECT id FROM hospitals ORDER BY created_at, id LIMIT 1)),
       COALESCE($3, 'BLR-' || lpad(nextval('patient_mrn_seq')::text, 6, '0')),
       $4, $5, $6, $7)
     RETURNING id`,
    [p.id ?? null, p.hospitalId ?? null, p.mrn ?? null, p.fullName, p.phone ?? null, p.dateOfBirth ?? null, p.createdBy ?? null],
  );
  return required(await getPatient(tx, firstRow(res, 'patient').id), 'patient');
}
