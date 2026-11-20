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
  /**
   * Set after reception has looked at the possible matches and still wants a new record (PR-22). Without it, a
   * registration whose phone matches an existing patient, or whose name matches one with no phone on file, is
   * refused with 409 CONFLICT and details PossibleDuplicates (D-038).
   */
  confirmNew: z.boolean().optional(),
});
export type RegisterPatientRequest = z.infer<typeof RegisterPatientRequest>;

/** `error.details` of the 409 a registration gets when it looks like an existing patient (PR-22). */
export const PossibleDuplicates = z.object({
  reason: z.literal('POSSIBLE_DUPLICATE'),
  candidates: z.array(z.lazy(() => Patient)).max(10),
});
export type PossibleDuplicates = z.infer<typeof PossibleDuplicates>;

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
  /** False once deactivated (cannot sign in; sessions revoked). Optional for older fixtures. */
  active: z.boolean().optional(),
  /** Doctor accounts: the doctor record they sign in for. */
  doctorId: Id.nullable().optional(),
});
export type StaffMember = z.infer<typeof StaffMember>;

export const StaffRole = z.enum(['reception', 'doctor', 'followup', 'admin']);

/**
 * POST /admin/staff (admin): create a staff login (PR-42). Deliberately NOT idempotent: a replay would have to store the temporary password; a retried create gets 409 (email exists). A doctor account links an existing
 * doctor record without a login (`doctorId`) or creates one (`newDoctor`). Reception/follow-up may start with
 * assignments. The response carries a one-time temporary password the admin hands over; it is never stored or
 * shown again (only its argon2 hash is stored).
 */
export const CreateStaffRequest = z
  .object({
    displayName: z.string().trim().min(2).max(120),
    email: z.string().trim().toLowerCase().email().max(200),
    role: StaffRole,
    doctorId: Id.optional(),
    newDoctor: z.object({ department: z.string().trim().min(2).max(80), room: z.string().trim().min(1).max(40) }).optional(),
    doctorIds: z.array(Id).max(50).optional(),
  })
  .refine((v) => v.role !== 'doctor' || Boolean(v.doctorId) !== Boolean(v.newDoctor), {
    message: 'A doctor account needs exactly one of doctorId or newDoctor',
  });
export type CreateStaffRequest = z.infer<typeof CreateStaffRequest>;

export const StaffCredentials = z.object({ member: StaffMember, temporaryPassword: z.string().min(12) });
export type StaffCredentials = z.infer<typeof StaffCredentials>;

/**
 * POST /admin/staff/{userId}/deactivate | /activate -> StaffMember; POST /admin/staff/{userId}/reset-password ->
 * StaffCredentials. Deactivate and reset revoke the user's login sessions. An admin cannot deactivate themself or
 * the last active admin. All audited (no password material in audit).
 */
export const StaffStatusRequest = z.object({ reason: z.string().trim().min(3).max(300) });
export type StaffStatusRequest = z.infer<typeof StaffStatusRequest>;

/** PUT /admin/staff/{userId}/assignments */
export const SetAssignmentsRequest = z.object({ doctorIds: z.array(Id).max(50) });
export type SetAssignmentsRequest = z.infer<typeof SetAssignmentsRequest>;
