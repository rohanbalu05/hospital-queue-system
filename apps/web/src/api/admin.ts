import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AuditEvent,
  NotificationDelivery,
  OperationsReport,
  QueuePolicy,
  Session,
  StaffMember,
  type DeliveryChannel,
  type DeliveryStatus,
  type Id as IdT,
  type LocalDate,
  type UpdateCapacityRequest,
} from '@hqms/contracts';
import { apiFetch, type ApiRequestError } from '@/lib/api';
import { get } from './queries';
import { listOf } from './schemas';

export const adminKeys = {
  policy: ['admin', 'policy'] as const,
  staff: ['admin', 'staff'] as const,
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
