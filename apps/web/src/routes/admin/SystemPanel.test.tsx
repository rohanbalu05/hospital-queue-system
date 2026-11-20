import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import type { SystemStatus } from '@hqms/contracts';
import { stubApi, testQueryClient, type Handler } from '@/lib/testing';
import SystemPanel, { SYSTEM_REFRESH_MS, ageWords } from './SystemPanel';

afterEach(() => vi.unstubAllGlobals());

const fine: SystemStatus = {
  checkedAt: '2026-11-20T10:05:00+05:30',
  worker: {
    status: 'up',
    lastSeenAt: '2026-11-20T10:04:40+05:30',
    instances: [{ workerId: 'worker-1', jobTypes: ['ocr', 'notify'], dispatchOutbox: true, startedAt: '2026-11-20T08:00:00+05:30', lastSeenAt: '2026-11-20T10:04:40+05:30', up: true }],
  },
  jobs: { overdue: 0, oldestOverdueSeconds: null, running: 0, deadLast24h: 0, byType: [] },
  outbox: { undispatched: 0, oldestSeconds: null },
  notifications: { queued: 0, failedLast24h: 0 },
};

function mount(status: SystemStatus | 'fail' | 'hold') {
  const handler: Handler = (r) => {
    if (r.method !== 'GET' || r.path !== '/admin/system') return undefined;
    if (status === 'fail') return { status: 503, body: { error: { code: 'INTERNAL', message: 'down' } } };
    if (status === 'hold') return new Promise<never>(() => undefined) as never;
    return { body: status };
  };
  stubApi(handler);
  render(
    <QueryClientProvider client={testQueryClient()}>
      <MemoryRouter>
        <SystemPanel />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('ageWords', () => {
  it('says how long something has waited', () => {
    expect(ageWords(40)).toBe('40 s');
    expect(ageWords(60)).toBe('1 min');
    expect(ageWords(780)).toBe('13 min');
    expect(ageWords(3 * 3600 + 20 * 60)).toBe('3 h 20 min');
  });
});

describe('Background work panel', () => {
  it('refreshes every 30 seconds', () => {
    expect(SYSTEM_REFRESH_MS).toBe(30_000);
  });

  it('is calm when everything is fine: one line, no counts, no alert', async () => {
    mount(fine);
    const line = await screen.findByTestId('system-calm');
    const panel = screen.getByRole('region', { name: 'Background work' });
    expect(within(panel).getByText('Worker running')).toBeVisible();
    expect(line).toHaveTextContent('Last seen 10:04 am');
    expect(line).toHaveTextContent('Nothing is overdue, waiting or failed.');
    expect(within(panel).getByRole('link', { name: 'Notifications sent' })).toHaveAttribute('href', '/admin/notifications');
    expect(within(panel).queryByRole('alert')).toBeNull();
    expect(within(panel).queryByTestId('stat-overdue')).toBeNull();
  });

  it('is urgent when the worker is down, in words, with the last time it was seen', async () => {
    mount({ ...fine, worker: { ...fine.worker, status: 'down', lastSeenAt: '2026-11-20T09:12:00+05:30', instances: [] } });
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Worker stopped');
    expect(alert).toHaveTextContent('Timers, notifications and document reading are stopped. Start the worker.');
    expect(alert).toHaveTextContent('Last seen 9:12 am');
  });

  it('says so when no worker has ever reported', async () => {
    mount({ ...fine, worker: { status: 'down', lastSeenAt: null, instances: [] } });
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('No worker has reported yet.');
  });

  it('shows the backlog and links failed notifications to Notifications sent', async () => {
    mount({
      ...fine,
      jobs: { overdue: 4, oldestOverdueSeconds: 780, running: 1, deadLast24h: 2, byType: [{ jobType: 'ocr', overdue: 4, dead24h: 2 }] },
      outbox: { undispatched: 5, oldestSeconds: 95 },
      notifications: { queued: 3, failedLast24h: 1 },
    });
    await screen.findByTestId('stat-overdue');
    const panel = screen.getByRole('region', { name: 'Background work' });
    expect(within(panel).getByTestId('stat-overdue')).toHaveTextContent('4, oldest waiting 13 min');
    expect(within(panel).getByTestId('stat-dead')).toHaveTextContent('2');
    expect(within(panel).getByTestId('stat-outbox')).toHaveTextContent('5, oldest waiting 1 min');
    expect(within(panel).getByTestId('stat-notifications')).toHaveTextContent('3 queued, 1 failed');
    expect(within(panel).getByRole('link', { name: 'Notifications sent' })).toHaveAttribute('href', '/admin/notifications');
    // Worker is fine, so this is a notice, not an alarm.
    expect(within(panel).queryByRole('alert')).toBeNull();
  });

  it('shows a skeleton while loading and an error with a retry when the status cannot be read', async () => {
    mount('hold');
    expect(await screen.findByTestId('system-loading')).toBeVisible();
  });

  it('says what happened when the status cannot be loaded', async () => {
    mount('fail');
    expect(await screen.findByText('Background work status could not be loaded')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeVisible();
  });
});
