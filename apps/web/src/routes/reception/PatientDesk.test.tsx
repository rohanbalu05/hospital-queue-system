/* eslint-disable @typescript-eslint/no-non-null-assertion -- fixtures index arrays this file just built */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { toast } from 'sonner';
import {
  DOC_KULKARNI,
  DOC_RAO,
  DOC_SHETTY,
  HARISH,
  LAKSHMI,
  TOMORROW,
  appointment,
  at,
  installDesk,
  makeSession,
  polyfillRadix,
  renderDesk,
  type DeskWorld,
} from './deskKit';

/**
 * PR-21: reception opens a patient's desk view from the arrival search: upcoming appointments with Cancel and Reschedule,
 * and Book appointment (department, doctor, day, session). Patients registered at the desk have no login, so this is
 * the only way they get a future appointment.
 */

vi.mock('sonner', () => ({ toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), info: vi.fn() }), Toaster: () => null }));

polyfillRadix();
afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

function world(): DeskWorld {
  const s1 = makeSession(1, DOC_RAO);
  const s2 = makeSession(2, DOC_KULKARNI, { label: 'afternoon', cap: { bookedCapacity: 10, walkinCapacity: 5, bookedReserved: 4, walkinUsed: 0, bookedAvailable: 6, walkinAvailable: 5 } });
  const s3 = makeSession(3, DOC_KULKARNI, { day: TOMORROW });
  const s4 = makeSession(4, DOC_SHETTY, { day: TOMORROW });
  return {
    doctors: [DOC_RAO, DOC_KULKARNI, DOC_SHETTY],
    sessions: [s1, s2, s3, s4],
    patients: [HARISH, LAKSHMI],
    appointments: [appointment(1, HARISH, s1, at('11:00'))],
    alternatives: [],
  };
}

async function openDesk(user: ReturnType<typeof userEvent.setup>, name = /Harish Gowda/) {
  await screen.findByRole('option', { name });
  await user.click(screen.getByRole('button', { name: 'Open patient desk' }));
  return await screen.findByRole('dialog', { name: /Harish Gowda/ });
}

describe('reception patient desk', () => {
  it('lists the patient\'s upcoming appointments with date, time, doctor and status', async () => {
    installDesk(world());
    const user = userEvent.setup();
    renderDesk();
    const desk = await openDesk(user);
    const row = await within(desk).findByRole('listitem', { name: /Dr. Meenakshi Rao/ });
    expect(row).toHaveTextContent('11:00 am');
    expect(row).toHaveTextContent('Booked');
    expect(within(desk).getByText(/BLR-001001/)).toBeVisible();
  });

  it('says when the patient has nothing booked', async () => {
    const w = world();
    w.appointments = [];
    installDesk(w);
    const user = userEvent.setup();
    renderDesk();
    // With no appointments the list only shows search matches, so find the patient by name.
    await user.type(await screen.findByRole('combobox', { name: 'Find an arrival' }), 'Harish');
    await screen.findByRole('option', { name: /Harish Gowda/ });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Open patient desk' })).toBeEnabled());
    await user.click(screen.getByRole('button', { name: 'Open patient desk' }));
    const desk = await screen.findByRole('dialog', { name: /Harish Gowda/ });
    expect(await within(desk).findByText('No upcoming appointments')).toBeVisible();
    expect(within(desk).getByRole('button', { name: 'Book appointment' })).toBeVisible();
  });

  it('cancels after a confirmation, with an optional reason, using an Idempotency-Key', async () => {
    const { posts } = installDesk(world());
    const user = userEvent.setup();
    renderDesk();
    const desk = await openDesk(user);
    await user.click(await within(desk).findByRole('button', { name: /^Cancel appointment with Dr. Meenakshi Rao/ }));
    expect(await within(desk).findByRole('heading', { name: 'Cancel this appointment?' })).toBeVisible();
    // Nothing is sent until the desk confirms.
    expect(posts.filter((p) => p.path.endsWith('/cancel'))).toHaveLength(0);
    await user.type(within(desk).getByLabelText('Reason (optional)'), 'Patient rang to say he is travelling');
    await user.click(within(desk).getByRole('button', { name: 'Cancel appointment' }));
    await waitFor(() => expect(posts.filter((p) => p.path.endsWith('/cancel'))).toHaveLength(1));
    const sent = posts.find((p) => p.path.endsWith('/cancel'))!;
    expect(sent.body).toEqual({ reason: 'Patient rang to say he is travelling', expectedVersion: 2 });
    expect(sent.key).toBeTruthy();
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Cancelled', expect.anything()));
  });

  it('keeps the appointment when the desk chooses Keep appointment', async () => {
    const { posts } = installDesk(world());
    const user = userEvent.setup();
    renderDesk();
    const desk = await openDesk(user);
    await user.click(await within(desk).findByRole('button', { name: /^Cancel appointment with/ }));
    await user.click(within(desk).getByRole('button', { name: 'Keep appointment' }));
    expect(await within(desk).findByRole('listitem', { name: /Dr. Meenakshi Rao/ })).toBeVisible();
    expect(posts.filter((p) => p.path.endsWith('/cancel'))).toHaveLength(0);
  });

  it('reschedules into another session of the same department and shows the slot it will get', async () => {
    const { posts } = installDesk(world());
    const user = userEvent.setup();
    renderDesk();
    const desk = await openDesk(user);
    await user.click(await within(desk).findByRole('button', { name: /^Reschedule appointment with Dr. Meenakshi Rao/ }));
    expect(await within(desk).findByRole('heading', { name: 'Reschedule appointment' })).toBeVisible();
    // Same department only: Dr. Kulkarni's sessions are offered, ENT's are not.
    expect(within(desk).queryByText(/Dr. Ramesh Shetty/)).toBeNull();
    await user.click(await within(desk).findByRole('radio', { name: /Dr. Shweta Kulkarni.*Afternoon|Afternoon.*Dr. Shweta Kulkarni/ }));
    expect(await within(desk).findByText(/Next free slot/)).toHaveTextContent('10:12 am');
    expect(within(desk).getByText(/6 of 10 places left/)).toBeVisible();
    await user.click(within(desk).getByRole('button', { name: 'Reschedule' }));
    await waitFor(() => expect(posts.filter((p) => p.path.endsWith('/reschedule'))).toHaveLength(1));
    const sent = posts.find((p) => p.path.endsWith('/reschedule'))!;
    expect(sent.body).toEqual({ targetSessionId: makeSession(2, DOC_KULKARNI).id, expectedVersion: 2 });
    expect(sent.key).toBeTruthy();
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Rescheduled', expect.anything()));
  });

  it('books an appointment for the patient: department, doctor, day, session, then confirm', async () => {
    const { posts } = installDesk(world());
    const user = userEvent.setup();
    renderDesk();
    const desk = await openDesk(user);
    await user.click(await within(desk).findByRole('button', { name: 'Book appointment' }));
    expect(await within(desk).findByRole('heading', { name: 'Book an appointment' })).toBeVisible();

    await user.click(within(desk).getByRole('combobox', { name: 'Department' }));
    await user.click(await screen.findByRole('option', { name: 'General Medicine' }));
    await user.click(within(desk).getByRole('combobox', { name: 'Doctor' }));
    await user.click(await screen.findByRole('option', { name: /Dr. Shweta Kulkarni/ }));
    await user.click(within(desk).getByRole('combobox', { name: 'Day' }));
    await user.click(await screen.findByRole('option', { name: /Tomorrow/ }));
    await user.click(await within(desk).findByRole('radio', { name: /Morning/ }));

    expect(await within(desk).findByText(/Next free slot/)).toHaveTextContent('10:12 am');
    expect(within(desk).getByText(/7 of 10 places left/)).toBeVisible();
    expect(posts.filter((p) => p.path === '/appointments')).toHaveLength(0);

    await user.click(within(desk).getByRole('button', { name: 'Book appointment' }));
    await waitFor(() => expect(posts.filter((p) => p.path === '/appointments')).toHaveLength(1));
    const sent = posts.find((p) => p.path === '/appointments')!;
    expect(sent.body).toEqual({ sessionId: makeSession(3, DOC_KULKARNI, { day: TOMORROW }).id, patientId: HARISH.id });
    expect(sent.key).toBeTruthy();
    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith('Booked', { description: expect.stringMatching(/Harish Gowda with Dr. Shweta Kulkarni, Tomorrow, about 10:12 am/) }),
    );
    // Back on the list, which refetches.
    expect(await within(desk).findByRole('heading', { name: 'Upcoming appointments' })).toBeVisible();
  });

  it('shows a plain error when the appointment list cannot be loaded, and retries', async () => {
    const w = world();
    w.failPatientAppointments = true;
    installDesk(w);
    const user = userEvent.setup();
    renderDesk();
    const desk = await openDesk(user);
    expect(await within(desk).findByText('Appointments could not be loaded')).toBeVisible();
    w.failPatientAppointments = false;
    await user.click(within(desk).getByRole('button', { name: /Try again|Retry/ }));
    expect(await within(desk).findByRole('listitem', { name: /Dr. Meenakshi Rao/ })).toBeVisible();
  });
});
