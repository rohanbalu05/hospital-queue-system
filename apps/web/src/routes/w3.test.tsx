import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import type { Appointment, ConversationMessage, QueuePolicy } from '@hqms/contracts';
import { Field } from '@/components/layout/Field';
import { plainErrorMessage } from '@/components/queue';
import { TaskStatusWord, TimingWord } from '@/components/followup/words';
import { ApiRequestError } from '@/lib/api';
import { policyRows } from '@/routes/admin/PolicyPage';
import { KindTag, metricValue } from '@/routes/admin/ReportsPage';
import { InstructionForm, titleFromDraft } from '@/routes/doctor/review/InstructionForm';
import { VersionTag } from '@/routes/doctor/review/InstructionHistory';
import { MessageView, citationLine } from '@/routes/patient/AssistantPage';
import { PATIENT_TASK_WORD } from '@/routes/patient/FollowUpsPage';
import { uploadErrorWords } from '@/routes/patient/DocumentsPage';
import { todaysAppointments } from '@/routes/patient/TodayPage';
import { DispositionForm } from '@/routes/follow-up/components/DispositionForm';
import type { FollowUpTaskView } from '@/api';

afterEach(() => vi.unstubAllGlobals());

// Radix Select expects pointer-capture and scrollIntoView, which jsdom lacks.
beforeAll(() => {
  Element.prototype.hasPointerCapture = () => false;
  Element.prototype.setPointerCapture = () => undefined;
  Element.prototype.releasePointerCapture = () => undefined;
  Element.prototype.scrollIntoView = () => undefined;
});

const NOW = new Date('2026-11-11T04:35:00Z').getTime();
const uuid = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;

describe('Field', () => {
  it('ties label, hint and error to the control', () => {
    render(
      <Field label="Reason" hint="Say why." error="Required.">
        <input />
      </Field>,
    );
    const input = screen.getByLabelText('Reason');
    expect(input).toHaveAttribute('aria-invalid', 'true');
    expect(input.getAttribute('aria-describedby')).toContain('-hint');
    expect(screen.getByRole('alert')).toHaveTextContent('Required.');
  });

  it('passes the id and aria props to a render function', () => {
    render(<Field label="Outcome">{(p) => <button {...p}>Choose</button>}</Field>);
    expect(screen.getByLabelText('Outcome')).toHaveTextContent('Choose');
  });
});

describe('task words', () => {
  it('prints Overdue as a bold ink word, never red and never colour only', () => {
    const { container } = render(<TimingWord task={{ status: 'open', dueAt: '2026-11-10T17:00:00+05:30', overdue: true }} now={NOW} />);
    expect(screen.getByText('Overdue 17 h')).toBeVisible();
    expect(screen.getByText('Overdue 17 h')).toHaveClass('font-bold', 'text-ink');
    expect(container.querySelector('.text-priority')).toBeNull();
  });
  it('shows a dash for a closed task and the status as a word', () => {
    render(
      <>
        <TimingWord task={{ status: 'resolved', dueAt: '2026-11-01T10:00:00+05:30', overdue: true }} now={NOW} />
        <TaskStatusWord status="acknowledged" />
      </>,
    );
    expect(screen.getByText('-')).toBeVisible();
    expect(screen.getByText('Acknowledged')).toBeVisible();
  });
  it('uses patient words that carry no staff detail', () => {
    expect(PATIENT_TASK_WORD.open).toBe('Waiting for the follow-up team');
    expect(Object.values(PATIENT_TASK_WORD).join(' ')).not.toMatch(/owner|acknowledged/i);
  });
});

describe('assistant messages', () => {
  const base: ConversationMessage = { id: uuid(5), role: 'assistant', body: '', outcome: 'answered', citations: [], escalationTaskId: null, escalationDueAt: null, createdAt: '2026-11-11T09:12:00+05:30' };

  it('cites the verified instruction version with its verified date', () => {
    expect(citationLine({ title: 'Care after viral fever', version: 2 }, '2026-11-09T12:40:00+05:30')).toBe('From: Care after viral fever (version 2, verified 9 Nov 2026)');
    expect(citationLine({ title: 'Care after viral fever', version: 2 }, undefined)).toBe('From: Care after viral fever (version 2)');
    render(
      <ul>
        <MessageView message={{ ...base, body: 'Rest for 3 days.', citations: [{ instructionVersionId: uuid(1), title: 'Care after viral fever', version: 2, verifiedAt: '2026-11-09T12:40:00+05:30' }] }} />
      </ul>,
    );
    expect(screen.getByText('Rest for 3 days.')).toBeVisible();
    expect(screen.getByText('From: Care after viral fever (version 2, verified 9 Nov 2026)')).toBeVisible();
  });

  it('says an unsupported question was sent to the team and when to expect a reply', () => {
    render(
      <ul>
        <MessageView message={{ ...base, outcome: 'escalated', body: 'ignored', escalationTaskId: uuid(7), escalationDueAt: '2026-11-11T14:00:00+05:30' }} />
      </ul>,
    );
    expect(screen.getByText(/Sent to the follow-up team\./)).toBeVisible();
    expect(screen.getByText(/You'll hear back by 11 Nov, 2:00 pm\./)).toBeVisible();
    expect(screen.queryByText('ignored')).toBeNull();
  });

  it('has no icon on assistant rows', () => {
    const { container } = render(
      <ul>
        <MessageView message={{ ...base, body: 'Rest.' }} />
      </ul>,
    );
    expect(container.querySelector('svg')).toBeNull();
  });
});

describe('upload errors', () => {
  const err = (code: ApiRequestError['code']) => new ApiRequestError({ status: 400, code, message: 'raw server text' });
  it('explains each server limit in plain words', () => {
    expect(uploadErrorWords(err('UPLOAD_TOO_LARGE'))).toMatch(/larger than 10 MB/);
    expect(uploadErrorWords(err('UPLOAD_TOO_MANY_PAGES'))).toMatch(/more than 10 pages/);
    expect(uploadErrorWords(err('UNSUPPORTED_MEDIA_TYPE'))).toMatch(/PDF, PNG or JPEG/);
    expect(uploadErrorWords(err('INTERNAL'))).not.toContain('raw server text');
  });
});

describe('plainErrorMessage', () => {
  it('replaces raw server strings with plain words, but keeps messages the API writes for people', () => {
    expect(plainErrorMessage(new ApiRequestError({ status: 404, code: 'NOT_FOUND', message: 'Not mocked.' }))).toBe('The server could not find what this screen asked for.');
    expect(plainErrorMessage(new ApiRequestError({ status: 500, code: 'INTERNAL', message: 'stack trace' }))).toBe('The server had a problem and could not finish.');
    expect(plainErrorMessage(new ApiRequestError({ status: 409, code: 'CAPACITY_FULL', message: 'No places are left in this session.' }))).toBe('No places are left in this session.');
    expect(plainErrorMessage(null)).toBeNull();
  });
});

describe('admin words', () => {
  it('labels every metric Measured or Target and says when there is no data', () => {
    render(
      <>
        <KindTag kind="measured" />
        <KindTag kind="target" />
      </>,
    );
    expect(screen.getByText('Measured')).toBeVisible();
    expect(screen.getByText('Target')).toBeVisible();
    expect(metricValue({ value: null, unit: 'ms' })).toBe('Not enough data');
    expect(metricValue({ value: 500, unit: 'ms' })).toBe('500 ms');
    expect(metricValue({ value: 0, unit: 'count' })).toBe('0');
    expect(metricValue({ value: 2.35, unit: 's' })).toBe('2.4 s');
  });

  it('lists Table 7 policy values', () => {
    const p: QueuePolicy = {
      id: uuid(1),
      version: 1,
      rotation: ['A', 'A', 'W'],
      earlyEligibilityMin: 10,
      lateGraceMin: 15,
      agingTriggerMin: 45,
      calledTimeoutSec: 120,
      ewmaAlpha: 0.2,
      initialEstimateMin: 12,
      defaultBookedCapacity: 10,
      defaultWalkinCapacity: 5,
      createdAt: '2026-11-01T08:00:00+05:30',
    };
    const rows = Object.fromEntries(policyRows(p).map((r) => [r.setting, r.value]));
    expect(rows['Group rotation']).toBe('A, A, W');
    expect(rows['Called timeout']).toBe('2 min');
    expect(rows['EWMA smoothing']).toBe('0.2');
    expect(rows['Booked capacity']).toBe('10 per session');
    expect(rows['Walk-in capacity']).toBe('5 per session');
  });
});

describe('instruction review', () => {
  it('starts the title from a short first line of the draft', () => {
    expect(titleFromDraft('Fever and throat infection: home care\nTab. Cefixime 200 mg')).toBe('Fever and throat infection: home care');
    expect(titleFromDraft('x'.repeat(120))).toBe('');
    expect(titleFromDraft('')).toBe('');
  });

  it('marks versions Current or Superseded with a word', () => {
    render(
      <>
        <VersionTag status="current" />
        <VersionTag status="superseded" />
      </>,
    );
    expect(screen.getByText('Current')).toBeVisible();
    expect(screen.getByText('Superseded')).toBeVisible();
  });

  it('asks for a title and text before verifying, then sends the draft id', async () => {
    const user = userEvent.setup();
    const onVerify = vi.fn();
    render(<InstructionForm initialTitle="" initialBody="" current={[]} sourceDraftId={uuid(4)} pending={false} error={null} onVerify={onVerify} />);
    await user.click(screen.getByRole('button', { name: 'Verify instruction' }));
    expect(screen.getByText('Give the instruction a title of at least 3 characters.')).toBeVisible();
    expect(screen.getByText('Write the instruction, at least 3 characters.')).toBeVisible();
    expect(onVerify).not.toHaveBeenCalled();

    await user.type(screen.getByLabelText('Title'), 'Back pain care');
    await user.type(screen.getByLabelText('Instruction'), 'Avoid lifting for 2 weeks.');
    await user.click(screen.getByRole('button', { name: 'Verify instruction' }));
    expect(onVerify).toHaveBeenCalledWith({ title: 'Back pain care', body: 'Avoid lifting for 2 weeks.', sourceDraftId: uuid(4) });
  });
});

describe('DispositionForm', () => {
  const task: FollowUpTaskView = {
    id: uuid(10),
    patientId: uuid(11),
    patientName: 'Harish Gowda',
    sourceVisitId: null,
    sourceMessageId: null,
    kind: 'post_visit',
    title: 'Check recovery',
    detail: null,
    ownerId: uuid(12),
    ownerName: 'Sunita Hegde',
    status: 'acknowledged',
    dueAt: '2026-11-10T17:00:00+05:30',
    overdue: true,
    acknowledgedAt: '2026-11-10T10:20:00+05:30',
    disposition: null,
    outcomeNote: null,
    resolvedAt: null,
    returnAppointmentId: null,
    version: 2,
    createdAt: '2026-11-09T12:10:00+05:30',
  };
  const renderForm = () =>
    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { mutations: { retry: false } } })}>
        <MemoryRouter>
          <DispositionForm task={task} booked={null} onBookReturn={vi.fn()} onCancel={vi.fn()} />
        </MemoryRouter>
      </QueryClientProvider>,
    );

  it('asks for an outcome and a note, without calling the server', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();
    renderForm();
    await user.click(screen.getByRole('button', { name: 'Resolve task' }));
    expect(screen.getByText('Choose what happened.')).toBeVisible();
    expect(screen.getByText('Add a short outcome note, at least 3 characters.')).toBeVisible();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('keeps Return booked from resolving until a return visit is linked', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();
    renderForm();
    await user.click(screen.getByRole('combobox', { name: 'Outcome' }));
    await user.click(await screen.findByRole('option', { name: 'Return booked' }));
    expect(screen.getByText(/No return visit is linked yet/)).toBeVisible();
    await user.type(screen.getByLabelText('Outcome note'), 'Patient wants a visit.');
    await user.click(screen.getByRole('button', { name: 'Resolve task' }));
    await waitFor(() => expect(screen.getByText('Book the return visit first, or choose another outcome.')).toBeVisible());
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('todaysAppointments', () => {
  const appt = (id: string, scheduledAt: string, status: Appointment['status']): Appointment => ({
    id,
    patientId: uuid(1),
    sessionId: uuid(2),
    doctorId: uuid(3),
    doctorName: 'Dr. Meenakshi Rao',
    department: 'General Medicine',
    scheduledAt,
    status,
    rescheduledFromId: null,
    followUpTaskId: null,
    version: 1,
    createdAt: '2026-11-05T10:30:00+05:30',
  });

  it('keeps booked and checked-in appointments on today (IST), earliest first', () => {
    const list = [
      appt('late', '2026-11-11T11:40:00+05:30', 'booked'),
      appt('early', '2026-11-11T09:20:00+05:30', 'checked_in'),
      appt('done', '2026-11-11T09:00:00+05:30', 'completed'),
      appt('cancelled', '2026-11-11T10:00:00+05:30', 'cancelled'),
      appt('tomorrow', '2026-11-12T09:00:00+05:30', 'booked'),
      // 11:30 pm UTC on 10 Nov is 5:00 am on 11 Nov in Bengaluru.
      appt('utc-evening', '2026-11-10T23:30:00Z', 'booked'),
    ];
    expect(todaysAppointments(list, '2026-11-11').map((a) => a.id)).toEqual(['utc-evening', 'early', 'late']);
  });
});
