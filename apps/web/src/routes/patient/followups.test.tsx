import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { Route, Routes } from 'react-router-dom';
import { RequireRole } from '@/components/layout/Guards';
import { Providers, patientUser, stubApi, testQueryClient, uuid } from '@/lib/testing';
import FollowUpsPage from './FollowUpsPage';

afterEach(() => vi.unstubAllGlobals());
beforeEach(() => {
  try {
    window.localStorage.clear();
  } catch {
    /* no storage */
  }
});

const me = patientUser(1, 'Ananya Iyer');

const task = (n: number, over: Record<string, unknown> = {}) => ({
  id: uuid(0x7a00 + n),
  kind: 'assistant_escalation',
  summary: 'Your question for the follow-up team',
  status: 'open',
  dueAt: '2026-11-12T10:00:00+05:30',
  disposition: null,
  returnAppointmentId: null,
  createdAt: '2026-11-11T10:00:00+05:30',
  resolvedAt: null,
  reply: null,
  repliedAt: null,
  ...over,
});

const REPLY = 'Please stop the new tablet tonight and bring the strip to the Paediatrics desk tomorrow at 9 am. Call 108 if the dizziness gets worse.';

function renderPage(list: unknown[]) {
  stubApi(({ path }) => (path === '/me' ? { body: me } : undefined), ({ path }) => (path === '/me/follow-ups' ? { body: list } : undefined));
  return render(
    <Providers qc={testQueryClient()} initial={['/patient/follow-ups']}>
      <Routes>
        <Route element={<RequireRole roles={['patient']} />}>
          <Route path="/patient/follow-ups" element={<FollowUpsPage />} />
        </Route>
      </Routes>
    </Providers>,
  );
}

describe('follow-ups show the care team reply (PR-14)', () => {
  it('shows a labelled reply block with the reply time in IST on a resolved item', async () => {
    renderPage([task(1, { status: 'resolved', disposition: 'advice_given', resolvedAt: '2026-11-11T14:10:00+05:30', reply: REPLY, repliedAt: '2026-11-11T14:10:00+05:30' })]);
    const block = await screen.findByTestId('care-team-reply');
    expect(within(block).getByText('Reply from the care team')).toBeVisible();
    expect(block).toHaveTextContent(REPLY);
    expect(block).toHaveTextContent('11 Nov, 2:10 pm');
  });

  it('marks a reply the patient has not seen, and stops marking it on the next visit', async () => {
    const list = [task(1, { status: 'resolved', resolvedAt: '2026-11-11T14:10:00+05:30', reply: REPLY, repliedAt: '2026-11-11T14:10:00+05:30' })];
    const first = renderPage(list);
    expect(await screen.findByTestId('new-reply-mark')).toHaveTextContent('New reply');
    expect(screen.getByRole('status')).toHaveTextContent('1 new reply from the care team');
    first.unmount();
    renderPage(list);
    await screen.findByTestId('care-team-reply');
    expect(screen.queryByTestId('new-reply-mark')).toBeNull();
  });

  it('lists urgent items first, labelled Urgent', async () => {
    renderPage([
      task(1, { dueAt: '2026-11-12T09:00:00+05:30', summary: 'Check-in after your visit', kind: 'post_visit' }),
      task(2, { dueAt: '2026-11-11T12:05:00+05:30', urgent: true }),
    ]);
    await screen.findByText('Check-in after your visit');
    const rows = Array.from(document.querySelectorAll('li[data-status]'));
    expect(rows[0]).toHaveTextContent('Urgent');
    expect(rows[0]).toHaveTextContent('Your question for the follow-up team');
    expect(rows[1]).not.toHaveTextContent('Urgent');
  });

  it('says nothing about a reply when there is none', async () => {
    renderPage([task(1)]);
    await screen.findByText('Waiting for the follow-up team');
    expect(screen.queryByTestId('care-team-reply')).toBeNull();
    expect(screen.queryByTestId('new-reply-mark')).toBeNull();
  });
});
