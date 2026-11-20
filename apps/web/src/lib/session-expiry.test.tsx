import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes } from 'react-router-dom';
import { RedirectIfSignedIn, RequireRole } from '@/components/layout/Guards';
import LoginPage from '@/routes/login/LoginPage';
import TodayPage from '@/routes/patient/TodayPage';
import { Providers, availableNow, patientUser, stubApi, testQueryClient, uuid } from '@/lib/testing';

afterEach(() => vi.unstubAllGlobals());
beforeAll(() => {
  Element.prototype.scrollIntoView = () => undefined;
});

const userA = patientUser(1, 'Ananya Iyer');
const userB = patientUser(2, 'Harish Gowda');

const visitFor = (doctor: string, token: string) => ({
  visitId: uuid(0x71),
  sessionId: uuid(0x5e1),
  appointmentId: null,
  doctorName: doctor,
  department: 'General Medicine',
  room: '12',
  kind: 'walkin',
  visitStatus: 'open',
  token,
  queueState: 'waiting',
  checkedInAt: new Date().toISOString(),
  scheduledAt: null,
  availability: availableNow,
});

function Tree() {
  return (
    <Routes>
      <Route
        path="/login"
        element={
          <RedirectIfSignedIn>
            <LoginPage />
          </RedirectIfSignedIn>
        }
      />
      <Route element={<RequireRole roles={['patient']} />}>
        <Route path="/patient" element={<TodayPage />} />
      </Route>
    </Routes>
  );
}

describe('account-scoped cache (B4 defect)', () => {
  it("never shows user A's visit to user B after A's session expired and B signed in in the same tab", async () => {
    let signedIn: typeof userA | null = userA;
    let expired = false;
    let releaseB: (() => void) | null = null;
    const unauthenticated = { status: 401, body: { error: { code: 'UNAUTHENTICATED', message: 'Sign in to continue.' } } };

    stubApi(({ method, path, body }) => {
      if (method === 'POST' && path === '/auth/login') {
        const email = (body as { email: string }).email;
        signedIn = email === userB.email ? userB : userA;
        expired = false;
        return { body: signedIn };
      }
      if (path === '/me') return expired || !signedIn ? unauthenticated : { body: signedIn };
      if (expired || !signedIn) return unauthenticated;
      if (path === '/appointments') return { body: [] };
      if (path === '/me/visits/today') {
        if (signedIn === userA) return { body: [visitFor('Dr. Alpha Rao', 'W-001')] };
        // B's visits arrive late: while they are in flight, nothing of A's may be on screen.
        return new Promise((resolve) => {
          releaseB = () => resolve({ body: [visitFor('Dr. Beta Kulkarni', 'W-002')] });
        });
      }
      return undefined;
    });

    const qc = testQueryClient();
    render(
      <Providers qc={qc} initial={['/patient']}>
        <Tree />
      </Providers>,
    );
    expect(await screen.findByText('Dr. Alpha Rao')).toBeInTheDocument();

    // A's session expires: the next request from any query is a 401.
    expired = true;
    await act(async () => {
      await qc.invalidateQueries({ queryKey: ['my-visits', 'today'] });
    });
    expect(await screen.findByText('Your session has ended, please sign in again')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Sign in' })).toBeInTheDocument();
    expect(screen.queryByText('Dr. Alpha Rao')).not.toBeInTheDocument();
    // Nothing of A's survives in the cache except the identity entry, which is now empty.
    const leftovers = qc
      .getQueryCache()
      .findAll()
      .filter((q) => !(q.queryKey[0] === 'me' && q.queryKey.length === 1 && !q.state.data));
    expect(leftovers.map((q) => q.queryKey)).toEqual([]);

    // B signs in, in the same tab.
    const user = userEvent.setup();
    await user.type(screen.getByLabelText('Email'), userB.email);
    await user.type(screen.getByLabelText('Password'), 'demo1234');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));

    await waitFor(() => expect(releaseB).not.toBeNull());
    expect(screen.queryByText('Dr. Alpha Rao')).not.toBeInTheDocument();
    expect(screen.queryByText('W-001')).not.toBeInTheDocument();
    await act(async () => releaseB?.());
    expect(await screen.findByText('Dr. Beta Kulkarni')).toBeInTheDocument();
    expect(screen.queryByText('Dr. Alpha Rao')).not.toBeInTheDocument();
  });

  it('does not tell a fresh visitor that a session has ended', async () => {
    stubApi(({ path }) => (path === '/me' ? { status: 401, body: { error: { code: 'UNAUTHENTICATED', message: 'Sign in.' } } } : undefined));
    render(
      <Providers qc={testQueryClient()} initial={['/login']}>
        <Tree />
      </Providers>,
    );
    expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeInTheDocument();
    expect(screen.queryByText('Your session has ended, please sign in again')).not.toBeInTheDocument();
  });
});
