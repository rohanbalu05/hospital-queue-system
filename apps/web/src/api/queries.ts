import { useQuery } from '@tanstack/react-query';
import { SlotAvailability, type Session, type Doctor, type Id, type LocalDate } from '@hqms/contracts';
import type { ZodType, ZodTypeDef } from 'zod';
import { apiFetch, type ApiRequestError } from '@/lib/api';
import { AppointmentList, DoctorList, PatientList, SessionList, StaffAppointmentList } from './schemas';

type Params = Record<string, string | undefined>;

function withQuery(path: string, params: Params): string {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== '') qs.set(k, v);
  const q = qs.toString();
  return q ? `${path}?${q}` : path;
}

function get<O, I>(path: string, params: Params, schema: ZodType<O, ZodTypeDef, I>, signal: AbortSignal): Promise<O> {
  return apiFetch<O>(withQuery(path, params), { schema: schema as unknown as ZodType<O>, signal });
}

export const keys = {
  doctors: ['doctors'] as const,
  sessions: (p: SessionFilter) => ['sessions', p] as const,
  session: (id: Id) => ['session', id] as const,
  slots: (id: Id) => ['slots', id] as const,
  appointments: (p: AppointmentFilter) => ['appointments', p] as const,
  patients: (q: string) => ['patients', q] as const,
};

/** GET /doctors */
export function useDoctorsQuery() {
  return useQuery<Doctor[], ApiRequestError>({
    queryKey: keys.doctors,
    queryFn: ({ signal }) => get('/doctors', {}, DoctorList, signal),
    staleTime: 5 * 60_000,
  });
}

export interface SessionFilter {
  date?: LocalDate;
  from?: LocalDate;
  to?: LocalDate;
  doctorId?: Id;
  department?: string;
}

/** GET /sessions?date=&from=&to=&doctorId=&department= */
export function useSessionsQuery(filter: SessionFilter, options: { enabled?: boolean; refetchInterval?: number } = {}) {
  return useQuery<Session[], ApiRequestError>({
    queryKey: keys.sessions(filter),
    queryFn: ({ signal }) => get('/sessions', { ...filter }, SessionList, signal),
    enabled: options.enabled ?? true,
    ...(options.refetchInterval ? { refetchInterval: options.refetchInterval } : {}),
  });
}

/** GET /sessions/:id/slots, used for the "time assigned" line on the booking confirm step. */
export function useSlotsQuery(sessionId: Id | null) {
  return useQuery<SlotAvailability, ApiRequestError>({
    queryKey: keys.slots(sessionId ?? 'none'),
    queryFn: ({ signal }) => get(`/sessions/${sessionId}/slots`, {}, SlotAvailability, signal),
    enabled: sessionId !== null,
    staleTime: 0,
  });
}

export interface AppointmentFilter {
  patientId?: Id | undefined;
  sessionId?: Id | undefined;
}

/** GET /appointments?patientId=&sessionId= (patient screens: own only). */
export function useAppointmentsQuery(filter: AppointmentFilter, options: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: keys.appointments(filter),
    queryFn: ({ signal }) => get('/appointments', { ...filter }, AppointmentList, signal),
    enabled: options.enabled ?? true,
  });
}

/** GET /appointments?sessionId= for staff. Polls every 15 s until the live queue stream arrives in W2. */
export function useSessionAppointmentsQuery(sessionId: Id | null) {
  return useQuery({
    queryKey: keys.appointments({ sessionId: sessionId ?? 'none' }),
    queryFn: ({ signal }) => get('/appointments', { sessionId: sessionId ?? undefined }, StaffAppointmentList, signal),
    enabled: sessionId !== null,
    refetchInterval: 15_000,
  });
}

/** GET /patients?q= (staff). Only runs for two or more characters. */
export function usePatientSearchQuery(q: string) {
  const term = q.trim();
  return useQuery({
    queryKey: keys.patients(term),
    queryFn: ({ signal }) => get('/patients', { q: term }, PatientList, signal),
    enabled: term.length >= 2,
    staleTime: 10_000,
  });
}
