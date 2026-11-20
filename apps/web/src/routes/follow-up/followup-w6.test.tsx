import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import type { FollowUpTaskView } from '@/api';
import { ContactPanel, OutcomePanel, UrgentGuidance, UrgentTag, sortInboxTasks } from '@/components/followup/task-parts';
import { DispositionForm } from './components/DispositionForm';
import { ReturnBookingDialog } from './components/ReturnBookingDialog';
import { TaskTable } from './InboxPage';

afterEach(() => vi.unstubAllGlobals());

beforeAll(() => {
  Element.prototype.hasPointerCapture = () => false;
  Element.prototype.setPointerCapture = () => undefined;
  Element.prototype.releasePointerCapture = () => undefined;
  Element.prototype.scrollIntoView = () => undefined;
});

const NOW = new Date('2026-11-11T04:35:00Z').getTime();
const uuid = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const DR_RAO = uuid(0xd1);
const DR_KULKARNI = uuid(0xd2);

const task = (over: Partial<FollowUpTaskView> = {}): FollowUpTaskView => ({
  id: uuid(10),
  patientId: uuid(11),
  patientName: 'Harish Gowda',
  sourceVisitId: uuid(13),
  sourceMessageId: null,
  sourceVisit: { sessionDate: '2026-11-04', doctorId: DR_RAO, doctorName: 'Dr. Meenakshi Rao', department: 'General Medicine' },
  kind: 'assistant_escalation',
  title: 'Question: dizzy after the new tablets',
  detail: 'Patient asked: "I feel dizzy after the new tablets. Should I stop taking them?"',
  ownerId: uuid(12),
  ownerName: 'Sunita Hegde',
  status: 'acknowledged',
  dueAt: '2026-11-11T14:00:00+05:30',
  overdue: false,
  acknowledgedAt: '2026-11-11T09:10:00+05:30',
  disposition: null,
  outcomeNote: null,
  resolvedAt: null,
  returnAppointmentId: null,
  version: 2,
  createdAt: '2026-11-11T08:00:00+05:30',
  patientMrn: 'MRN-204117',
  patientPhone: '+91 98450 12345',
  doctorName: 'Dr. Meenakshi Rao',
  ...over,
});

const sentBody = (fetchMock: ReturnType<typeof vi.fn>) => {
  const init = (fetchMock.mock.calls[0] as [string, RequestInit] | undefined)?.[1];
  return JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
};

const wrap = (ui: React.ReactNode) =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { mutations: { retry: false }, queries: { retry: false } } })}>
      <MemoryRouter>{ui}</MemoryRouter>
    </QueryClientProvider>,
  );

describe('ContactPanel (PR-38)', () => {
  it('shows name, MRN, doctor, source visit, the question and the phone as a tel link', () => {
    wrap(<ContactPanel task={task()} />);
    expect(screen.getByText('Harish Gowda')).toBeVisible();
    expect(screen.getByText('MRN-204117')).toBeVisible();
    expect(screen.getByText('Dr. Meenakshi Rao')).toBeVisible();
    expect(screen.getByText(/Wed, 4 Nov/)).toBeVisible();
    expect(screen.getByText(/dizzy after the new tablets/)).toBeVisible();
    const call = screen.getByRole('link', { name: /\+91 98450 12345/ });
    expect(call).toHaveAttribute('href', 'tel:+919845012345');
  });

  it('says plainly when no phone number is on record', () => {
    wrap(<ContactPanel task={task({ patientPhone: null })} />);
    expect(screen.queryByRole('link', { name: /\+91/ })).toBeNull();
    expect(screen.getByText(/No phone number on record/)).toBeVisible();
  });

  it('falls back to the source visit doctor when doctorName is absent', () => {
    wrap(<ContactPanel task={task({ doctorName: null })} />);
    expect(screen.getByText('Dr. Meenakshi Rao')).toBeVisible();
  });
});

describe('urgent tasks (PR-13)', () => {
  it('UrgentTag carries the word, not only a colour', () => {
    render(<UrgentTag />);
    expect(screen.getByText('Urgent')).toBeVisible();
  });

  it('UrgentGuidance tells staff to call now', () => {
    render(<UrgentGuidance />);
    expect(screen.getByText('Red-flag symptoms reported. Call the patient now.')).toBeVisible();
  });

  it('lists urgent open tasks first, then overdue, then the rest, closed last', () => {
    const calm = task({ id: uuid(1), title: 'calm overdue', dueAt: '2026-11-10T10:00:00+05:30', overdue: true });
    const later = task({ id: uuid(2), title: 'later', dueAt: '2026-11-11T20:00:00+05:30' });
    const urgentLater = task({ id: uuid(3), title: 'urgent later', urgent: true, dueAt: '2026-11-11T18:00:00+05:30' });
    const closedUrgent = task({ id: uuid(4), title: 'closed urgent', urgent: true, status: 'resolved' });
    const out = sortInboxTasks([calm, later, closedUrgent, urgentLater], NOW).map((t) => t.title);
    expect(out).toEqual(['urgent later', 'calm overdue', 'later', 'closed urgent']);
  });

  it('marks an urgent row with the word Urgent in the inbox table', () => {
    wrap(<TaskTable now={NOW} tasks={[task({ urgent: true }), task({ id: uuid(5), patientName: 'Lakshmi Narayanan' })]} />);
    const [urgentRow, calmRow] = screen.getAllByTestId('task-row') as [HTMLElement, HTMLElement];
    expect(within(urgentRow).getByText('Urgent')).toBeVisible();
    expect(within(calmRow).queryByText('Urgent')).toBeNull();
  });
});

describe('DispositionForm reply to the patient (PR-14)', () => {
  const renderForm = (t = task()) => wrap(<DispositionForm task={t} booked={null} onBookReturn={vi.fn()} onCancel={vi.fn()} />);
  const choose = async (user: ReturnType<typeof userEvent.setup>, name: string) => {
    await user.click(screen.getByRole('combobox', { name: 'Outcome' }));
    await user.click(await screen.findByRole('option', { name }));
  };

  it('separates what the patient sees from what only staff see', () => {
    renderForm();
    expect(screen.getByLabelText(/Reply to the patient/)).toBeInTheDocument();
    expect(screen.getByText(/The patient sees this/)).toBeVisible();
    expect(screen.getByLabelText(/Outcome note/)).toBeInTheDocument();
    expect(screen.getByText(/Staff only/)).toBeVisible();
  });

  it.each(['Advice given', 'Referred'])('requires a reply for %s and does not call the server without one', async (name) => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();
    renderForm();
    await choose(user, name);
    expect(screen.getByText('Required for this outcome.')).toBeVisible();
    await user.type(screen.getByLabelText(/Outcome note/), 'Spoke to patient.');
    await user.click(screen.getByRole('button', { name: 'Resolve task' }));
    expect(screen.getByText('Write the reply the patient will read, at least 3 characters.')).toBeVisible();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('does not require a reply for Unreachable and sends none', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(task({ status: 'resolved' })), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();
    renderForm();
    await choose(user, 'Unreachable');
    expect(screen.getByText('Optional for this outcome.')).toBeVisible();
    await user.type(screen.getByLabelText(/Outcome note/), 'Phone switched off, tried twice.');
    await user.click(screen.getByRole('button', { name: 'Resolve task' }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const body = sentBody(fetchMock);
    expect(body.disposition).toBe('unreachable');
    expect(body).not.toHaveProperty('patientReply');
  });

  it('sends the reply and the staff note as separate fields', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(task({ status: 'resolved' })), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();
    renderForm();
    await choose(user, 'Advice given');
    await user.type(screen.getByLabelText(/Reply to the patient/), 'Please do not stop the tablets on your own. Come in today.');
    await user.type(screen.getByLabelText(/Outcome note/), 'Called 10:40, patient anxious.');
    await user.click(screen.getByRole('button', { name: 'Resolve task' }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const body = sentBody(fetchMock);
    expect(body).toMatchObject({
      disposition: 'advice_given',
      outcomeNote: 'Called 10:40, patient anxious.',
      patientReply: 'Please do not stop the tablets on your own. Come in today.',
    });
  });
});

describe('OutcomePanel', () => {
  it('shows the reply that was sent, apart from the staff note', () => {
    render(
      <OutcomePanel
        task={task({
          status: 'resolved',
          disposition: 'advice_given',
          resolvedAt: '2026-11-11T11:00:00+05:30',
          outcomeNote: 'Internal: patient asked about a work letter.',
          patientReply: 'Please do not stop the tablets on your own. Come in today.',
        })}
      />,
    );
    expect(screen.getByText('Reply sent to the patient')).toBeVisible();
    expect(screen.getByText('Please do not stop the tablets on your own. Come in today.')).toBeVisible();
    expect(screen.getByText('Staff note')).toBeVisible();
    expect(screen.getByText(/Internal: patient asked/)).toBeVisible();
  });

  it('says no reply was sent for a resolved task without one', () => {
    render(<OutcomePanel task={task({ status: 'resolved', disposition: 'unreachable', outcomeNote: 'No answer.' })} />);
    expect(screen.getByText('No reply was sent to the patient.')).toBeVisible();
  });
});

describe('ReturnBookingDialog (PR-39)', () => {
  const doctors = [
    { id: DR_KULKARNI, fullName: 'Dr. Shweta Kulkarni', department: 'Dermatology', room: 'Room 4', active: true },
    { id: DR_RAO, fullName: 'Dr. Meenakshi Rao', department: 'General Medicine', room: 'Room 2', active: true },
  ];
  const session = (n: number, date: string) => ({
    id: uuid(0x500 + n),
    doctorId: DR_RAO,
    doctorName: 'Dr. Meenakshi Rao',
    department: 'General Medicine',
    room: 'Room 2',
    sessionDate: date,
    label: 'morning',
    startsAt: `${date}T09:00:00+05:30`,
    endsAt: `${date}T13:00:00+05:30`,
    slotMinutes: 12,
    status: 'scheduled',
    policyVersion: 1,
    capacity: { bookedCapacity: 10, walkinCapacity: 5, bookedReserved: 2, walkinUsed: 0, bookedAvailable: 8, walkinAvailable: 5 },
    version: 1,
  });

  const stub = (sessions: unknown[]) => {
    const fetchMock = vi.fn((url: string) => {
      const body = url.startsWith('/api/doctors') ? doctors : sessions;
      return Promise.resolve(new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    });
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  };

  it('defaults the doctor to the task doctor (by name) instead of the first in the list, and says the real date range', async () => {
    const fetchMock = stub([session(1, '2026-11-12'), session(2, '2026-11-18')]);
    wrap(<ReturnBookingDialog open task={task({ sourceVisit: null })} onOpenChange={vi.fn()} onBooked={vi.fn()} />);
    await waitFor(() => expect(screen.getByRole('combobox', { name: 'Doctor' })).toHaveTextContent('Dr. Meenakshi Rao, General Medicine'));
    await waitFor(() => expect(fetchMock.mock.calls.some(([u]) => String(u).includes(`doctorId=${DR_RAO}`))).toBe(true));
    expect(await screen.findByText('Sessions from Thu, 12 Nov to Wed, 18 Nov')).toBeVisible();
    expect(screen.queryByText(/next 14 days/)).toBeNull();
  });

  it('keeps the source visit doctor when the API sends it', async () => {
    stub([]);
    wrap(<ReturnBookingDialog open task={task({ doctorName: null })} onOpenChange={vi.fn()} onBooked={vi.fn()} />);
    await waitFor(() => expect(screen.getByRole('combobox', { name: 'Doctor' })).toHaveTextContent('Dr. Meenakshi Rao'));
  });
});
