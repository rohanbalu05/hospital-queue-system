import { createContext, useCallback, useContext, useMemo, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Me, type LoginRequest, type Role } from '@hqms/contracts';
import { ApiRequestError, apiFetch } from './api';

export const ME_KEY = ['me'] as const;

export const ROLE_HOME: Record<Role, string> = {
  patient: '/patient',
  reception: '/reception',
  doctor: '/doctor',
  followup: '/follow-up',
  admin: '/admin',
};

export const ROLE_LABEL: Record<Role, string> = {
  patient: 'Patient',
  reception: 'Reception',
  doctor: 'Doctor',
  followup: 'Follow-up',
  admin: 'Admin',
};

export type AuthStatus = 'loading' | 'authenticated' | 'anonymous' | 'error';

interface AuthValue {
  status: AuthStatus;
  me: Me | null;
  error: ApiRequestError | null;
  refetch: () => void;
  login: (req: LoginRequest) => Promise<Me>;
  loginPending: boolean;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthValue | null>(null);

/** GET /me. A 401 means "not signed in" (null), not an error. */
async function fetchMe(signal?: AbortSignal): Promise<Me | null> {
  try {
    return await apiFetch('/me', { schema: Me, ...(signal ? { signal } : {}) });
  } catch (e) {
    if (e instanceof ApiRequestError && e.isUnauthenticated) return null;
    throw e;
  }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ME_KEY,
    queryFn: ({ signal }) => fetchMe(signal),
    staleTime: 60_000,
    retry: (count, err) => !(err instanceof ApiRequestError && err.status >= 400 && err.status < 500) && count < 1,
  });

  const loginMutation = useMutation<Me, ApiRequestError, LoginRequest>({
    mutationFn: (req) => apiFetch('/auth/login', { method: 'POST', body: req, schema: Me }),
    onSuccess: (me) => {
      qc.setQueryData(ME_KEY, me);
    },
  });
  const logoutMutation = useMutation<undefined, ApiRequestError>({
    mutationFn: () => apiFetch<undefined>('/auth/logout', { method: 'POST' }),
    onSettled: () => {
      // Whatever the server said, this browser no longer treats the user as signed in.
      qc.setQueryData(ME_KEY, null);
      qc.removeQueries({ predicate: (query) => query.queryKey[0] !== 'me' });
    },
  });

  const { mutateAsync: loginAsync } = loginMutation;
  const { mutateAsync: logoutAsync } = logoutMutation;
  const login = useCallback((req: LoginRequest) => loginAsync(req), [loginAsync]);
  const logout = useCallback(() => logoutAsync().catch(() => undefined), [logoutAsync]);
  const refetch = q.refetch;

  const value = useMemo<AuthValue>(() => {
    let status: AuthStatus;
    if (q.isPending) status = 'loading';
    else if (q.isError) status = 'error';
    else status = q.data ? 'authenticated' : 'anonymous';
    return {
      status,
      me: q.data ?? null,
      error: q.error instanceof ApiRequestError ? q.error : null,
      refetch: () => void refetch(),
      login,
      loginPending: loginMutation.isPending,
      logout,
    };
  }, [q.isPending, q.isError, q.data, q.error, refetch, login, loginMutation.isPending, logout]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>');
  return ctx;
}
