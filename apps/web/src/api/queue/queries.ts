import { useQuery } from '@tanstack/react-query';
import { z } from 'zod';
import {
  DisplaySnapshot,
  Page,
  PatientQueueSnapshot,
  Session,
  StaffQueueSnapshot,
  type Session as SessionT,
} from '@hqms/contracts';
import { apiFetch } from '@/lib/api';

export const queueKeys = {
  all: ['queue'] as const,
  snapshot: (sessionId: string) => ['queue', 'snapshot', sessionId] as const,
  display: (date: string) => ['queue', 'display', date] as const,
  sessions: (date: string, doctorId: string | null) => ['queue', 'sessions', date, doctorId] as const,
};

/** GET /sessions/{id}/queue is role-scoped: staff get the full board, patients only their own entry. */
export const RoleQueueSnapshot = z.discriminatedUnion('view', [StaffQueueSnapshot, PatientQueueSnapshot]);
export type RoleQueueSnapshot = z.infer<typeof RoleQueueSnapshot>;

export function fetchQueueSnapshot(sessionId: string, signal?: AbortSignal): Promise<RoleQueueSnapshot> {
  return apiFetch(`/sessions/${encodeURIComponent(sessionId)}/queue`, {
    schema: RoleQueueSnapshot,
    ...(signal ? { signal } : {}),
  });
}

export function fetchDisplaySnapshot(date: string, signal?: AbortSignal): Promise<DisplaySnapshot> {
  return apiFetch(`/display/sessions?date=${encodeURIComponent(date)}`, {
    schema: DisplaySnapshot,
    ...(signal ? { signal } : {}),
  });
}

/** The list endpoint may answer with a bare array or a { items } page; both are accepted. */
const SessionList = z.union([z.array(Session), Page(Session)]);

export async function fetchDoctorSessions(date: string, doctorId: string | null, signal?: AbortSignal): Promise<SessionT[]> {
  const params = new URLSearchParams({ date });
  if (doctorId) params.set('doctorId', doctorId);
  const body = await apiFetch(`/sessions?${params.toString()}`, { schema: SessionList, ...(signal ? { signal } : {}) });
  return Array.isArray(body) ? body : body.items;
}

/** The signed-in doctor's sessions for one IST date, earliest first. */
export function useDoctorSessions(date: string, doctorId: string | null) {
  return useQuery({
    queryKey: queueKeys.sessions(date, doctorId),
    queryFn: async ({ signal }) => {
      const list = await fetchDoctorSessions(date, doctorId, signal);
      return [...list].sort((a, b) => a.startsAt.localeCompare(b.startsAt));
    },
    enabled: doctorId !== null,
    staleTime: 30_000,
  });
}
