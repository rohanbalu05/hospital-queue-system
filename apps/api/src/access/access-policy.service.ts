import { Injectable } from '@nestjs/common';
import type { Appointment } from '@hqms/contracts';
import { forbidden, notFound, validationFailed } from '../common/errors.js';
import type { AuthUser } from '../common/request-context.js';

/**
 * Server-side authorization used inside handlers (FR-01, NFR-06). Roles are checked by the route
 * guard; this service adds the two things a role cannot say: assignment and ownership.
 *
 *  - patient: only their own patientId. Anything of another patient answers 404, so existence is not disclosed.
 *  - reception / followup: only doctors listed in staff_assignments (403 outside).
 *  - doctor: only their own doctorId (403 outside).
 *  - admin: everything.
 */
@Injectable()
export class AccessPolicy {
  isStaff(user: AuthUser): boolean {
    return user.role !== 'patient';
  }

  /** May this user act on (read or change data of) this doctor's sessions? */
  canActOnDoctor(user: AuthUser, doctorId: string): boolean {
    switch (user.role) {
      case 'admin':
        return true;
      case 'doctor':
        return user.doctorId === doctorId;
      case 'reception':
      case 'followup':
        return user.assignedDoctorIds.includes(doctorId);
      case 'patient':
        return false;
    }
  }

  /** Doctor ids a staff user may see, or `null` for "all" (admin). Patients get an empty list. */
  doctorScope(user: AuthUser): string[] | null {
    switch (user.role) {
      case 'admin':
        return null;
      case 'doctor':
        return user.doctorId ? [user.doctorId] : [];
      case 'reception':
      case 'followup':
        return user.assignedDoctorIds;
      case 'patient':
        return [];
    }
  }

  assertDoctorScope(user: AuthUser, doctorId: string): void {
    if (!this.canActOnDoctor(user, doctorId)) throw forbidden('This doctor is not in your assignment');
  }

  /** Patient identity: staff may look up patients (they must, to register and book); a patient only themselves. */
  assertPatientAccess(user: AuthUser, patientId: string): void {
    if (user.role === 'patient' && user.patientId !== patientId) throw notFound('Patient');
  }

  /** The patient id a booking is for: patients book for themselves only, staff must name the patient. */
  resolveBookingPatient(user: AuthUser, requested: string | undefined): string {
    if (user.role === 'patient') {
      if (!user.patientId) throw forbidden();
      if (requested !== undefined && requested !== user.patientId) throw notFound('Patient');
      return user.patientId;
    }
    if (!requested) throw validationFailed('patientId is required when booking for a patient');
    return requested;
  }

  /** Read or act on an appointment: the owning patient, or staff in scope of its doctor. */
  assertAppointmentAccess(user: AuthUser, appt: Pick<Appointment, 'patientId' | 'doctorId'>): void {
    if (user.role === 'patient') {
      if (user.patientId !== appt.patientId) throw notFound('Appointment');
      return;
    }
    this.assertDoctorScope(user, appt.doctorId);
  }
}
