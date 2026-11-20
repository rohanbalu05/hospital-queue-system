import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ApiRequestError } from '@/lib/api';
import { awayAvailability, AVAILABLE } from '@/live/fixtures';
import { AvailabilityStrip } from './AvailabilityControls';
import { StepAwayDialog, UnavailableDialog } from './AvailabilityDialogs';
import { availabilityError, availabilityLine, displayBannerText, returnProblem, doctorNameOnly } from './availability';

beforeAll(() => {
  // Radix radio groups measure their items with ResizeObserver, which jsdom lacks.
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  Element.prototype.hasPointerCapture = () => false;
  Element.prototype.setPointerCapture = () => undefined;
  Element.prototype.releasePointerCapture = () => undefined;
  Element.prototype.scrollIntoView = () => undefined;
});

// 10:05 am IST on Wed 11 Nov 2026. Only Date is faked so userEvent and Radix keep their real timers.
const NOW = new Date('2026-11-11T04:35:00.000Z');
const ENDS = '2026-11-11T07:30:00.000Z'; // 1:00 pm IST

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'], now: NOW });
});
afterEach(() => vi.useRealTimers());

describe('availability words', () => {
  it('writes the doctor line with since and expected return', () => {
    expect(availabilityLine(awayAvailability(), 'You')).toBe('You are away · since 10:30 am · expected back about 10:45 am');
    expect(availabilityLine(awayAvailability(), 'Dr. Meenakshi Rao')).toBe('Dr. Meenakshi Rao is away · since 10:30 am · expected back about 10:45 am');
  });

  it('says longer than expected once the return time has passed, even if the snapshot has not caught up', () => {
    const late = new Date('2026-11-11T05:20:00.000Z').getTime();
    expect(availabilityLine(awayAvailability({ overdue: false }), 'You', late)).toContain('longer than expected');
    expect(availabilityLine(awayAvailability({ overdue: true }), 'You', NOW.getTime())).toContain('longer than expected');
  });

  it('says there is no return time when none was given', () => {
    expect(availabilityLine(awayAvailability({ expectedBackAt: null }), 'You')).toContain('no return time set');
  });

  it('words the unavailable state for the doctor and for reception', () => {
    const gone = { ...AVAILABLE, state: 'unavailable' as const, since: '2026-11-11T05:00:00.000Z' };
    expect(availabilityLine(gone, 'You')).toBe('You are unavailable for the rest of this session · since 10:30 am');
    expect(availabilityLine(gone, 'Dr. Arvind Kulkarni')).toContain('Dr. Arvind Kulkarni is unavailable for the rest of this session');
  });

  it('builds the waiting-room sentences from the display availability', () => {
    expect(displayBannerText(awayAvailability(), 'Dr. Meenakshi Rao', NOW.getTime())).toBe('Dr. Meenakshi Rao is temporarily away, expected back about 10:45 am');
    expect(displayBannerText(awayAvailability({ overdue: true }), 'Dr. Meenakshi Rao')).toBe('Dr. Meenakshi Rao is away and will be back shortly');
    expect(displayBannerText(awayAvailability({ expectedBackAt: null }), 'Dr. Meenakshi Rao')).toBe('Dr. Meenakshi Rao is temporarily away');
    expect(displayBannerText(AVAILABLE, 'Dr. Meenakshi Rao')).toBeNull();
    expect(doctorNameOnly('Dr. Farah Siddiqui, ENT')).toBe('Dr. Farah Siddiqui');
  });

  it('refuses a return time that is not in the future or is after the session end', () => {
    expect(returnProblem(new Date('2026-11-11T04:30:00.000Z'), NOW, ENDS)).toBe('not_future');
    expect(returnProblem(new Date('2026-11-11T08:00:00.000Z'), NOW, ENDS)).toBe('after_end');
    expect(returnProblem(new Date('2026-11-11T05:00:00.000Z'), NOW, ENDS)).toBeNull();
  });

  it('explains DOCTOR_OCCUPIED and the end-of-session refusal in plain words', () => {
    const occupied = new ApiRequestError({ status: 409, code: 'DOCTOR_OCCUPIED', message: 'x' });
    expect(availabilityError(occupied, 'step-away', 'doctor')).toMatch(/called and has not started yet. Start that visit or skip the patient first/);
    expect(availabilityError(occupied, 'step-away', 'reception')).toMatch(/The doctor needs to start the visit or skip the patient/);
    const late = new ApiRequestError({ status: 400, code: 'VALIDATION_FAILED', message: 'until after end' });
    expect(availabilityError(late, 'step-away')).toMatch(/before the session ends/);
  });
});

describe('AvailabilityStrip', () => {
  it('shows the away status with its reason and the actions passed in', () => {
    render(
      <AvailabilityStrip availability={awayAvailability()} who="You">
        <button>I&apos;m back</button>
      </AvailabilityStrip>,
    );
    const strip = screen.getByTestId('availability-strip');
    expect(strip).toHaveTextContent('You are away · since 10:30 am · expected back about 10:45 am');
    expect(strip).toHaveTextContent('Reason: Ward round');
    expect(within(strip).getByRole('button', { name: "I'm back" })).toBeVisible();
  });

  it('is urgent, and says patients were told, when the doctor is unavailable', () => {
    render(<AvailabilityStrip availability={{ ...AVAILABLE, state: 'unavailable', since: '2026-11-11T05:00:00.000Z', reason: 'Emergency theatre' }} who="Dr. Rao" />);
    const strip = screen.getByTestId('availability-strip');
    expect(strip.className).toContain('border-l-priority');
    expect(strip).toHaveTextContent('Waiting and booked patients have been told');
  });

  it('renders nothing for an available doctor', () => {
    const { container } = render(<AvailabilityStrip availability={AVAILABLE} who="You" />);
    expect(container).toBeEmptyDOMElement();
  });
});

describe('StepAwayDialog', () => {
  const renderDialog = (props: Partial<Parameters<typeof StepAwayDialog>[0]> = {}) => {
    const onSubmit = vi.fn();
    render(
      <StepAwayDialog
        open
        onOpenChange={vi.fn()}
        pending={false}
        error={null}
        subject="you"
        sessionDate="2026-11-11"
        sessionEndsAt={ENDS}
        current={AVAILABLE}
        onSubmit={onSubmit}
        {...props}
      />,
    );
    return onSubmit;
  };

  it('offers the four reasons and the 10, 15, 30 and 60 minute presets plus a custom time', () => {
    renderDialog();
    for (const r of ['Ward round / emergency', 'Break', 'Meeting', 'Other']) expect(screen.getByRole('radio', { name: r })).toBeVisible();
    for (const m of ['10 min', '15 min', '30 min', '60 min', 'Custom time']) expect(screen.getByRole('button', { name: m })).toBeVisible();
  });

  it('computes "Back about" from the preset and sends it with the reason', async () => {
    const user = userEvent.setup();
    const onSubmit = renderDialog();
    expect(screen.getByTestId('back-about')).toHaveTextContent('Back about 10:20 am');
    await user.click(screen.getByRole('button', { name: '30 min' }));
    expect(screen.getByTestId('back-about')).toHaveTextContent('Back about 10:35 am');
    await user.click(screen.getByRole('radio', { name: 'Meeting' }));
    await user.click(screen.getByRole('button', { name: 'Step away' }));
    expect(onSubmit).toHaveBeenCalledWith({ until: '2026-11-11T05:05:00.000Z', reason: 'Meeting' });
  });

  it('needs written text of at least 3 characters for Other', async () => {
    const user = userEvent.setup();
    const onSubmit = renderDialog();
    await user.click(screen.getByRole('radio', { name: 'Other' }));
    await user.type(screen.getByLabelText('Other reason'), 'Hi');
    await user.click(screen.getByRole('button', { name: 'Step away' }));
    expect(screen.getByText('Write the reason, at least 3 characters.')).toBeVisible();
    expect(onSubmit).not.toHaveBeenCalled();
    await user.type(screen.getByLabelText('Other reason'), ' there');
    await user.click(screen.getByRole('button', { name: 'Step away' }));
    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ reason: 'Hi there' }));
  });

  it('takes a custom time in India time and refuses one after the session ends', async () => {
    const user = userEvent.setup();
    const onSubmit = renderDialog();
    await user.click(screen.getByRole('button', { name: 'Custom time' }));
    await user.type(screen.getByLabelText('Back at (India time)'), '1330');
    expect(screen.getByText(/The session ends at 1:00 pm/)).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Step away' }));
    expect(onSubmit).not.toHaveBeenCalled();

    const input = screen.getByLabelText('Back at (India time)');
    await user.clear(input);
    await user.type(input, '1045');
    expect(screen.getByTestId('back-about')).toHaveTextContent('Back about 10:45 am');
    await user.click(screen.getByRole('button', { name: 'Step away' }));
    expect(onSubmit).toHaveBeenCalledWith({ until: '2026-11-11T05:15:00.000Z', reason: 'Ward round / emergency' });
  });

  it('changes the return time when already away', () => {
    renderDialog({ current: awayAvailability() });
    expect(screen.getByRole('heading', { name: 'Change return time' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Update return time' })).toBeVisible();
    // The earlier reason is kept.
    expect(screen.getByRole('radio', { name: 'Other' })).toBeChecked();
  });

  it('shows the refusal inside the dialog and keeps it open', () => {
    renderDialog({ error: 'A patient has been called and has not started yet.' });
    expect(screen.getByRole('alert')).toHaveTextContent('A patient has been called and has not started yet.');
  });

  it('can be completed with the keyboard alone', async () => {
    const user = userEvent.setup();
    const onSubmit = renderDialog();
    // Focus lands in the dialog; Tab reaches the reasons, presets and the submit button, and Enter submits.
    await user.tab();
    expect(screen.getByRole('dialog')).toContainElement(document.activeElement as HTMLElement);
    for (let i = 0; i < 12 && !(document.activeElement instanceof HTMLButtonElement && document.activeElement.textContent === '10 min'); i++) await user.tab();
    expect(document.activeElement).toHaveTextContent('10 min');
    await user.keyboard('{Enter}');
    expect(screen.getByTestId('back-about')).toHaveTextContent('Back about 10:15 am');
    await user.keyboard('{Enter}');
    expect(onSubmit).not.toHaveBeenCalled();
    while (!(document.activeElement instanceof HTMLButtonElement && document.activeElement.textContent === 'Step away')) await user.tab();
    await user.keyboard('{Enter}');
    expect(onSubmit).toHaveBeenCalledWith({ until: '2026-11-11T04:45:00.000Z', reason: 'Ward round / emergency' });
  });
});

describe('UnavailableDialog', () => {
  it('states what will happen, asks for a reason and names the action on the button', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(<UnavailableDialog open onOpenChange={vi.fn()} pending={false} error={null} subject="you" onSubmit={onSubmit} />);
    expect(screen.getByText('Patients waiting and booked for this session will be told and offered other doctors. This cannot be undone.')).toBeVisible();
    const confirm = screen.getByRole('button', { name: 'Mark unavailable and notify patients' });
    await user.click(confirm);
    expect(screen.getByText('Give a reason of at least 3 characters.')).toBeVisible();
    expect(onSubmit).not.toHaveBeenCalled();
    await user.type(screen.getByLabelText('Reason'), 'Called to emergency theatre');
    await user.click(confirm);
    expect(onSubmit).toHaveBeenCalledWith('Called to emergency theatre');
  });
});
