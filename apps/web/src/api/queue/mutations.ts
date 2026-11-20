import { useRef } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { z } from 'zod';
import type { MarkUnavailableRequest } from '@hqms/contracts';
import {
  CallNextResult,
  MoveAffectedResult,
  type MoveAffectedRequest,
  type StepAwayRequest,
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
  return () => {
    // The session lists (doctor picker, reception tabs) carry the session status too.
    void qc.invalidateQueries({ queryKey: ['queue', 'sessions'] });
    void qc.invalidateQueries({ queryKey: ['sessions'] });
    return qc.invalidateQueries({ queryKey: queueKeys.snapshot(sessionId) });
  };
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
  /** Re-enter only: reception confirms a late return (the API accepts it; the contract does not list it yet). */
  admitLate?: boolean | undefined;
}

/** POST /queue-entries/{id}/skip | re-enter | absent. */
export function useEntryAction(sessionId: string) {
  const refresh = useRefreshSnapshot(sessionId);
  return useMutation<unknown, ApiRequestError, EntryActionVars>({
    mutationFn: ({ entryId, action, reason, expectedVersion, admitLate }) => {
      const body: Record<string, unknown> = {};
      if (admitLate) body.admitLate = true;
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

/** Holds one Idempotency-Key per logical request and drops it once the server has answered (success or a definite error). */
function useCommandKey() {
  const holder = useRef(createKeyHolder());
  return {
    keyFor: (request: unknown) => holder.current.keyFor(request),
    settle: (err: ApiRequestError | null) => {
      if (err === null || (err.status > 0 && err.code !== 'NETWORK')) holder.current.release();
    },
  };
}

/** POST /sessions/{id}/pause: "Step away". Also used on an away session to change the expected return. */
export function useStepAway(sessionId: string) {
  const refresh = useRefreshSnapshot(sessionId);
  const key = useCommandKey();
  return useMutation<unknown, ApiRequestError, StepAwayRequest>({
    mutationFn: (body) =>
      apiFetch(`${sessionPath(sessionId)}/pause`, { method: 'POST', body, idempotencyKey: key.keyFor({ sessionId, body }) }),
    onSuccess: () => key.settle(null),
    onError: (err) => key.settle(err),
    onSettled: refresh,
  });
}

/** POST /sessions/{id}/resume: "I'm back". */
export function useImBack(sessionId: string) {
  const refresh = useRefreshSnapshot(sessionId);
  const key = useCommandKey();
  return useMutation<unknown, ApiRequestError, undefined>({
    mutationFn: () => apiFetch(`${sessionPath(sessionId)}/resume`, { method: 'POST', body: {}, idempotencyKey: key.keyFor({ sessionId }) }),
    onSuccess: () => key.settle(null),
    onError: (err) => key.settle(err),
    onSettled: refresh,
  });
}

/** POST /sessions/{id}/unavailable: for the rest of the session. One-way. */
export function useMarkUnavailable(sessionId: string) {
  const refresh = useRefreshSnapshot(sessionId);
  const key = useCommandKey();
  return useMutation<unknown, ApiRequestError, z.infer<typeof MarkUnavailableRequest>>({
    mutationFn: (body) =>
      apiFetch(`${sessionPath(sessionId)}/unavailable`, { method: 'POST', body, idempotencyKey: key.keyFor({ sessionId, body }) }),
    onSuccess: () => key.settle(null),
    onError: (err) => key.settle(err),
    onSettled: refresh,
  });
}

/**
 * POST /sessions/{id}/affected/move: reception moves the chosen patients to another doctor's session. Each patient is
 * its own transaction on the server, so the answer lists who moved and who was skipped (e.g. no place left).
 */
export function useMoveAffected(sessionId: string) {
  const qc = useQueryClient();
  const key = useCommandKey();
  return useMutation<MoveAffectedResult, ApiRequestError, MoveAffectedRequest>({
    mutationFn: (body) =>
      apiFetch(`${sessionPath(sessionId)}/affected/move`, {
        method: 'POST',
        body,
        idempotencyKey: key.keyFor({ sessionId, body }),
        schema: MoveAffectedResult,
      }),
    onSuccess: () => key.settle(null),
    onError: (err) => key.settle(err),
    onSettled: (result) => {
      void qc.invalidateQueries({ queryKey: queueKeys.affected(sessionId) });
      void qc.invalidateQueries({ queryKey: queueKeys.snapshot(sessionId) });
      if (result) void qc.invalidateQueries({ queryKey: queueKeys.snapshot(result.targetSessionId) });
      void qc.invalidateQueries({ queryKey: ['appointments'] });
      void qc.invalidateQueries({ queryKey: ['sessions'] });
    },
  });
}
