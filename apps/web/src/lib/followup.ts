import { ALLOWED_MIME_TYPES, MAX_UPLOAD_BYTES, type Disposition, type DocumentStatus, type FollowUpStatus } from '@hqms/contracts';

/** Words for follow-up tasks. Status is always a word; colour only reinforces it. */
export const TASK_STATUS_WORD: Record<FollowUpStatus, string> = {
  open: 'Open',
  acknowledged: 'Acknowledged',
  resolved: 'Resolved',
  cancelled: 'Cancelled',
};

export const KIND_WORD: Record<string, string> = {
  post_visit: 'Post-visit check',
  assistant_escalation: 'Assistant question',
  document_review: 'Document review',
  return_visit: 'Return visit',
};

export const DISPOSITION_WORD: Record<Disposition, string> = {
  advice_given: 'Advice given',
  return_booked: 'Return booked',
  referred: 'Referred',
  no_action_needed: 'No action needed',
  unreachable: 'Unreachable',
};

export const DISPOSITIONS = Object.keys(DISPOSITION_WORD) as Disposition[];

export const isClosed = (status: FollowUpStatus) => status === 'resolved' || status === 'cancelled';

/** "40 min", "26 h", "2 d 3 h". Whole units, rounded down. */
export function durationWord(minutes: number): string {
  const m = Math.max(0, Math.floor(minutes));
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h} h`;
  const d = Math.floor(h / 24);
  const rest = h % 24;
  return rest === 0 ? `${d} d` : `${d} d ${rest} h`;
}

export interface TaskTiming {
  overdue: boolean;
  /** "Overdue 26 h", "Due in 3 h", or null once the task is closed. */
  label: string | null;
}

/**
 * Overdue is derived from the clock, not only from the server flag, so a screen left open turns overdue on time.
 * A closed task has no timing: overdue rows stay listed until resolved or cancelled (FR-11).
 */
export function taskTiming(task: { status: FollowUpStatus; dueAt: string; overdue: boolean }, now: number): TaskTiming {
  if (isClosed(task.status)) return { overdue: false, label: null };
  const diffMin = (now - new Date(task.dueAt).getTime()) / 60_000;
  const overdue = task.overdue || diffMin > 0;
  return overdue ? { overdue: true, label: `Overdue ${durationWord(Math.max(diffMin, 0))}` } : { overdue: false, label: `Due in ${durationWord(-diffMin)}` };
}

/** Open work first, overdue before the rest, earliest due first; closed tasks last. */
export function sortTasks<T extends { status: FollowUpStatus; dueAt: string; overdue: boolean }>(tasks: readonly T[], now: number): T[] {
  const rank = (t: T) => (isClosed(t.status) ? 2 : taskTiming(t, now).overdue ? 0 : 1);
  return [...tasks].sort((a, b) => rank(a) - rank(b) || a.dueAt.localeCompare(b.dueAt));
}

/** What a patient sees for a document. Staff-only words (OCR) never reach the patient. */
export const PATIENT_DOCUMENT_STATUS: Record<DocumentStatus, { word: string; hint: string }> = {
  uploaded: { word: 'Uploaded', hint: 'We have your file and will start reading it shortly.' },
  accepted: { word: 'Uploaded', hint: 'We have your file and will start reading it shortly.' },
  processing: { word: 'Processing', hint: 'We are reading your document.' },
  ocr_ready: { word: 'Ready for review', hint: 'A doctor will check it before it is used.' },
  ocr_failed: { word: "Couldn't read. Staff will review", hint: 'You do not need to upload it again.' },
  verified: { word: 'Verified', hint: 'Your doctor has checked this instruction.' },
  rejected: { word: 'Not accepted', hint: 'Ask reception if you need to send it again.' },
};

/** What a doctor sees in the review inbox. */
export const STAFF_DOCUMENT_STATUS: Partial<Record<DocumentStatus, string>> = {
  ocr_ready: 'OCR ready',
  ocr_failed: 'OCR failed',
  processing: 'Processing',
  uploaded: 'Uploaded',
  accepted: 'Uploaded',
  verified: 'Verified',
  rejected: 'Rejected',
};

export const isInFlight = (status: DocumentStatus) => status === 'uploaded' || status === 'accepted' || status === 'processing';

const MB = 1024 * 1024;
export const UPLOAD_LIMIT_WORDS = 'PDF, PNG or JPEG, up to 10 MB and 10 pages.';

/** Client-side checks that mirror the server limits, so an obvious mistake fails before the upload. */
export function validateUpload(file: Pick<File, 'size' | 'type' | 'name'>): string | null {
  if (!(ALLOWED_MIME_TYPES as readonly string[]).includes(file.type)) {
    return 'This file type is not accepted. Choose a PDF, PNG or JPEG.';
  }
  if (file.size > MAX_UPLOAD_BYTES) {
    return `This file is ${(file.size / MB).toFixed(1)} MB. The limit is 10 MB. Choose a smaller file or a lower-resolution scan.`;
  }
  if (file.size === 0) return 'This file is empty. Choose another file.';
  return null;
}

export function fileSizeWord(bytes: number): string {
  return bytes >= MB ? `${(bytes / MB).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

/** Decision reasons in the audit and reports, in words. Unknown reasons pass through unchanged. */
export function reasonWord(reason: string): string {
  switch (reason) {
    case 'ROTATION':
      return 'Rotation';
    case 'AGING':
      return 'Aging';
    case 'CLINICAL_PRIORITY':
      return 'Clinical priority';
    case 'NO_ALLOCATION':
      return 'No one waiting';
    default:
      return reason;
  }
}

/** A short stable reference for an id, for tables where the full UUID is noise. */
export const shortId = (id: string | null | undefined) => (id ? id.slice(0, 8) : '-');

/** The visit a task came from, in words: "Wed 4 Nov, Dr. Meenakshi Rao" (or a short reference when the API sends no detail). */
export function sourceVisitWord(
  task: { sourceVisitId: string | null; sourceVisit?: { sessionDate: string; doctorName: string } | null | undefined },
  formatDate: (d: string) => string,
): string {
  if (task.sourceVisit) return `${formatDate(task.sourceVisit.sessionDate)}, ${task.sourceVisit.doctorName}`;
  return task.sourceVisitId ? `Visit ${shortId(task.sourceVisitId)}` : 'No visit linked';
}
