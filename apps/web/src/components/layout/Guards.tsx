import type { ReactNode } from 'react';
import { Navigate, Outlet, useLocation } from 'react-router-dom';
import type { Role } from '@hqms/contracts';
import { ErrorState, SkeletonRows } from '@/components/queue';
import { ROLE_HOME, useAuth } from '@/lib/auth';

function FullScreen({ children }: { children: ReactNode }) {
  return (
    <div className="mx-auto min-h-dvh max-w-2xl bg-paper px-4 py-10" aria-live="polite">
      {children}
    </div>
  );
}

/** Shown while GET /me is in flight or has failed. Skeleton rows, not a full-page spinner. */
function AuthGate({ children }: { children: ReactNode }) {
  const { status, error, refetch } = useAuth();
  if (status === 'loading') {
    return (
      <FullScreen>
        <SkeletonRows count={5} />
      </FullScreen>
    );
  }
  if (status === 'error') {
    return (
      <FullScreen>
        <ErrorState
          title="Could not check your sign-in"
          error={error}
          hint="The server did not answer. Check the connection, then try again."
          onRetry={refetch}
        />
      </FullScreen>
    );
  }
  return <>{children}</>;
}

/** "/" sends people to login or their role home. */
export function RootRedirect() {
  return (
    <AuthGate>
      <RootTarget />
    </AuthGate>
  );
}

function RootTarget() {
  const { me } = useAuth();
  return <Navigate to={me ? ROLE_HOME[me.role] : '/login'} replace />;
}

/** Requires a signed-in user with one of `roles`; otherwise login (401) or the user's own home. */
export function RequireRole({ roles }: { roles: readonly Role[] }) {
  const location = useLocation();
  return (
    <AuthGate>
      <RoleCheck roles={roles} from={location.pathname} />
    </AuthGate>
  );
}

function RoleCheck({ roles, from }: { roles: readonly Role[]; from: string }) {
  const { me } = useAuth();
  if (!me) return <Navigate to="/login" replace state={{ from }} />;
  if (!roles.includes(me.role)) return <Navigate to={ROLE_HOME[me.role]} replace />;
  return <Outlet />;
}

/** Login page wrapper: already signed in? go home. Never blocks the form on a slow /me. */
export function RedirectIfSignedIn({ children }: { children: ReactNode }) {
  const { me } = useAuth();
  if (me) return <Navigate to={ROLE_HOME[me.role]} replace />;
  return <>{children}</>;
}
