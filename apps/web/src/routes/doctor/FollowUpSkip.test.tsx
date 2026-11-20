/* eslint-disable @typescript-eslint/no-non-null-assertion -- fixtures index arrays this file just built */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { AuthProvider } from '@/lib/auth';
import { toast } from 'sonner';
import { addDays } from '@/lib/dates';
import { FakeEventSource } from '@/live/fakeEventSource';
import { decision, entry, staffSnapshot, uid } from '@/live/fixtures';
import { DOC_RAO, TODAY, makeSession } from '../reception/deskKit';
import { SessionConsole } from './components/SessionConsole';

/**
 * PR-32: the doctor creates a follow-up task for the patient with them, and for the one just completed (kept on screen
 * until the next call). PR-35: Skip asks for confirmation first.
 */

vi.mock('sonner', () => ({ toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), info: vi.fn() }), Toaster: () => null }));

beforeAll(() => {
  Element.prototype.hasPointerCapture = () => false;
  Element.prototype.setPointerCapture = () => undefined;
  Element.prototype.releasePointerCapture = () => undefined;
  Element.prototype.scrollIntoView = () => undefined;
});

const session = makeSession(1, DOC_RAO);
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

interface State {
  active: ReturnType<typeof entry> | null;
  waiting: Array<ReturnType<typeof entry>>;
  completed: number;
}
let state: State;
let failFollowUp = false;
let posts: Array<{ path: string; body: Record<string, unknown>; key: string | null }>;

const task = (body: Record<string, unknown>) => ({
  id: uid(0x7a51),
  patientId: body.patientId,
  patientName: 'Ananya Iyer',
  sourceVisitId: body.sourceVisitId ?? null,
  sourceMessageId: null,
  overdue: false,
  kind: body.kind,
  title: body.title,
  detail: body.detail ?? null,
  ownerId: null,
  ownerName: null,
  status: 'open',
  dueAt: body.dueAt,
  acknowledgedAt: null,
  disposition: null,
  outcomeNote: null,
  resolvedAt: null,
  returnAppointmentId: null,
  version: 1,
  createdAt: new Date().toISOString(),
});

beforeEach(() => {
  FakeEventSource.reset();
  vi.stubGlobal('EventSource', FakeEventSource);
  // Radix radios inside a <form> measure their hidden input.
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  posts = [];
  failFollowUp = false;
  state = { active: entry(14, { state: 'in_service', calledAt: '2026-11-11T04:42:00.000Z', patientName: 'Ananya Iyer' }), waiting: [entry(15, { patientName: 'Harish Gowda' })], completed: 3 };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), 'http://localhost');
      const path = url.pathname.replace(/^\/api/, '');
      const method = init?.method ?? 'GET';
      const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : {};
      if (method === 'POST') posts.push({ path, body, key: new Headers(init?.headers).get('Idempotency-Key') });
      if (path === '/me') return json({ userId: uid(3), email: 'doctor@hqms.test', displayName: 'Dr. Meenakshi Rao', role: 'doctor', patientId: null, doctorId: DOC_RAO.id, assignedDoctorIds: [DOC_RAO.id] });
      if (path === `/sessions/${session.id}/queue`) {
        return json(staffSnapshot({ sessionId: session.id, active: state.active, waiting: state.waiting, completedCount: state.completed, lastDecision: decision() }));
      }
      if (method === 'POST' && /\/visits\/[^/]+\/complete$/.test(path)) {
        state.active = null;
        state.completed += 1;
        return json({});
      }
      if (method === 'POST' && /\/queue-entries\/[^/]+\/skip$/.test(path)) {
        state.active = null;
        return json({});
      }
      if (method === 'POST' && path === `/sessions/${session.id}/call-next`) {
        const next = state.waiting.shift()!;
        state.active = { ...next, state: 'called', calledAt: new Date().toISOString() };
        return json({ decision: decision({ token: next.token }), entry: state.active });
      }
      if (method === 'POST' && path === '/follow-up-tasks') {
        if (failFollowUp) return json({ error: { code: 'VALIDATION_FAILED', message: 'The due time must be in the future.' } }, 422);
        return json(task(body), 201);
      }
      return json({ error: { code: 'NOT_FOUND', message: 'Not mocked.' } }, 404);
    }),
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

function renderConsole() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <AuthProvider>
          <SessionConsole session={session as never} picker={null} />
        </AuthProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const istFivePm = (days: number) => new Date(`${addDays(TODAY, days)}T17:00:00+05:30`).toISOString();

describe('doctor: Create follow-up (PR-32)', () => {
  it('creates a follow-up task for the patient in service from a preset and a due interval', async () => {
    const user = userEvent.setup();
    renderConsole();
    await user.click(await screen.findByRole('button', { name: 'Create follow-up' }));
    const dialog = await screen.findByRole('dialog', { name: /Create follow-up for Ananya Iyer/ });
    await user.click(within(dialog).getByRole('radio', { name: 'Check medication response' }));
    await user.type(within(dialog).getByLabelText('Detail (optional)'), 'Repeat BP reading, ask about dizziness');
    await user.click(within(dialog).getByRole('combobox', { name: 'Due in' }));
    await user.click(await screen.findByRole('option', { name: '7 days' }));
    await user.click(within(dialog).getByRole('button', { name: 'Create follow-up' }));

    await waitFor(() => expect(posts.filter((p) => p.path === '/follow-up-tasks')).toHaveLength(1));
    const sent = posts.find((p) => p.path === '/follow-up-tasks')!;
    expect(sent.body).toEqual({
      patientId: state.active!.patientId,
      sourceVisitId: state.active!.visitId,
      kind: 'post_visit',
      title: 'Check medication response',
      detail: 'Repeat BP reading, ask about dizziness',
      dueAt: istFivePm(7),
    });
    expect(sent.key).toBeTruthy();
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Follow-up created', expect.anything()));
    // Confirmation stays in the panel, with no link to anywhere.
    const confirmation = await screen.findByTestId('followup-confirmation');
    expect(confirmation).toHaveTextContent('Check medication response');
    expect(within(confirmation).queryByRole('link')).toBeNull();
  });

  it('accepts a custom title and a chosen date, and asks for a title first', async () => {
    const user = userEvent.setup();
    renderConsole();
    await user.click(await screen.findByRole('button', { name: 'Create follow-up' }));
    const dialog = await screen.findByRole('dialog', { name: /Create follow-up for/ });
    await user.click(within(dialog).getByRole('radio', { name: 'Something else' }));
    await user.click(within(dialog).getByRole('button', { name: 'Create follow-up' }));
    expect(await within(dialog).findByText(/Enter a title of at least 3 letters/)).toBeVisible();
    expect(posts.filter((p) => p.path === '/follow-up-tasks')).toHaveLength(0);

    await user.type(within(dialog).getByLabelText('Title'), 'Review knee X-ray');
    await user.click(within(dialog).getByRole('combobox', { name: 'Due in' }));
    await user.click(await screen.findByRole('option', { name: 'Choose a date' }));
    const date = within(dialog).getByLabelText('Due date');
    await user.clear(date);
    await user.type(date, addDays(TODAY, 20));
    await user.click(within(dialog).getByRole('button', { name: 'Create follow-up' }));
    await waitFor(() => expect(posts.filter((p) => p.path === '/follow-up-tasks')).toHaveLength(1));
    expect(posts.find((p) => p.path === '/follow-up-tasks')!.body).toMatchObject({ title: 'Review knee X-ray', dueAt: istFivePm(20), kind: 'post_visit' });
  });

  it('keeps the completed patient on screen with Create follow-up until the next call', async () => {
    const user = userEvent.setup();
    renderConsole();
    const complete = await screen.findByRole('button', { name: 'Complete' });
    await user.click(complete);
    const just = await screen.findByRole('region', { name: 'Just completed' });
    expect(just).toHaveTextContent('A-014');
    expect(just).toHaveTextContent('Ananya Iyer');
    await user.click(within(just).getByRole('button', { name: 'Create follow-up' }));
    const dialog = await screen.findByRole('dialog', { name: /Create follow-up for Ananya Iyer/ });
    await user.click(within(dialog).getByRole('button', { name: 'Create follow-up' }));
    await waitFor(() => expect(posts.filter((p) => p.path === '/follow-up-tasks')).toHaveLength(1));
    expect(posts.find((p) => p.path === '/follow-up-tasks')!.body).toMatchObject({ sourceVisitId: uid(0xf000 + 14), title: 'Review test results' });

    // The next call replaces it.
    await user.click(await screen.findByRole('button', { name: /^Call next/ }));
    await waitFor(() => expect(screen.queryByRole('region', { name: 'Just completed' })).toBeNull());
  });

  it('keeps the dialog open and says why when the server refuses', async () => {
    failFollowUp = true;
    const user = userEvent.setup();
    renderConsole();
    await user.click(await screen.findByRole('button', { name: 'Create follow-up' }));
    const dialog = await screen.findByRole('dialog', { name: /Create follow-up for/ });
    await user.click(within(dialog).getByRole('button', { name: 'Create follow-up' }));
    expect(await within(dialog).findByText('The follow-up was not created')).toBeVisible();
    expect(within(dialog).getByText('The due time must be in the future.')).toBeVisible();
    expect(screen.queryByTestId('followup-confirmation')).toBeNull();
  });
});

describe('doctor: Skip asks first (PR-35)', () => {
  beforeEach(() => {
    state.active = entry(14, { state: 'called', calledAt: '2026-11-11T04:42:00.000Z', patientName: 'Ananya Iyer' });
  });

  it('opens a confirmation and sends nothing until the doctor confirms', async () => {
    const user = userEvent.setup();
    renderConsole();
    await user.click(await screen.findByRole('button', { name: 'Skip' }));
    const dialog = await screen.findByRole('dialog', { name: /Skip A-014\?/ });
    expect(posts.filter((p) => p.path.endsWith('/skip'))).toHaveLength(0);
    await user.click(within(dialog).getByRole('button', { name: 'Skip' }));
    await waitFor(() => expect(posts.filter((p) => p.path.endsWith('/skip'))).toHaveLength(1));
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Skipped A-014'));
  });

  it('keeps the patient called when the doctor chooses Keep called', async () => {
    const user = userEvent.setup();
    renderConsole();
    await user.click(await screen.findByRole('button', { name: 'Skip' }));
    const dialog = await screen.findByRole('dialog', { name: /Skip A-014\?/ });
    await user.click(within(dialog).getByRole('button', { name: 'Keep called' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(posts.filter((p) => p.path.endsWith('/skip'))).toHaveLength(0);
  });
});
