/** Audit trail wording: operation codes as sentences, entity types as labels. Unknown codes fall back to the code itself. */

const OPERATION_SENTENCE: Record<string, string> = {
  'appointment.book': 'Booked appointment',
  'appointment.cancel': 'Cancelled appointment',
  'appointment.reschedule': 'Rescheduled appointment',
  'appointment.reservation_release': 'Released an unused reservation',
  'assistant.ask': 'Asked the assistant a question',
  'assistant.answer': 'Assistant answered from a verified instruction',
  'assistant.escalate': 'Sent a question to the follow-up team',
  'auth.login': 'Signed in',
  'consultation.start': 'Started consultation',
  'consultation.complete': 'Completed consultation',
  'document.upload': 'Uploaded a document',
  'document.download': 'Downloaded a document',
  'document.retry_ocr': 'Retried reading a document',
  'document.ocr_started': 'Started reading a document',
  'document.ocr_completed': 'Finished reading a document',
  'document.ocr_failed': 'Could not read a document',
  'document.rejected': 'Rejected a document',
  'follow_up.create': 'Created follow-up task',
  'follow_up.acknowledge': 'Acknowledged follow-up task',
  'follow_up.resolve': 'Resolved follow-up task',
  'follow_up.cancel': 'Cancelled follow-up task',
  'follow_up.return_booking': 'Booked return visit',
  'instruction.verify': 'Verified instruction',
  'patient.register': 'Registered patient',
  'patient.search': 'Searched for a patient',
  'queue.call_next': 'Called next patient',
  'queue.call_timeout': 'Call timed out, patient skipped',
  'queue.priority': 'Set clinical priority',
  'queue.absent': 'Marked patient absent',
  'queue.skip': 'Skipped patient',
  'queue.re_enter': 'Re-entered skipped patient',
  'session.create': 'Created session',
  'session.open': 'Opened session',
  'session.capacity.update': 'Changed session capacity',
  'policy.activate': 'Activated policy version',
  'staff.assignments': 'Changed staff assignments',
  'visit.check_in': 'Checked in patient',
  'visit.walk_in': 'Admitted walk-in',
};

export function operationSentence(operation: string): string {
  return OPERATION_SENTENCE[operation] ?? operation;
}

const ENTITY_LABEL: Record<string, string> = {
  appointment: 'Appointment',
  session: 'Session',
  queue_entry: 'Queue entry',
  visit: 'Visit',
  follow_up_task: 'Follow-up task',
  document: 'Document',
  instruction_version: 'Instruction version',
  instruction: 'Instruction',
  policy: 'Policy',
  patient: 'Patient',
  message: 'Assistant message',
  user: 'Staff account',
};

export function entityLabel(entityType: string): string {
  return ENTITY_LABEL[entityType] ?? entityType;
}

const ROLE_WORD: Record<string, string> = {
  patient: 'Patient',
  reception: 'Reception',
  doctor: 'Doctor',
  followup: 'Follow-up',
  admin: 'Admin',
  system: 'System',
};

export const roleWord = (role: string): string => ROLE_WORD[role] ?? role;
