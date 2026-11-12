import { z } from 'zod';
import { Appointment, Doctor, Patient, Session } from '@hqms/contracts';

/**
 * List endpoints are documented as returning the items; the API may wrap them as { items, nextCursor }
 * (the contracts' Page helper). Accept both so the screens do not depend on that choice.
 */
export const listOf = <T extends z.ZodTypeAny>(item: T) =>
  z.union([z.array(item), z.object({ items: z.array(item) })]).transform((v): Array<z.infer<T>> => (Array.isArray(v) ? v : v.items));

export const DoctorList = listOf(Doctor);
export const SessionList = listOf(Session);
export const PatientList = listOf(Patient);
export const AppointmentList = listOf(Appointment);

/**
 * Staff appointment rows. The Appointment contract has no patient name, MRN or phone, which the arrivals
 * desk needs. These optional fields are read when the API sends them (contract gap, see the W1 report);
 * the desk falls back to a short reference when they are missing.
 */
export const StaffAppointment = Appointment.extend({
  patientName: z.string().optional(),
  patientMrn: z.string().optional(),
  patientPhone: z.string().nullable().optional(),
});
export type StaffAppointment = z.infer<typeof StaffAppointment>;
export const StaffAppointmentList = listOf(StaffAppointment);
