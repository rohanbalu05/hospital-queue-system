import { z } from 'zod';
import { ExpectedVersion, Id, Instant } from './common.js';

// ---------------------------------------------------------------------------
// Follow-up tasks (FR-11, FR-14)
// ---------------------------------------------------------------------------

export const FollowUpKind = z.enum(['post_visit', 'assistant_escalation', 'document_review', 'return_visit']);
export const FollowUpStatus = z.enum(['open', 'acknowledged', 'resolved', 'cancelled']);
export const Disposition = z.enum(['advice_given', 'return_booked', 'referred', 'no_action_needed', 'unreachable']);
export type FollowUpStatus = z.infer<typeof FollowUpStatus>;
export type Disposition = z.infer<typeof Disposition>;

export const FollowUpTask = z.object({
  id: Id,
  patientId: Id,
  patientName: z.string(),
  sourceVisitId: Id.nullable(),
  sourceMessageId: Id.nullable(),
  kind: FollowUpKind,
  title: z.string(),
  detail: z.string().nullable(),
  ownerId: Id.nullable(),
  ownerName: z.string().nullable(),
  status: FollowUpStatus,
  dueAt: Instant,
  /** Derived: unresolved and dueAt < now. Overdue tasks stay open and visible. */
  overdue: z.boolean(),
  acknowledgedAt: Instant.nullable(),
  disposition: Disposition.nullable(),
  outcomeNote: z.string().nullable(),
  resolvedAt: Instant.nullable(),
  returnAppointmentId: Id.nullable(),
  version: z.number().int().positive(),
  createdAt: Instant,
});
export type FollowUpTask = z.infer<typeof FollowUpTask>;

/** POST /follow-up-tasks (doctor/followup/admin; Idempotency-Key). */
export const CreateFollowUpTaskRequest = z.object({
  patientId: Id,
  sourceVisitId: Id.optional(),
  kind: FollowUpKind.default('post_visit'),
  title: z.string().min(3).max(160),
  detail: z.string().max(2000).optional(),
  ownerId: Id.optional(),
  dueAt: Instant,
});
export type CreateFollowUpTaskRequest = z.infer<typeof CreateFollowUpTaskRequest>;

/** GET /follow-up-tasks?owner=me|unassigned|all&status=&overdue= */
export const FollowUpListQuery = z.object({
  owner: z.enum(['me', 'unassigned', 'all']).default('me'),
  status: FollowUpStatus.optional(),
  overdue: z.coerce.boolean().optional(),
  patientId: Id.optional(),
});

/** POST /follow-up-tasks/{id}/acknowledge: caller becomes owner if unowned. */
export const AcknowledgeTaskRequest = ExpectedVersion;
/** POST /follow-up-tasks/{id}/resolve */
export const ResolveTaskRequest = ExpectedVersion.extend({
  disposition: Disposition,
  outcomeNote: z.string().min(3).max(2000),
  /** Required when disposition = return_booked. */
  returnAppointmentId: Id.optional(),
});
export type ResolveTaskRequest = z.infer<typeof ResolveTaskRequest>;
/** POST /follow-up-tasks/{id}/cancel */
export const CancelTaskRequest = ExpectedVersion.extend({ reason: z.string().min(3).max(300) });
/** POST /follow-up-tasks/{id}/return-booking: books via normal capacity, links appointment to task. Idempotency-Key. */
export const ReturnBookingRequest = z.object({ sessionId: Id });

// ---------------------------------------------------------------------------
// Documents, OCR drafts, instruction verification (FR-12, FR-13)
// ---------------------------------------------------------------------------

export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
export const MAX_UPLOAD_PAGES = 10;
export const ALLOWED_MIME_TYPES = ['application/pdf', 'image/png', 'image/jpeg'] as const;

export const DocumentStatus = z.enum(['uploaded', 'accepted', 'processing', 'ocr_ready', 'ocr_failed', 'verified', 'rejected']);
export type DocumentStatus = z.infer<typeof DocumentStatus>;

export const DocumentMeta = z.object({
  id: Id,
  patientId: Id,
  visitId: Id.nullable(),
  originalName: z.string(),
  mimeType: z.enum(ALLOWED_MIME_TYPES),
  sizeBytes: z.number().int().positive(),
  pageCount: z.number().int().positive(),
  status: DocumentStatus,
  ocrAttempts: z.number().int().nonnegative(),
  lastError: z.string().nullable(),
  version: z.number().int().positive(),
  createdAt: Instant,
});
export type DocumentMeta = z.infer<typeof DocumentMeta>;

/**
 * POST /documents (multipart: file, patientId, visitId?). Limits: 10 MB, 10 pages, pdf/png/jpeg.
 * Bytes go to ObjectStorage (private); OCR runs in the worker after commit.
 */
export const UploadDocumentFields = z.object({ patientId: Id, visitId: Id.optional() });

/** POST /documents/{id}/retry-ocr (staff): controlled retry after ocr_failed. */
export const RetryOcrRequest = ExpectedVersion;

export const OcrDraft = z.object({
  id: Id,
  documentId: Id,
  provider: z.string(),
  text: z.string(),
  blocks: z.array(z.object({ page: z.number().int().positive(), text: z.string(), bbox: z.array(z.number()).length(4).optional() })),
  createdAt: Instant,
  /** Always true: drafts are never assistant context. */
  isDraft: z.literal(true),
});
export type OcrDraft = z.infer<typeof OcrDraft>;

export const InstructionVersion = z.object({
  id: Id,
  instructionId: Id,
  patientId: Id,
  version: z.number().int().positive(),
  title: z.string(),
  body: z.string(),
  status: z.enum(['current', 'superseded']),
  verifiedBy: Id,
  verifiedByName: z.string(),
  verifiedAt: Instant,
  supersedesId: Id.nullable(),
  sourceDraftId: Id.nullable(),
});
export type InstructionVersion = z.infer<typeof InstructionVersion>;

/**
 * POST /documents/{id}/verify (doctor only, FR-01/FR-13): creates instruction version 1,
 * or a new version superseding the current one when instructionId is given.
 */
export const VerifyInstructionRequest = z.object({
  instructionId: Id.optional(),
  title: z.string().min(3).max(160),
  body: z.string().min(3).max(5000),
  sourceDraftId: Id.optional(),
});
export type VerifyInstructionRequest = z.infer<typeof VerifyInstructionRequest>;

// ---------------------------------------------------------------------------
// Bounded assistant (FR-14)
// ---------------------------------------------------------------------------

/** POST /assistant/messages (patient only, own context). */
export const AskAssistantRequest = z.object({
  question: z.string().min(2).max(1000),
  conversationId: Id.optional(),
});
export type AskAssistantRequest = z.infer<typeof AskAssistantRequest>;

export const AssistantOutcome = z.enum(['answered', 'escalated', 'refused']);
export const AssistantAnswer = z.object({
  conversationId: Id,
  messageId: Id,
  outcome: AssistantOutcome,
  answer: z.string(),
  /** Instruction versions the answer relies on (answered => at least one). */
  citations: z.array(z.object({ instructionVersionId: Id, title: z.string(), version: z.number().int().positive() })),
  /** Present when escalated: the owned staff task and when the patient will hear back. */
  escalation: z.object({ taskId: Id, dueAt: Instant }).nullable(),
  createdAt: Instant,
});
export type AssistantAnswer = z.infer<typeof AssistantAnswer>;

export const ConversationMessage = z.object({
  id: Id,
  role: z.enum(['patient', 'assistant']),
  body: z.string(),
  outcome: AssistantOutcome.nullable(),
  citations: z.array(z.object({ instructionVersionId: Id, title: z.string(), version: z.number().int().positive() })),
  escalationTaskId: Id.nullable(),
  createdAt: Instant,
});
export type ConversationMessage = z.infer<typeof ConversationMessage>;
