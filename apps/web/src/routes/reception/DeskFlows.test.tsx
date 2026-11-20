/* eslint-disable @typescript-eslint/no-non-null-assertion -- fixtures index arrays this file just built */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { toast } from 'sonner';
import { entry, uid } from '@/live/fixtures';
import {
  DOC_KULKARNI,
  DOC_RAO,
  HARISH,
  LAKSHMI,
  TODAY,
  appointment,
  at,
  capacity,
  installDesk,
  makeSession,
  patient,
  polyfillRadix,
  renderDesk,
  type DeskWorld,
} from './deskKit';

/**
 * PR-22 duplicate warning, PR-23 other doctors when walk-ins are full, PR-25 already-in-another-queue warning,
 * PR-26 late markers, PR-27 Mark absent asks first.
 */

vi.mock('sonner', () => ({ toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), info: vi.fn() }), Toaster: () => null }));

polyfillRadix();
afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

const duplicateReply = (candidates: unknown[]) => (body: Record<string, unknown>) =>
  body.confirmNew
    ? { status: 201, body: patient(91, String(body.fullName), (body.phone as string | null) ?? null) }
    : {
        status: 409,
        body: { error: { code: 'CONFLICT', message: 'This may be an existing patient.', details: { reason: 'POSSIBLE_DUPLICATE', candidates } } },
      };

function base(): DeskWorld {
  const s1 = makeSession(1, DOC_RAO);
  const s2 = makeSession(2, DOC_KULKARNI);
  return { doctors: [DOC_RAO, DOC_KULKARNI], sessions: [s1, s2], patients: [HARISH, LAKSHMI], appointments: [], alternatives: [] };
}

async function fillRegister(user: ReturnType<typeof userEvent.setup>, name: string, phone: string) {
  await user.click(await screen.findByRole('button', { name: 'Register new patient' }));
  await user.type(screen.getByLabelText('Full name'), name);
  await user.type(screen.getByLabelText('Phone (optional)'), phone);
  await user.click(screen.getByRole('button', { name: 'Register and admit walk-in' }));
}

describe('PR-22: possible duplicate on registration', () => {
  const candidate = patient(7, 'Kiran Walkin', '+919900011122', { dateOfBirth: '1991-07-02' });

  it('shows the candidates and lets the desk use an existing patient instead', async () => {
    const w = base();
    w.registerReply = duplicateReply([candidate]);
    const { posts } = installDesk(w);
    const user = userEvent.setup();
    renderDesk();
    await fillRegister(user, 'Kiran Walkin', '+919900011122');

    const panel = await screen.findByRole('alert', { name: /may be an existing patient/i });
    expect(within(panel).getByText('Kiran Walkin')).toBeVisible();
    expect(panel).toHaveTextContent('BLR-001007');
    expect(panel).toHaveTextContent('+919900011122');
    expect(panel).toHaveTextContent('2 Jul 1991');

    await user.click(within(panel).getByRole('button', { name: 'Use this patient: Kiran Walkin' }));
    await waitFor(() => expect(posts.filter((p) => p.path.endsWith('/walk-ins'))).toHaveLength(1));
    expect(posts.find((p) => p.path.endsWith('/walk-ins'))!.body).toEqual({ patientId: candidate.id });
    // The registration was not repeated.
    expect(posts.filter((p) => p.path === '/patients')).toHaveLength(1);
  });

  it('creates the new record anyway by resending with confirmNew', async () => {
    const w = base();
    w.registerReply = duplicateReply([candidate]);
    const { posts } = installDesk(w);
    const user = userEvent.setup();
    renderDesk();
    await fillRegister(user, 'Kiran Walkin', '+919900011122');
    await user.click(await screen.findByRole('button', { name: 'Create new record anyway' }));
    await waitFor(() => expect(posts.filter((p) => p.path === '/patients')).toHaveLength(2));
    const [first, second] = posts.filter((p) => p.path === '/patients');
    expect(first!.body.confirmNew).toBeUndefined();
    expect(second!.body).toMatchObject({ fullName: 'Kiran Walkin', confirmNew: true });
    // Same request body differs, so the key differs: the server will not treat it as a replay.
    expect(second!.key).not.toEqual(first!.key);
    await waitFor(() => expect(posts.filter((p) => p.path.endsWith('/walk-ins'))).toHaveLength(1));
    expect(posts.find((p) => p.path.endsWith('/walk-ins'))!.body).toEqual({ patientId: uid(0xa000 + 91) });
  });
});

describe('PR-23: other doctors when walk-in places are full', () => {
  const alt = (over: Record<string, unknown> = {}) => ({
    sessionId: makeSession(2, DOC_KULKARNI).id,
    doctorId: DOC_KULKARNI.id,
    doctorName: DOC_KULKARNI.fullName,
    department: 'General Medicine',
    room: 'Room 14',
    sessionDate: TODAY,
    label: 'morning',
    startsAt: at('00:01'),
    endsAt: at('23:59'),
    status: 'open',
    nextSlotAt: at('10:12'),
    bookedAvailable: 6,
    walkinAvailable: 3,
    ...over,
  });

  function full(): DeskWorld {
    const w = base();
    w.sessions[0] = makeSession(1, DOC_RAO, { cap: capacity({ walkinUsed: 5 }) });
    w.alternatives = [alt(), alt({ sessionId: uid(0x5e99), doctorId: uid(0xd9), doctorName: 'Dr. Anil Bhat', walkinAvailable: 0 })];
    return w;
  }

  async function selectLakshmi(user: ReturnType<typeof userEvent.setup>) {
    await user.type(await screen.findByRole('combobox', { name: 'Find an arrival' }), 'Lakshmi');
    await screen.findByRole('option', { name: /Lakshmi Narayanan/ });
  }

  it('lists same-department doctors with free walk-in places and admits the patient to the chosen one', async () => {
    const { posts } = installDesk(full());
    const user = userEvent.setup();
    renderDesk();
    await selectLakshmi(user);
    expect(await screen.findByRole('heading', { name: 'Other doctors in General Medicine today' })).toBeVisible();
    expect(screen.getByText(/3 of 5 walk-in places left|3 walk-in places left/)).toBeVisible();
    // A doctor with no free walk-in place is not offered.
    expect(screen.queryByRole('button', { name: /Admit to Dr. Anil Bhat/ })).toBeNull();
    expect(screen.getByText(/Ask an admin to raise capacity/)).toBeVisible();

    await waitFor(() => expect(screen.getByRole('button', { name: 'Admit to Dr. Shweta Kulkarni' })).toBeEnabled());
    await user.click(screen.getByRole('button', { name: 'Admit to Dr. Shweta Kulkarni' }));
    await waitFor(() => expect(posts.filter((p) => p.path.endsWith('/walk-ins'))).toHaveLength(1));
    const sent = posts.find((p) => p.path.endsWith('/walk-ins'))!;
    expect(sent.path).toBe(`/sessions/${makeSession(2, DOC_KULKARNI).id}/walk-ins`);
    expect(sent.body).toEqual({ patientId: LAKSHMI.id });
    expect(sent.key).toBeTruthy();
    expect(await screen.findByTestId('arrival-outcome')).toHaveTextContent('With Dr. Shweta Kulkarni');
  });

  it('does not offer a raised limit: the last resort is words, not a button', async () => {
    installDesk(full());
    const user = userEvent.setup();
    renderDesk();
    await selectLakshmi(user);
    await screen.findByRole('heading', { name: 'Other doctors in General Medicine today' });
    expect(screen.queryByRole('button', { name: /override|raise capacity|admit anyway/i })).toBeNull();
  });

  it('says so when no other doctor has a free place', async () => {
    const w = full();
    w.alternatives = [];
    installDesk(w);
    const user = userEvent.setup();
    renderDesk();
    await selectLakshmi(user);
    expect(await screen.findByText(/No other doctor in General Medicine has a free walk-in place today/)).toBeVisible();
    expect(screen.getByText(/Ask an admin to raise capacity/)).toBeVisible();
  });

  it('does not ask for alternatives while walk-in places are free', async () => {
    const w = base();
    installDesk(w);
    const user = userEvent.setup();
    renderDesk();
    await selectLakshmi(user);
    expect(screen.queryByRole('heading', { name: /Other doctors in/ })).toBeNull();
  });
});

describe('PR-25: patient already waiting for another doctor', () => {
  it('warns before a walk-in is admitted to a second queue', async () => {
    const w = base();
    // Lakshmi is booked with Dr. Kulkarni today; the desk is on Dr. Rao's session.
    w.appointments = [appointment(5, LAKSHMI, w.sessions[1]!, at('11:30'))];
    installDesk(w);
    const user = userEvent.setup();
    renderDesk();
    await user.type(await screen.findByRole('combobox', { name: 'Find an arrival' }), 'Lakshmi');
    await screen.findByRole('option', { name: /Lakshmi Narayanan/ });
    const warning = await screen.findByRole('status', { name: /already/i });
    expect(warning).toHaveTextContent('Dr. Shweta Kulkarni');
    expect(warning).toHaveTextContent('11:30 am');
  });

  it('does not warn when the patient has nothing else today', async () => {
    installDesk(base());
    const user = userEvent.setup();
    renderDesk();
    await user.type(await screen.findByRole('combobox', { name: 'Find an arrival' }), 'Lakshmi');
    await screen.findByRole('option', { name: /Lakshmi Narayanan/ });
    await waitFor(() => expect(screen.getByRole('button', { name: /^Admit walk-in: Lakshmi/ })).toBeEnabled());
    expect(screen.queryByText(/already has/)).toBeNull();
  });
});

describe('PR-26: late and past-grace markers in the Expected list', () => {
  it('marks a booked patient who is late, and one past the 15 minute grace', async () => {
    const w = base();
    const s1 = w.sessions[0]!;
    const minsAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();
    w.appointments = [
      appointment(1, HARISH, s1, minsAgo(5)),
      appointment(2, LAKSHMI, s1, minsAgo(20)),
      appointment(3, patient(3, 'Ananya Iyer', null), s1, new Date(Date.now() + 40 * 60_000).toISOString()),
    ];
    installDesk(w);
    renderDesk();
    const lane = await screen.findByRole('region', { name: /Expected/ }).catch(() => null);
    const scope = lane ?? document.body;
    expect(await within(scope).findByText('Late 5 min')).toBeVisible();
    expect(within(scope).getByText('Late 20 min, past grace')).toBeVisible();
    // Someone not yet due gets no marker.
    expect(within(scope).getAllByText(/^Late /)).toHaveLength(2);
  });
});

describe('PR-27: Mark absent asks first', () => {
  it('opens a confirmation with an optional reason and sends nothing until confirmed', async () => {
    const w = base();
    w.snapshot = { waiting: [entry(3, { patientName: 'Harish Gowda', projectedPosition: 1 })] };
    const { posts } = installDesk(w);
    const user = userEvent.setup();
    renderDesk();
    await user.click(await screen.findByRole('button', { name: /A-003/ }));
    await user.click(screen.getByRole('button', { name: 'Mark absent' }));
    const dialog = await screen.findByRole('dialog', { name: /Mark A-003 absent/ });
    expect(posts.filter((p) => p.path.includes('/absent'))).toHaveLength(0);
    await user.type(within(dialog).getByLabelText('Reason (optional)'), 'Went to pharmacy');
    await user.click(within(dialog).getByRole('button', { name: 'Mark absent' }));
    await waitFor(() => expect(posts.filter((p) => p.path.includes('/absent'))).toHaveLength(1));
    expect(posts.find((p) => p.path.includes('/absent'))!.body).toMatchObject({ reason: 'Went to pharmacy', expectedVersion: 1 });
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Marked absent', expect.anything()));
  });

  it('does nothing when the desk cancels the dialog', async () => {
    const w = base();
    w.snapshot = { waiting: [entry(3, { patientName: 'Harish Gowda' })] };
    const { posts } = installDesk(w);
    const user = userEvent.setup();
    renderDesk();
    await user.click(await screen.findByRole('button', { name: /A-003/ }));
    await user.click(screen.getByRole('button', { name: 'Mark absent' }));
    const dialog = await screen.findByRole('dialog', { name: /Mark A-003 absent/ });
    await user.click(within(dialog).getByRole('button', { name: 'Keep waiting' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(posts.filter((p) => p.path.includes('/absent'))).toHaveLength(0);
  });
});
