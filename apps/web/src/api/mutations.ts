import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Appointment, ArrivalResult, Patient, type Id, type RegisterPatientRequest } from '@hqms/contracts';
import { apiFetch, useIdempotentMutation, type ApiRequestError } from '@/lib/api';

/** Anything that changes capacity or arrivals makes these lists stale. */
function useInvalidateScheduling() {
  const qc = useQueryClient();
  return () =>
    Promise.all([
      qc.invalidateQueries({ queryKey: ['appointments'] }),
      qc.invalidateQueries({ queryKey: ['sessions'] }),
      qc.invalidateQueries({ queryKey: ['slots'] }),
    ]);
}

/** POST /appointments (Idempotency-Key). A retry with the same session reuses the key. */
export function useBookAppointment() {
  const invalidate = useInvalidateScheduling();
  return useIdempotentMutation<Appointment, { sessionId: Id }>(
    (vars, key) =>
      apiFetch('/appointments', { method: 'POST', body: { sessionId: vars.sessionId }, idempotencyKey: key, schema: Appointment }),
    { onSettled: () => void invalidate() },
  );
}

/** POST /appointments/:id/cancel */
export function useCancelAppointment() {
  const invalidate = useInvalidateScheduling();
  return useMutation<Appointment, ApiRequestError, { appointmentId: Id; reason?: string }>({
    mutationFn: ({ appointmentId, reason }) =>
      apiFetch(`/appointments/${appointmentId}/cancel`, {
        method: 'POST',
        body: reason ? { reason } : {},
        schema: Appointment,
      }),
    onSettled: () => void invalidate(),
  });
}

/** POST /appointments/:id/reschedule (Idempotency-Key). */
export function useRescheduleAppointment() {
  const invalidate = useInvalidateScheduling();
  return useIdempotentMutation<Appointment, { appointmentId: Id; targetSessionId: Id }>(
    (vars, key) =>
      apiFetch(`/appointments/${vars.appointmentId}/reschedule`, {
        method: 'POST',
        body: { targetSessionId: vars.targetSessionId },
        idempotencyKey: key,
        schema: Appointment,
      }),
    { onSettled: () => void invalidate() },
  );
}

/** POST /appointments/:id/check-in (Idempotency-Key). admitLate changes the body, so it gets a new key. */
export function useCheckIn() {
  const invalidate = useInvalidateScheduling();
  return useIdempotentMutation<ArrivalResult, { appointmentId: Id; admitLate?: boolean }>(
    (vars, key) =>
      apiFetch(`/appointments/${vars.appointmentId}/check-in`, {
        method: 'POST',
        body: vars.admitLate ? { admitLate: true } : {},
        idempotencyKey: key,
        schema: ArrivalResult,
      }),
    { onSettled: () => void invalidate() },
  );
}

/** POST /sessions/:id/walk-ins (Idempotency-Key). */
export function useAdmitWalkIn() {
  const invalidate = useInvalidateScheduling();
  return useIdempotentMutation<ArrivalResult, { sessionId: Id; patientId: Id }>(
    (vars, key) =>
      apiFetch(`/sessions/${vars.sessionId}/walk-ins`, {
        method: 'POST',
        body: { patientId: vars.patientId },
        idempotencyKey: key,
        schema: ArrivalResult,
      }),
    { onSettled: () => void invalidate() },
  );
}

/** POST /patients (reception-assisted registration). */
export function useRegisterPatient() {
  return useMutation<Patient, ApiRequestError, RegisterPatientRequest>({
    mutationFn: (body) => apiFetch('/patients', { method: 'POST', body, schema: Patient }),
  });
}
