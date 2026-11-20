import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { AffectedPatients, MoveAffectedResult } from '@hqms/contracts';
import { awayAvailability, SESSION_ID, uid } from '@/live/fixtures';
import { AffectedDialog } from './AffectedDialog';

beforeAll(() => {
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  Element.prototype.hasPointerCapture = () => false;
  Element.prototype.setPointerCapture = () => undefined;
  Element.prototype.releasePointerCapture = () => undefined;
  Element.prototype.scrollIntoView = () => undefined;
});

const today = new Date().toISOString().slice(0, 10);
const at = (hhmm: string) => new Date(`${today}T${hhmm}:00+05:30`).toISOString();

const affected = (overrides: Partial<AffectedPatients> = {}): AffectedPatients => ({
  sessionId: SESSION_ID,
  doctorName: 'Dr. Meenakshi Rao',
  department: 'General Medicine',
  availability: awayAvailability(),
  inQueue: [
    { queueEntryId: uid(0xe1), visitId: uid(0xf1), patientId: uid(0xa1), patientName: 'Harish Gowda', patientMrn: 'MRN-100231', token: 'A-014', group: 'A', state: 'waiting', checkedInAt: at('09:32'), version: 1 },
    { queueEntryId: uid(0xe2), visitId: uid(0xf2), patientId: uid(0xa2), patientName: 'Rohan Deshpande', patientMrn: 'MRN-100240', token: 'W-005', group: 'W', state: 'waiting', checkedInAt: at('09:48'), version: 1 },
  ],
  notArrived: [
    { appointmentId: uid(0xb1), patientId: uid(0xa3), patientName: 'Ananya Iyer', patientMrn: 'MRN-100233', patientPhone: '+919900112233', scheduledAt: at('10:36'), status: 'booked', version: 1, hasLogin: true },
    { appointmentId: uid(0xb2), patientId: uid(0xa4), patientName: 'Imran Pasha', patientMrn: 'MRN-100250', patientPhone: '+919845098765', scheduledAt: at('10:48'), status: 'booked', version: 1, hasLogin: false },
  ],
  alternatives: [
    { sessionId: uid(0x5e61), doctorId: uid(0xd2), doctorName: 'Dr. Farah Siddiqui', department: 'General Medicine', room: 'OPD 7', sessionDate: today, label: 'morning', startsAt: at('09:00'), endsAt: at('13:00'), status: 'open', nextSlotAt: at('10:36'), bookedAvailable: 2, walkinAvailable: 0 },
    { sessionId: uid(0x5e62), doctorId: uid(0xd3), doctorName: 'Dr. Arvind Kulkarni', department: 'General Medicine', room: 'OPD 4', sessionDate: today, label: 'afternoon', startsAt: at('14:00'), endsAt: at('17:00'), status: 'scheduled', nextSlotAt: at('14:00'), bookedAvailable: 9, walkinAvailable: 5 },
  ],
  ...overrides,
});

describe('AffectedDialog', () => {
  let body: AffectedPatients = affected();
  let moveRequest: unknown = null;
  let moveKey: string | null = null;
  let moveResult: MoveAffectedResult;

  beforeEach(() => {
    body = affected();
    moveRequest = null;
    moveKey = null;
    moveResult = {
      sourceSessionId: SESSION_ID,
      targetSessionId: uid(0x5e61),
      moved: 2,
      skipped: 1,
      results: [
        { kind: 'queue_entry', sourceId: uid(0xe1), outcome: 'moved', code: null, message: null, newAppointmentId: null, newQueueEntryId: uid(0xe9), token: 'A-021', scheduledAt: null },
        { kind: 'appointment', sourceId: uid(0xb1), outcome: 'moved', code: null, message: null, newAppointmentId: uid(0xb9), newQueueEntryId: null, token: null, scheduledAt: at('10:36') },
        { kind: 'queue_entry', sourceId: uid(0xe2), outcome: 'skipped', code: 'CAPACITY_FULL', message: 'No walk-in place left', newAppointmentId: null, newQueueEntryId: null, token: null, scheduledAt: null },
      ],
    };
    const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const path = new URL(String(input), 'http://localhost').pathname.replace(/^\/api/, '');
        if (path === `/sessions/${SESSION_ID}/affected` && (init?.method ?? 'GET') === 'GET') return json(body);
        if (path === `/sessions/${SESSION_ID}/affected/move`) {
          moveRequest = JSON.parse(String(init?.body));
          moveKey = new Headers(init?.headers).get('Idempotency-Key');
          return json(moveResult);
        }
        return json({ error: { code: 'NOT_FOUND', message: 'Not mocked.' } }, 404);
      }),
    );
  });
  afterEach(() => vi.unstubAllGlobals());

  const renderDialog = () =>
    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })}>
        <AffectedDialog open onOpenChange={vi.fn()} sessionId={SESSION_ID} />
      </QueryClientProvider>,
    );

  it('lists who is in the queue and who is booked but has not arrived, with phone and app', async () => {
    renderDialog();
    const queue = await screen.findByRole('region', { name: 'In the queue' });
    expect(within(queue).getByText('A-014')).toBeVisible();
    expect(within(queue).getByText('Harish Gowda')).toBeVisible();
    const booked = screen.getByRole('region', { name: 'Booked, not arrived' });
    expect(within(booked).getByText('+919900112233')).toBeVisible();
    expect(within(booked).getByText('Has app: yes')).toBeVisible();
    expect(within(booked).getByText('Has app: no')).toBeVisible();
  });

  it('shows each alternative with its doctor, room, time window, free places and next slot', async () => {
    renderDialog();
    const radio = await screen.findByRole('radio', { name: /Dr\. Farah Siddiqui/ });
    const label = document.querySelector(`label[for="${radio.id}"]`) as HTMLElement;
    expect(label).toHaveTextContent('OPD 7');
    expect(label).toHaveTextContent('Morning 9:00 am to 1:00 pm');
    expect(label).toHaveTextContent('2 booked places free, 0 walk-in places free, next slot 10:36 am');
  });

  it('keeps Move disabled until patients and a doctor are chosen, then sends the move with an idempotency key', async () => {
    const user = userEvent.setup();
    renderDialog();
    await screen.findByRole('region', { name: 'In the queue' });
    expect(screen.getByRole('button', { name: 'Choose a doctor to move to' })).toBeDisabled();

    await user.click(screen.getByRole('checkbox', { name: 'Select all' }));
    expect(screen.getByTestId('affected-count')).toHaveTextContent('4 of 4 selected');
    await user.click(screen.getByRole('checkbox', { name: /Imran Pasha/ }));
    expect(screen.getByTestId('affected-count')).toHaveTextContent('3 of 4 selected');

    await user.click(screen.getByRole('radio', { name: /Dr\. Farah Siddiqui/ }));
    const move = screen.getByRole('button', { name: 'Move 3 patients to Dr. Farah Siddiqui' });
    expect(move).toBeEnabled();
    await user.click(move);

    await waitFor(() => expect(moveRequest).not.toBeNull());
    expect(moveRequest).toEqual({ targetSessionId: uid(0x5e61), queueEntryIds: [uid(0xe1), uid(0xe2)], appointmentIds: [uid(0xb1)] });
    expect(moveKey).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('shows per patient who moved and who was skipped, with the reason', async () => {
    const user = userEvent.setup();
    renderDialog();
    await screen.findByRole('region', { name: 'In the queue' });
    await user.click(screen.getByRole('checkbox', { name: 'Select all' }));
    await user.click(screen.getByRole('radio', { name: /Dr\. Farah Siddiqui/ }));
    await user.click(screen.getByRole('button', { name: /^Move 4 patients/ }));

    const results = await screen.findByTestId('move-results');
    expect(within(results).getByText('2 moved to Dr. Farah Siddiqui, 1 not moved')).toBeVisible();
    const rows = within(results).getAllByRole('listitem');
    expect(rows[0]).toHaveTextContent('Moved');
    expect(rows[0]).toHaveTextContent('Harish Gowda');
    expect(rows[0]).toHaveTextContent('New token A-021');
    expect(rows[1]).toHaveTextContent('Ananya Iyer');
    expect(rows[1]).toHaveTextContent('New time 10:36 am');
    expect(rows[2]).toHaveTextContent('Not moved');
    expect(rows[2]).toHaveTextContent('Rohan Deshpande');
    expect(rows[2]).toHaveTextContent("No place left in Dr. Farah Siddiqui's session");
  });

  it('says so when nobody is affected, and when no other doctor can take patients', async () => {
    body = affected({ inQueue: [], notArrived: [] });
    const { unmount } = renderDialog();
    expect(await screen.findByText('No one is affected')).toBeVisible();
    unmount();

    body = affected({ alternatives: [] });
    renderDialog();
    expect(await screen.findByText(/No other General Medicine doctor has a session with room today/)).toBeVisible();
  });
});
