import { z } from 'zod';
import { Id, Instant, LocalDate, Role } from './common.js';

export const LoginRequest = z.object({
  email: z.string().email(),
  password: z.string().min(1).max(200),
});
export type LoginRequest = z.infer<typeof LoginRequest>;

/** GET /me and POST /auth/login response. The session itself is an httpOnly cookie. */
export const Me = z.object({
  userId: Id,
  email: z.string().email(),
  displayName: z.string(),
  role: Role,
  patientId: Id.nullable(),
  doctorId: Id.nullable(),
  /** Doctors a reception/followup user is assigned to; admins: all; patients: []. */
  assignedDoctorIds: z.array(Id),
});
export type Me = z.infer<typeof Me>;

export const Patient = z.object({
  id: Id,
  mrn: z.string(),
  fullName: z.string(),
  phone: z.string().nullable(),
  dateOfBirth: LocalDate.nullable(),
  hasLogin: z.boolean(),
  createdAt: Instant,
});
export type Patient = z.infer<typeof Patient>;

/** POST /patients: reception-assisted registration (identity without login). */
export const RegisterPatientRequest = z.object({
  fullName: z.string().min(2).max(120),
  phone: z
    .string()
    .regex(/^\+?[0-9 ]{8,15}$/)
    .nullable()
    .optional(),
  dateOfBirth: LocalDate.nullable().optional(),
});
export type RegisterPatientRequest = z.infer<typeof RegisterPatientRequest>;

/** GET /patients?q= : staff search by name, phone or MRN. */
export const PatientSearchQuery = z.object({ q: z.string().min(1).max(80) });

export const Doctor = z.object({
  id: Id,
  fullName: z.string(),
  department: z.string(),
  room: z.string(),
  active: z.boolean(),
});
export type Doctor = z.infer<typeof Doctor>;

export const StaffAssignment = z.object({ userId: Id, doctorId: Id });
export type StaffAssignment = z.infer<typeof StaffAssignment>;

/** GET /admin/staff (admin): staff users with the doctors they are assigned to. */
export const StaffMember = z.object({
  userId: Id,
  displayName: z.string(),
  email: z.string(),
  role: z.enum(['reception', 'doctor', 'followup', 'admin']),
  doctorIds: z.array(Id),
});
export type StaffMember = z.infer<typeof StaffMember>;

/** PUT /admin/staff/{userId}/assignments */
export const SetAssignmentsRequest = z.object({ doctorIds: z.array(Id).max(50) });
export type SetAssignmentsRequest = z.infer<typeof SetAssignmentsRequest>;
