import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AuditEvent,
  NotificationDelivery,
  OperationsReport,
  QueuePolicy,
  Session,
  StaffCredentials,
  StaffMember,
  SystemStatus,
  type CreateSessionRequest,
  type CreateStaffRequest,
  type DeliveryChannel,
  type DeliveryStatus,
  type Id as IdT,
  type LocalDate,
  type UpdateCapacityRequest,
} from '@hqms/contracts';
import { apiFetch, useIdempotentMutation, type ApiRequestError } from '@/lib/api';
import { get } from './queries';
import { listOf } from './schemas';

export const adminKeys = {
  policy: ['admin', 'policy'] as const,
  staff: ['admin', 'staff'] as const,
  system: ['admin', 'system'] as const,
  report: (from: string, to: string) => ['admin', 'report', from, to] as const,
  audit: (p: AuditFilter) => ['admin', 'audit', p] as const,
  notifications: (p: NotificationLogFilter) => ['admin', 'notifications', p] as const,
};

/** GET /policies/current (read-only Table 7 values). */
export function useCurrentPolicy() {
  return useQuery<QueuePolicy, ApiRequestError>({
    queryKey: adminKeys.policy,
    queryFn: ({ signal }) => apiFetch('/policies/current', { schema: QueuePolicy, signal }),
    staleTime: 5 * 60_000,
  });
}

/** GET /reports/operations?from=&to= */
export function useOperationsReport(from: LocalDate, to: LocalDate) {
  return useQuery<OperationsReport, ApiRequestError>({
    queryKey: adminKeys.report(from, to),
    queryFn: ({ signal }) => get('/reports/operations', { from, to }, OperationsReport, signal),
  });
}

export interface AuditFilter {
  entityType?: string | undefined;
  entityId?: IdT | undefined;
}

/** GET /audit?entityType=&entityId= */
export function useAuditEvents(filter: AuditFilter) {
  return useQuery<AuditEvent[], ApiRequestError>({
    queryKey: adminKeys.audit(filter),
    queryFn: ({ signal }) => get('/audit', { ...filter, limit: '100' }, listOf(AuditEvent), signal),
  });
}

/** PATCH /sessions/:id/capacity. 409 INVALID_CAPACITY_REDUCTION when below what is already used. */
export function useUpdateCapacity() {
  const qc = useQueryClient();
  return useMutation<Session, ApiRequestError, { sessionId: IdT } & UpdateCapacityRequest>({
    mutationFn: ({ sessionId, ...body }) => apiFetch(`/sessions/${sessionId}/capacity`, { method: 'PATCH', body, schema: Session }),
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: ['sessions'] });
      void qc.invalidateQueries({ queryKey: ['admin', 'audit'] });
    },
  });
}

/** GET /admin/staff */
export function useStaffDirectory() {
  return useQuery<StaffMember[], ApiRequestError>({
    queryKey: adminKeys.staff,
    queryFn: ({ signal }) => get('/admin/staff', {}, listOf(StaffMember), signal),
  });
}

/** PUT /admin/staff/:userId/assignments */
export function useSetAssignments() {
  const qc = useQueryClient();
  return useMutation<unknown, ApiRequestError, { userId: IdT; doctorIds: IdT[] }>({
    mutationFn: ({ userId, doctorIds }) => apiFetch(`/admin/staff/${userId}/assignments`, { method: 'PUT', body: { doctorIds } }),
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: adminKeys.staff });
      void qc.invalidateQueries({ queryKey: ['admin', 'audit'] });
    },
  });
}

export interface NotificationLogFilter {
  channel?: DeliveryChannel | undefined;
  status?: DeliveryStatus | undefined;
  sessionId?: IdT | undefined;
  limit?: number | undefined;
}

/** GET /admin/notifications?limit=&channel=&status=&sessionId= : the "Notifications sent" log (addresses are masked by the API). */
export function useNotificationLog(filter: NotificationLogFilter) {
  return useQuery<NotificationDelivery[], ApiRequestError>({
    queryKey: adminKeys.notifications(filter),
    queryFn: ({ signal }) =>
      get(
        '/admin/notifications',
        {
          limit: String(filter.limit ?? 100),
          ...(filter.channel ? { channel: filter.channel } : {}),
          ...(filter.status ? { status: filter.status } : {}),
          ...(filter.sessionId ? { sessionId: filter.sessionId } : {}),
        },
        listOf(NotificationDelivery),
        signal,
      ),
    // New messages and retries land all day: look again every 20 s while the page is open.
    refetchInterval: 20_000,
  });
}

/** How often the Background work panel looks again while an admin page is open. */
export const SYSTEM_REFRESH_MS = 30_000;

/** GET /admin/system: worker heartbeat, job backlog, undispatched outbox, queued and failed notifications. */
export function useSystemStatus() {
  return useQuery<SystemStatus, ApiRequestError>({
    queryKey: adminKeys.system,
    queryFn: ({ signal }) => get('/admin/system', {}, SystemStatus, signal),
    refetchInterval: SYSTEM_REFRESH_MS,
  });
}

function useInvalidateSessions() {
  const qc = useQueryClient();
  return () =>
    Promise.all([
      qc.invalidateQueries({ queryKey: ['sessions'] }),
      qc.invalidateQueries({ queryKey: ['admin', 'audit'] }),
    ]);
}

/** POST /sessions (admin; Idempotency-Key). 409 CONFLICT with details SessionOverlap when it overlaps the doctor's other session. */
export function useCreateSession() {
  const invalidate = useInvalidateSessions();
  return useIdempotentMutation<Session, CreateSessionRequest>(
    (body, key) => apiFetch('/sessions', { method: 'POST', body, idempotencyKey: key, schema: Session }),
    { onSettled: () => void invalidate() },
  );
}

export type SessionCommand = 'open' | 'close';

/** POST /sessions/:id/open | /close (Idempotency-Key, empty body). */
export function useSessionCommand() {
  const invalidate = useInvalidateSessions();
  return useIdempotentMutation<Session, { sessionId: IdT; command: SessionCommand }>(
    ({ sessionId, command }, key) => apiFetch(`/sessions/${sessionId}/${command}`, { method: 'POST', body: {}, idempotencyKey: key, schema: Session }),
    { onSettled: () => void invalidate() },
  );
}

/** POST /sessions/:id/reopen (admin; reason required): undo "unavailable" while the session has not ended. */
export function useReopenSession() {
  const invalidate = useInvalidateSessions();
  return useIdempotentMutation<Session, { sessionId: IdT; reason: string }>(
    ({ sessionId, reason }, key) => apiFetch(`/sessions/${sessionId}/reopen`, { method: 'POST', body: { reason }, idempotencyKey: key, schema: Session }),
    { onSettled: () => void invalidate() },
  );
}

function useInvalidateStaff() {
  const qc = useQueryClient();
  return () =>
    Promise.all([
      qc.invalidateQueries({ queryKey: adminKeys.staff }),
      qc.invalidateQueries({ queryKey: ['doctors'] }),
      qc.invalidateQueries({ queryKey: ['admin', 'audit'] }),
    ]);
}

/** POST /admin/staff (Idempotency-Key). The response carries the one-time temporary password. */
export function useCreateStaff() {
  const invalidate = useInvalidateStaff();
  return useIdempotentMutation<StaffCredentials, CreateStaffRequest>(
    (body, key) => apiFetch('/admin/staff', { method: 'POST', body, idempotencyKey: key, schema: StaffCredentials }),
    { onSettled: () => void invalidate() },
  );
}

/** POST /admin/staff/:id/deactivate | /activate ({reason}) -> StaffMember. */
export function useSetStaffActive() {
  const invalidate = useInvalidateStaff();
  return useIdempotentMutation<StaffMember, { userId: IdT; active: boolean; reason: string }>(
    ({ userId, active, reason }, key) =>
      apiFetch(`/admin/staff/${userId}/${active ? 'activate' : 'deactivate'}`, { method: 'POST', body: { reason }, idempotencyKey: key, schema: StaffMember }),
    { onSettled: () => void invalidate() },
  );
}

/** POST /admin/staff/:id/reset-password ({reason}) -> StaffCredentials (one-time temporary password). */
export function useResetPassword() {
  const invalidate = useInvalidateStaff();
  return useIdempotentMutation<StaffCredentials, { userId: IdT; reason: string }>(
    ({ userId, reason }, key) =>
      apiFetch(`/admin/staff/${userId}/reset-password`, { method: 'POST', body: { reason }, idempotencyKey: key, schema: StaffCredentials }),
    { onSettled: () => void invalidate() },
  );
}
