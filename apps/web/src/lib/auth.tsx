import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { Me, type LoginRequest, type Role } from '@hqms/contracts';
import { ApiRequestError, apiFetch, onSessionRejected } from './api';

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

export const SESSION_ENDED_MESSAGE = 'Your session has ended, please sign in again';

export type AuthStatus = 'loading' | 'authenticated' | 'anonymous' | 'error';

interface AuthValue {
  status: AuthStatus;
  me: Me | null;
  error: ApiRequestError | null;
  /** True after a signed-in session was rejected (401) or lost; cleared by the next sign-in. Never set by a plain sign-out. */
  sessionEnded: boolean;
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

/**
 * Every cache entry except the identity itself belongs to one account (appointments, visits, notifications, queue
 * snapshots, documents). Drop them all, and any request still in flight, whenever the account changes or ends, so one
 * user's data can never be shown to the next user of the same tab.
 */
export function clearAccountCache(qc: QueryClient): void {
  const accountScoped = { predicate: (q: { queryKey: readonly unknown[] }) => q.queryKey[0] !== ME_KEY[0] };
  void qc.cancelQueries(accountScoped);
  qc.removeQueries(accountScoped);
  qc.getMutationCache().clear();
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const [sessionEnded, setSessionEnded] = useState(false);
  /** Which user the cache currently holds data for: undefined = not known yet, null = nobody. */
  const cacheOwner = useRef<string | null | undefined>(undefined);

  const q = useQuery({
    queryKey: ME_KEY,
    queryFn: async ({ signal }) => {
      const me = await fetchMe(signal);
      const id = me?.userId ?? null;
      if (cacheOwner.current !== undefined && cacheOwner.current !== id) {
        // The cookie now belongs to someone else, or to nobody (e.g. signed out or expired in another tab).
        clearAccountCache(qc);
        if (id === null) setSessionEnded(true);
      }
      cacheOwner.current = id;
      return me;
    },
    staleTime: 60_000,
    retry: (count, err) => !(err instanceof ApiRequestError && err.status >= 400 && err.status < 500) && count < 1,
  });

  // Any other request answering 401 means the session ended: clear every account-scoped entry and go back to login.
  useEffect(
    () =>
      onSessionRejected(() => {
        if (!qc.getQueryData(ME_KEY)) return;
        clearAccountCache(qc);
        cacheOwner.current = null;
        qc.setQueryData(ME_KEY, null);
        setSessionEnded(true);
      }),
    [qc],
  );

  const loginMutation = useMutation<Me, ApiRequestError, LoginRequest>({
    mutationFn: (req) => apiFetch('/auth/login', { method: 'POST', body: req, schema: Me }),
    onSuccess: (me) => {
      // Nothing cached before this sign-in belongs to this user.
      clearAccountCache(qc);
      cacheOwner.current = me.userId;
      setSessionEnded(false);
      qc.setQueryData(ME_KEY, me);
    },
  });
  const logoutMutation = useMutation<undefined, ApiRequestError>({
    mutationFn: () => apiFetch<undefined>('/auth/logout', { method: 'POST' }),
    onSettled: () => {
      // Whatever the server said, this browser no longer treats the user as signed in.
      clearAccountCache(qc);
      cacheOwner.current = null;
      setSessionEnded(false);
      qc.setQueryData(ME_KEY, null);
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
      sessionEnded,
      refetch: () => void refetch(),
      login,
      loginPending: loginMutation.isPending,
      logout,
    };
  }, [q.isPending, q.isError, q.data, q.error, sessionEnded, refetch, login, loginMutation.isPending, logout]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>');
  return ctx;
}
