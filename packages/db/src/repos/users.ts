import type { Me, Role } from '@hqms/contracts';
import { maybeOne, many, type Queryable } from '../pool.js';
import type { Tx } from '../tx.js';

/** Full user row including the password hash: for the identity provider only, never serialise it. */
export interface UserRecord {
  id: string;
  hospitalId: string;
  email: string;
  displayName: string;
  role: Role;
  identityProvider: 'local' | 'identity-platform';
  idpSubject: string | null;
  passwordHash: string | null;
  patientId: string | null;
  doctorId: string | null;
  active: boolean;
  createdAt: string;
}

const USER_COLS = `id, hospital_id, email, display_name, role, identity_provider, idp_subject, password_hash,
                   patient_id, doctor_id, active, created_at`;

const mapUser = (r: any): UserRecord => ({
  id: r.id,
  hospitalId: r.hospital_id,
  email: r.email,
  displayName: r.display_name,
  role: r.role,
  identityProvider: r.identity_provider,
  idpSubject: r.idp_subject,
  passwordHash: r.password_hash,
  patientId: r.patient_id,
  doctorId: r.doctor_id,
  active: r.active,
  createdAt: r.created_at,
});

/** Case-insensitive email lookup. */
export async function getUserByEmail(db: Queryable, email: string): Promise<UserRecord | null> {
  const r = await maybeOne(db, `SELECT ${USER_COLS} FROM users WHERE lower(email) = lower($1)`, [email]);
  return r ? mapUser(r) : null;
}

export async function getUserById(db: Queryable, id: string): Promise<UserRecord | null> {
  const r = await maybeOne(db, `SELECT ${USER_COLS} FROM users WHERE id = $1`, [id]);
  return r ? mapUser(r) : null;
}

/** Doctors a reception/followup user is assigned to (explicit rows only). */
export async function getAssignedDoctorIds(db: Queryable, userId: string): Promise<string[]> {
  const rows = await many<{ doctor_id: string }>(
    db,
    `SELECT doctor_id FROM staff_assignments WHERE user_id = $1 ORDER BY doctor_id`,
    [userId],
  );
  return rows.map((r) => r.doctor_id);
}

/** Replace a user's assignments (admin). Caller writes the audit row. */
export async function setAssignedDoctorIds(tx: Tx, userId: string, doctorIds: string[]): Promise<void> {
  await tx.query(`DELETE FROM staff_assignments WHERE user_id = $1`, [userId]);
  if (doctorIds.length > 0) {
    await tx.query(
      `INSERT INTO staff_assignments (user_id, doctor_id) SELECT $1, d FROM unnest($2::uuid[]) AS d`,
      [userId, doctorIds],
    );
  }
}

/** The /me payload. Admins see every doctor as assigned; patients none. */
export async function getMe(db: Queryable, userId: string): Promise<Me | null> {
  const u = await getUserById(db, userId);
  if (!u || !u.active) return null;
  let assigned: string[] = [];
  if (u.role === 'admin') {
    assigned = (await many<{ id: string }>(db, `SELECT id FROM doctors WHERE active ORDER BY id`)).map((r) => r.id);
  } else if (u.role === 'reception' || u.role === 'followup') {
    assigned = await getAssignedDoctorIds(db, u.id);
  } else if (u.role === 'doctor' && u.doctorId) {
    assigned = [u.doctorId];
  }
  return {
    userId: u.id,
    email: u.email,
    displayName: u.displayName,
    role: u.role,
    patientId: u.patientId,
    doctorId: u.doctorId,
    assignedDoctorIds: assigned,
  };
}

/** Store a login session; only the SHA-256 of the cookie token is kept. */
export async function createAuthSession(
  db: Queryable,
  s: { tokenHash: string; userId: string; expiresAt: Date | string },
): Promise<void> {
  await db.query(`INSERT INTO auth_sessions (token_hash, user_id, expires_at) VALUES ($1, $2, $3)`, [
    s.tokenHash,
    s.userId,
    s.expiresAt,
  ]);
}

/** The active (not revoked, not expired) user for a token hash, or null. */
export async function findUserByAuthToken(db: Queryable, tokenHash: string): Promise<UserRecord | null> {
  const r = await maybeOne(
    db,
    `SELECT ${USER_COLS.split(',').map((c) => 'u.' + c.trim()).join(', ')}
       FROM auth_sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = $1 AND s.revoked_at IS NULL AND s.expires_at > now() AND u.active`,
    [tokenHash],
  );
  return r ? mapUser(r) : null;
}

export async function revokeAuthSession(db: Queryable, tokenHash: string): Promise<void> {
  await db.query(`UPDATE auth_sessions SET revoked_at = now() WHERE token_hash = $1 AND revoked_at IS NULL`, [tokenHash]);
}
