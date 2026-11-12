import { lazy, Suspense } from 'react';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Toaster } from '@/components/ui/sonner';
import { TooltipProvider } from '@/components/ui/tooltip';
import { RedirectIfSignedIn, RequireRole, RootRedirect } from '@/components/layout/Guards';
import { ApiRequestError } from '@/lib/api';
import { AuthProvider } from '@/lib/auth';
import { DEV_ROUTES } from '@/lib/config';
import LoginPage from '@/routes/login/LoginPage';
import PatientHome from '@/routes/patient/PatientHome';
import ReceptionHome from '@/routes/reception/ReceptionHome';
import DoctorHome from '@/routes/doctor/DoctorHome';
import FollowUpHome from '@/routes/follow-up/FollowUpHome';
import AdminHome from '@/routes/admin/AdminHome';
import DisplayPage from '@/routes/display/DisplayPage';
import MyVisitPage from '@/routes/patient/visit/MyVisitPage';

const PrimitivesGallery = DEV_ROUTES ? lazy(() => import('@/routes/dev/Primitives')) : null;
const BoardDevPage = DEV_ROUTES ? lazy(() => import('@/live/BoardDevPage')) : null;

export function createQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 5_000,
        refetchOnWindowFocus: true,
        retry: (count, err) => !(err instanceof ApiRequestError && err.status >= 400 && err.status < 500) && count < 2,
      },
    },
  });
}

const queryClient = createQueryClient();

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider delayDuration={200}>
        <BrowserRouter>
          <AuthProvider>
            <Routes>
              <Route path="/" element={<RootRedirect />} />
              <Route
                path="/login"
                element={
                  <RedirectIfSignedIn>
                    <LoginPage />
                  </RedirectIfSignedIn>
                }
              />
              <Route element={<RequireRole roles={['patient']} />}>
                <Route path="/patient/visit/:sessionId" element={<MyVisitPage />} />
                <Route path="/patient/*" element={<PatientHome />} />
              </Route>
              <Route element={<RequireRole roles={['reception']} />}>
                <Route path="/reception/*" element={<ReceptionHome />} />
              </Route>
              <Route element={<RequireRole roles={['doctor']} />}>
                <Route path="/doctor/*" element={<DoctorHome />} />
              </Route>
              <Route element={<RequireRole roles={['followup']} />}>
                <Route path="/follow-up/*" element={<FollowUpHome />} />
              </Route>
              <Route element={<RequireRole roles={['admin']} />}>
                <Route path="/admin/*" element={<AdminHome />} />
              </Route>
              {/* Public waiting-room display: no auth, tokens only. */}
              <Route path="/display" element={<DisplayPage />} />
              {PrimitivesGallery ? (
                <Route
                  path="/_dev/primitives"
                  element={
                    <Suspense fallback={null}>
                      <PrimitivesGallery />
                    </Suspense>
                  }
                />
              ) : null}
              {BoardDevPage ? (
                <Route
                  path="/_dev/board"
                  element={
                    <Suspense fallback={null}>
                      <BoardDevPage />
                    </Suspense>
                  }
                />
              ) : null}
              <Route path="*" element={<Navigate to="/" replace />} />
            </Routes>
          </AuthProvider>
        </BrowserRouter>
        <Toaster position="bottom-right" />
      </TooltipProvider>
    </QueryClientProvider>
  );
}
