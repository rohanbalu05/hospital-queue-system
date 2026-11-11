import type { Doctor } from '@hqms/contracts';
import { maybeOne, many, type Queryable, type QueryResultRow } from '../pool.js';

const mapDoctor = (r: QueryResultRow): Doctor => ({
  id: r.id,
  fullName: r.full_name,
  department: r.department,
  room: r.room,
  active: r.active,
});

export async function getDoctor(db: Queryable, id: string): Promise<Doctor | null> {
  const r = await maybeOne(db, `SELECT id, full_name, department, room, active FROM doctors WHERE id = $1`, [id]);
  return r ? mapDoctor(r) : null;
}

export async function listDoctors(
  db: Queryable,
  opts: { department?: string; activeOnly?: boolean } = {},
): Promise<Doctor[]> {
  const rows = await many(
    db,
    `SELECT id, full_name, department, room, active FROM doctors
      WHERE ($1::text IS NULL OR department = $1) AND ($2::boolean = false OR active)
      ORDER BY department, full_name`,
    [opts.department ?? null, opts.activeOnly ?? false],
  );
  return rows.map(mapDoctor);
}
