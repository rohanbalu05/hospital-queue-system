import type { ArrivalResult, Id, Patient } from '@hqms/contracts';
import type { StaffAppointment } from '@/api/schemas';

/** One row in the arrivals list: a patient, and their appointment in the selected session if they have one. */
export interface ArrivalItem {
  key: string;
  patientId: Id;
  name: string;
  mrn: string | null;
  phone: string | null;
  appointment: StaffAppointment | null;
}

/** Fallback when the API sends no patient name on an appointment (contract gap). */
export const shortRef = (id: string) => `Patient ${id.slice(0, 4)}`;

export function itemFromAppointment(a: StaffAppointment): ArrivalItem {
  return {
    key: a.id,
    patientId: a.patientId,
    name: a.patientName ?? shortRef(a.patientId),
    mrn: a.patientMrn ?? null,
    phone: a.patientPhone ?? null,
    appointment: a,
  };
}

export function itemFromPatient(p: Patient, appointments: StaffAppointment[]): ArrivalItem {
  const appt = appointments.find((a) => a.patientId === p.id && (a.status === 'booked' || a.status === 'checked_in')) ?? appointments.find((a) => a.patientId === p.id) ?? null;
  return { key: appt?.id ?? p.id, patientId: p.id, name: p.fullName, mrn: p.mrn, phone: p.phone, appointment: appt };
}

const ACTIVE_ORDER: Record<string, number> = { booked: 0, checked_in: 1 };

/**
 * Empty search: today's appointments for the session, expected first, then by time.
 * Typed search: server matches (name, phone or MRN) joined to this session's appointments,
 * plus appointments whose own name/MRN/phone already matches.
 */
export function buildItems(q: string, appointments: StaffAppointment[], patients: Patient[] | undefined): ArrivalItem[] {
  const term = q.trim().toLowerCase();
  if (!term) {
    return [...appointments]
      .sort((a, b) => (ACTIVE_ORDER[a.status] ?? 2) - (ACTIVE_ORDER[b.status] ?? 2) || a.scheduledAt.localeCompare(b.scheduledAt))
      .map(itemFromAppointment);
  }
  const items = new Map<string, ArrivalItem>();
  for (const p of patients ?? []) {
    const item = itemFromPatient(p, appointments);
    items.set(p.id, item);
  }
  for (const a of appointments) {
    if (items.has(a.patientId)) continue;
    const hay = `${a.patientName ?? ''} ${a.patientMrn ?? ''} ${a.patientPhone ?? ''}`.toLowerCase();
    if (hay.includes(term)) items.set(a.patientId, itemFromAppointment(a));
  }
  return [...items.values()];
}

/** Can this arrival be checked in right now? Only a booked appointment can. */
export const canCheckIn = (item: ArrivalItem | null): boolean => item?.appointment?.status === 'booked';

/** Walk-in is for a patient with no live appointment in this session. */
export const canAdmitWalkIn = (item: ArrivalItem | null): boolean => {
  const s = item?.appointment?.status;
  return item !== null && s !== 'booked' && s !== 'checked_in';
};

export interface ArrivalOutcome {
  result: ArrivalResult;
  name: string;
  /** What the desk just did, using the same verb as the toast. */
  verb: 'Checked in' | 'Admitted';
}

export interface PanelError {
  code: string;
  title: string;
  message: string;
  hint?: string;
}
