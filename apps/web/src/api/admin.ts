import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AuditEvent,
  OperationsReport,
  QueuePolicy,
  Session,
  StaffMember,
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
