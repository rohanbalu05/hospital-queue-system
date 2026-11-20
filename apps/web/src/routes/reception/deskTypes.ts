import type { Id } from '@hqms/contracts';

/** The patient the reception desk sheet is open for (shared by PatientDesk and DeskBooking without an import cycle). */
export interface DeskPatient {
  id: Id;
  name: string;
  mrn: string | null;
  phone: string | null;
}
