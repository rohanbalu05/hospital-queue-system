import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { z } from 'zod';
import {
  Appointment,
  AssistantAnswer,
  ConversationMessage,
  DocumentMeta,
  FollowUpTask,
  Id,
  InstructionVersion,
  LocalDate,
  OcrDraft,
  type AskAssistantRequest,
  type Id as IdT,
  type ResolveTaskRequest,
  type VerifyInstructionRequest,
} from '@hqms/contracts';
import { apiFetch, useIdempotentMutation, type ApiRequestError } from '@/lib/api';
import { get } from './queries';
import { listOf } from './schemas';

/**
 * Wave 3 screens are built against the contracts with mocks. Where a screen needs a field the contract does not
 * carry yet, the schema below adds it as optional (see the W3 report, "contract gaps"). The screens degrade
 * gracefully when the field is missing.
 */

/** FollowUpTask plus a readable source visit. Gap: the contract has only sourceVisitId. */
export const SourceVisit = z.object({
  sessionDate: LocalDate,
  doctorId: Id,
  doctorName: z.string(),
  department: z.string(),
});
export const FollowUpTaskView = FollowUpTask.extend({ sourceVisit: SourceVisit.nullable().optional() });
export type FollowUpTaskView = z.infer<typeof FollowUpTaskView>;

/** GET /review-inbox rows: DocumentMeta plus the patient's name. Gap: not in the contract. */
export const ReviewItem = DocumentMeta.extend({ patientName: z.string() });
export type ReviewItem = z.infer<typeof ReviewItem>;

export const followKeys = {
  tasks: ['followups'] as const,
  taskList: (p: TaskFilter) => ['followups', 'list', p] as const,
  task: (id: IdT) => ['followups', 'task', id] as const,
  documents: (patientId: IdT) => ['documents', patientId] as const,
  inbox: ['review-inbox'] as const,
  drafts: (documentId: IdT) => ['drafts', documentId] as const,
  instructions: (patientId: IdT) => ['instructions', patientId] as const,
  conversation: (id: IdT) => ['assistant', 'conversation', id] as const,
};

// ---------------------------------------------------------------------------
// Follow-up tasks
// ---------------------------------------------------------------------------

export interface TaskFilter {
  owner?: 'me' | 'unassigned' | 'all';
  status?: FollowUpTask['status'];
  overdue?: boolean;
  patientId?: IdT;
}

/** GET /follow-up-tasks?owner=&status=&overdue=&patientId= */
export function useFollowUpTasks(filter: TaskFilter, options: { enabled?: boolean } = {}) {
  return useQuery<FollowUpTaskView[], ApiRequestError>({
    queryKey: followKeys.taskList(filter),
    queryFn: ({ signal }) =>
      get(
        '/follow-up-tasks',
        {
          ...(filter.owner ? { owner: filter.owner } : {}),
          ...(filter.status ? { status: filter.status } : {}),
          ...(filter.overdue !== undefined ? { overdue: String(filter.overdue) } : {}),
          ...(filter.patientId ? { patientId: filter.patientId } : {}),
        },
        listOf(FollowUpTaskView),
        signal,
      ),
    enabled: options.enabled ?? true,
    refetchInterval: 30_000,
  });
}

/** GET /follow-up-tasks/:id */
export function useFollowUpTask(id: IdT | undefined) {
  return useQuery<FollowUpTaskView, ApiRequestError>({
    queryKey: followKeys.task(id ?? 'none'),
    queryFn: ({ signal }) => apiFetch(`/follow-up-tasks/${id}`, { schema: FollowUpTaskView, signal }),
    enabled: id !== undefined,
  });
}

function useTaskCommand<V extends { taskId: IdT }>(path: 'acknowledge' | 'resolve' | 'cancel', body: (v: V) => unknown) {
  const qc = useQueryClient();
  return useMutation<FollowUpTaskView, ApiRequestError, V>({
    mutationFn: (v) => apiFetch(`/follow-up-tasks/${v.taskId}/${path}`, { method: 'POST', body: body(v), schema: FollowUpTaskView }),
    onSuccess: (task) => {
      qc.setQueryData(followKeys.task(task.id), task);
    },
    onSettled: () => void qc.invalidateQueries({ queryKey: followKeys.tasks }),
  });
}

/** POST /follow-up-tasks/:id/acknowledge: the caller becomes the owner. */
export function useAcknowledgeTask() {
  return useTaskCommand<{ taskId: IdT; expectedVersion: number }>('acknowledge', (v) => ({ expectedVersion: v.expectedVersion }));
}

/** POST /follow-up-tasks/:id/resolve */
export function useResolveTask() {
  return useTaskCommand<{ taskId: IdT } & ResolveTaskRequest>('resolve', ({ taskId: _t, ...rest }) => rest);
}

/** POST /follow-up-tasks/:id/cancel */
export function useCancelTask() {
  return useTaskCommand<{ taskId: IdT; expectedVersion: number; reason: string }>('cancel', ({ taskId: _t, ...rest }) => rest);
}

/** POST /follow-up-tasks/:id/return-booking {sessionId} (Idempotency-Key). Goes through normal capacity: 409 CAPACITY_FULL. */
export function useReturnBooking() {
  const qc = useQueryClient();
  return useIdempotentMutation<Appointment, { taskId: IdT; sessionId: IdT }>(
    (v, key) =>
      apiFetch(`/follow-up-tasks/${v.taskId}/return-booking`, {
        method: 'POST',
        body: { sessionId: v.sessionId },
        idempotencyKey: key,
        schema: Appointment,
      }),
    {
      onSettled: () => {
        void qc.invalidateQueries({ queryKey: followKeys.tasks });
        void qc.invalidateQueries({ queryKey: ['sessions'] });
        void qc.invalidateQueries({ queryKey: ['appointments'] });
      },
    },
  );
}

// ---------------------------------------------------------------------------
// Documents, OCR drafts, instructions
// ---------------------------------------------------------------------------

/** GET /documents?patientId=. Polls while any document is still being read. */
export function useDocuments(patientId: IdT | null | undefined) {
  return useQuery<DocumentMeta[], ApiRequestError>({
    queryKey: followKeys.documents(patientId ?? 'none'),
    queryFn: ({ signal }) => get('/documents', { patientId: patientId ?? undefined }, listOf(DocumentMeta), signal),
    enabled: Boolean(patientId),
    refetchInterval: (q) => (q.state.data?.some((d) => d.status === 'uploaded' || d.status === 'accepted' || d.status === 'processing') ? 4_000 : false),
  });
}

/** POST /documents (multipart: file, patientId, visitId?). Errors: UPLOAD_TOO_LARGE, UPLOAD_TOO_MANY_PAGES, UNSUPPORTED_MEDIA_TYPE. */
export function useUploadDocument() {
  const qc = useQueryClient();
  return useMutation<DocumentMeta, ApiRequestError, { file: File; patientId: IdT; visitId?: IdT }>({
    mutationFn: ({ file, patientId, visitId }) => {
      const form = new FormData();
      form.append('file', file);
      form.append('patientId', patientId);
      if (visitId) form.append('visitId', visitId);
      return apiFetch('/documents', { method: 'POST', body: form, schema: DocumentMeta });
    },
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: ['documents'] });
      void qc.invalidateQueries({ queryKey: followKeys.inbox });
    },
  });
}

/** GET /review-inbox (doctor): documents in ocr_ready or ocr_failed for their patients. */
export function useReviewInbox() {
  return useQuery<ReviewItem[], ApiRequestError>({
    queryKey: followKeys.inbox,
    queryFn: ({ signal }) => get('/review-inbox', {}, listOf(ReviewItem), signal),
    refetchInterval: 30_000,
  });
}

/** GET /documents/:id/drafts: OCR drafts, newest last. Never shown to the patient or the assistant. */
export function useDocumentDrafts(documentId: IdT | undefined) {
  return useQuery<OcrDraft[], ApiRequestError>({
    queryKey: followKeys.drafts(documentId ?? 'none'),
    queryFn: ({ signal }) => get(`/documents/${documentId}/drafts`, {}, listOf(OcrDraft), signal),
    enabled: documentId !== undefined,
  });
}

/** POST /documents/:id/retry-ocr */
export function useRetryOcr() {
  const qc = useQueryClient();
  return useMutation<DocumentMeta, ApiRequestError, { documentId: IdT; expectedVersion?: number }>({
    mutationFn: ({ documentId, expectedVersion }) =>
      apiFetch(`/documents/${documentId}/retry-ocr`, {
        method: 'POST',
        body: expectedVersion ? { expectedVersion } : {},
        schema: DocumentMeta,
      }),
    onSettled: () => void qc.invalidateQueries({ queryKey: followKeys.inbox }),
  });
}

/** POST /documents/:id/verify (doctor only): creates version 1, or supersedes when instructionId is given. */
export function useVerifyInstruction() {
  const qc = useQueryClient();
  return useMutation<InstructionVersion, ApiRequestError, { documentId: IdT; patientId: IdT } & VerifyInstructionRequest>({
    mutationFn: ({ documentId, patientId: _p, ...body }) =>
      apiFetch(`/documents/${documentId}/verify`, { method: 'POST', body, schema: InstructionVersion }),
    onSettled: (_d, _e, v) => {
      void qc.invalidateQueries({ queryKey: followKeys.inbox });
      void qc.invalidateQueries({ queryKey: followKeys.instructions(v.patientId) });
      void qc.invalidateQueries({ queryKey: ['documents'] });
    },
  });
}

/** GET /instructions?patientId=: current and superseded versions. Patients read their own. */
export function useInstructions(patientId: IdT | null | undefined) {
  return useQuery<InstructionVersion[], ApiRequestError>({
    queryKey: followKeys.instructions(patientId ?? 'none'),
    queryFn: ({ signal }) => get('/instructions', { patientId: patientId ?? undefined }, listOf(InstructionVersion), signal),
    enabled: Boolean(patientId),
  });
}

// ---------------------------------------------------------------------------
// Bounded assistant
// ---------------------------------------------------------------------------

/** POST /assistant/messages (patient, own context). */
export function useAskAssistant() {
  const qc = useQueryClient();
  return useMutation<AssistantAnswer, ApiRequestError, AskAssistantRequest>({
    mutationFn: (body) => apiFetch('/assistant/messages', { method: 'POST', body, schema: AssistantAnswer }),
    onSettled: (data) => {
      if (data) void qc.invalidateQueries({ queryKey: followKeys.conversation(data.conversationId) });
      void qc.invalidateQueries({ queryKey: followKeys.tasks });
    },
  });
}

/** GET /assistant/conversations/:id/messages */
export function useConversationMessages(conversationId: IdT | null) {
  return useQuery<ConversationMessage[], ApiRequestError>({
    queryKey: followKeys.conversation(conversationId ?? 'none'),
    queryFn: ({ signal }) => get(`/assistant/conversations/${conversationId}/messages`, {}, listOf(ConversationMessage), signal),
    enabled: conversationId !== null,
  });
}
