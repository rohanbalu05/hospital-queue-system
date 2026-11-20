import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AlternativeSession,
  Appointment,
  FollowUpTask,
  Patient,
  type CreateFollowUpTaskRequest,
  type Id,
  type RegisterPatientRequest,
} from '@hqms/contracts';
import { apiFetch, useIdempotentMutation, type ApiRequestError } from '@/lib/api';
import { get } from '../queries';
import { listOf } from '../schemas';

/**
 * Desk and doctor commands added in session 3 (PR-21, PR-22, PR-23, PR-32). Every POST sends an Idempotency-Key.
 * A retry of the same request (compared by its JSON) reuses the key, so a lost response replays instead of repeating.
 */

const AlternativeList = listOf(AlternativeSession);

export const deskKeys = {
  alternatives: (sessionId: Id) => ['session-alternatives', sessionId] as const,
};

/**
 * GET /sessions/{id}/alternatives (reception, admin): today's sessions of other doctors in the same department with a
 * free place. Only asked for when this session's walk-in places are full or the doctor is unavailable.
 */
export function useSessionAlternatives(sessionId: Id | null, enabled: boolean) {
  return useQuery<AlternativeSession[], ApiRequestError>({
    queryKey: deskKeys.alternatives(sessionId ?? 'none'),
    queryFn: ({ signal }) => get(`/sessions/${sessionId}/alternatives`, {}, AlternativeList, signal),
    enabled: enabled && sessionId !== null,
    staleTime: 0,
    refetchInterval: 20_000,
  });
}

function useInvalidateDesk() {
  const qc = useQueryClient();
  return () =>
    Promise.all([
      qc.invalidateQueries({ queryKey: ['appointments'] }),
      qc.invalidateQueries({ queryKey: ['sessions'] }),
      qc.invalidateQueries({ queryKey: ['slots'] }),
      qc.invalidateQueries({ queryKey: ['alternatives'] }),
      qc.invalidateQueries({ queryKey: ['session-alternatives'] }),
      qc.invalidateQueries({ queryKey: ['queue'] }),
    ]);
}

/** POST /appointments {sessionId, patientId}: reception books for a patient (the server assigns the next free slot). */
export function useBookForPatient() {
  const invalidate = useInvalidateDesk();
  return useIdempotentMutation<Appointment, { sessionId: Id; patientId: Id }>(
    (vars, key) =>
      apiFetch('/appointments', {
        method: 'POST',
        body: { sessionId: vars.sessionId, patientId: vars.patientId },
        idempotencyKey: key,
        schema: Appointment,
      }),
    { onSettled: () => void invalidate() },
  );
}

/** POST /appointments/{id}/cancel with an optional reason. */
export function useCancelForPatient() {
  const invalidate = useInvalidateDesk();
  return useIdempotentMutation<Appointment, { appointmentId: Id; reason?: string; expectedVersion?: number }>(
    (vars, key) =>
      apiFetch(`/appointments/${vars.appointmentId}/cancel`, {
        method: 'POST',
        body: {
          ...(vars.reason ? { reason: vars.reason } : {}),
          ...(vars.expectedVersion !== undefined ? { expectedVersion: vars.expectedVersion } : {}),
        },
        idempotencyKey: key,
        schema: Appointment,
      }),
    { onSettled: () => void invalidate() },
  );
}

/** POST /patients (reception-assisted registration). confirmNew is part of the body, so it gets its own key. */
export function useRegisterPatientDesk() {
  return useIdempotentMutation<Patient, RegisterPatientRequest>((body, key) =>
    apiFetch('/patients', { method: 'POST', body, idempotencyKey: key, schema: Patient }),
  );
}

/** POST /follow-up-tasks (doctor). The task joins the follow-up team's inbox. */
export function useCreateFollowUpTask() {
  const qc = useQueryClient();
  return useIdempotentMutation<FollowUpTask, CreateFollowUpTaskRequest>(
    (body, key) => apiFetch('/follow-up-tasks', { method: 'POST', body, idempotencyKey: key, schema: FollowUpTask }),
    { onSettled: () => void qc.invalidateQueries({ queryKey: ['followups'] }) },
  );
}
