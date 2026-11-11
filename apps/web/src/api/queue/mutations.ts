import { useRef } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { z } from 'zod';
import type { MarkUnavailableRequest } from '@hqms/contracts';
import {
  CallNextResult,
  type PauseSessionRequest,
  type SetPriorityRequest,
} from '@hqms/contracts';
import { apiFetch, createKeyHolder, type ApiRequestError } from '@/lib/api';
import { queueKeys } from './queries';

/**
 * Doctor-console commands. Each one refetches the session snapshot when it settles, success or failure,
 * so a 409 (someone else acted first) shows the real state straight away. The SSE notice does the same for other viewers.
 */
function useRefreshSnapshot(sessionId: string) {
  const qc = useQueryClient();
  return () => qc.invalidateQueries({ queryKey: queueKeys.snapshot(sessionId) });
}

const sessionPath = (sessionId: string) => `/sessions/${encodeURIComponent(sessionId)}`;

/**
 * POST /sessions/{id}/call-next with an Idempotency-Key. The key is reused for a retry after a network failure
 * (so a lost response replays instead of calling a second patient) and replaced once the server has answered.
 */
export function useCallNext(sessionId: string) {
  const refresh = useRefreshSnapshot(sessionId);
  const holder = useRef(createKeyHolder());
  return useMutation<CallNextResult, ApiRequestError, undefined>({
    mutationFn: () =>
      apiFetch(`${sessionPath(sessionId)}/call-next`, {
        method: 'POST',
        body: {},
        idempotencyKey: holder.current.keyFor({ sessionId }),
        schema: CallNextResult,
      }),
    onSuccess: () => holder.current.release(),
    onError: (err) => {
      // A definitive server answer (not a dropped connection) ends this logical request.
      if (err.status > 0 && err.code !== 'NETWORK') holder.current.release();
    },
    onSettled: refresh,
  });
}

export interface VisitVars {
  visitId: string;
  expectedVersion?: number | undefined;
}

export function useStartVisit(sessionId: string) {
  const refresh = useRefreshSnapshot(sessionId);
  return useMutation<unknown, ApiRequestError, VisitVars>({
    mutationFn: ({ visitId, expectedVersion }) =>
      apiFetch(`/visits/${encodeURIComponent(visitId)}/start`, {
        method: 'POST',
        body: expectedVersion === undefined ? {} : { expectedVersion },
      }),
    onSettled: refresh,
  });
}

export function useCompleteVisit(sessionId: string) {
  const refresh = useRefreshSnapshot(sessionId);
  return useMutation<unknown, ApiRequestError, VisitVars>({
    mutationFn: ({ visitId, expectedVersion }) =>
      apiFetch(`/visits/${encodeURIComponent(visitId)}/complete`, {
        method: 'POST',
        body: expectedVersion === undefined ? {} : { expectedVersion },
      }),
    onSettled: refresh,
  });
}

export type EntryAction = 'skip' | 're-enter' | 'absent';

export interface EntryActionVars {
  entryId: string;
  action: EntryAction;
  reason?: string | undefined;
  expectedVersion?: number | undefined;
}

/** POST /queue-entries/{id}/skip | re-enter | absent. */
export function useEntryAction(sessionId: string) {
  const refresh = useRefreshSnapshot(sessionId);
  return useMutation<unknown, ApiRequestError, EntryActionVars>({
    mutationFn: ({ entryId, action, reason, expectedVersion }) => {
      const body: Record<string, unknown> = {};
      if (reason) body.reason = reason;
      if (expectedVersion !== undefined) body.expectedVersion = expectedVersion;
      return apiFetch(`/queue-entries/${encodeURIComponent(entryId)}/${action}`, { method: 'POST', body });
    },
    onSettled: refresh,
  });
}

export type SetPriorityVars = SetPriorityRequest & { entryId: string };

/** POST /queue-entries/{id}/priority (doctor only). priorityClass null clears the priority. */
export function useSetPriority(sessionId: string) {
  const refresh = useRefreshSnapshot(sessionId);
  return useMutation<unknown, ApiRequestError, SetPriorityVars>({
    mutationFn: ({ entryId, ...body }) =>
      apiFetch(`/queue-entries/${encodeURIComponent(entryId)}/priority`, { method: 'POST', body }),
    onSettled: refresh,
  });
}

export function usePauseSession(sessionId: string) {
  const refresh = useRefreshSnapshot(sessionId);
  return useMutation<unknown, ApiRequestError, PauseSessionRequest>({
    mutationFn: (body) => apiFetch(`${sessionPath(sessionId)}/pause`, { method: 'POST', body }),
    onSettled: refresh,
  });
}

export function useResumeSession(sessionId: string) {
  const refresh = useRefreshSnapshot(sessionId);
  return useMutation<unknown, ApiRequestError, undefined>({
    mutationFn: () => apiFetch(`${sessionPath(sessionId)}/resume`, { method: 'POST', body: {} }),
    onSettled: refresh,
  });
}

export function useMarkUnavailable(sessionId: string) {
  const refresh = useRefreshSnapshot(sessionId);
  return useMutation<unknown, ApiRequestError, z.infer<typeof MarkUnavailableRequest>>({
    mutationFn: (body) => apiFetch(`${sessionPath(sessionId)}/unavailable`, { method: 'POST', body }),
    onSettled: refresh,
  });
}
