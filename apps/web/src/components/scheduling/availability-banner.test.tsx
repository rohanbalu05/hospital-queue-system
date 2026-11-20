import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import type { SessionAvailability } from '@hqms/contracts';
import { AvailabilityBanner, BACK_NOTICE_MS } from './AvailabilityBanner';

afterEach(() => vi.useRealTimers());

const av = (state: SessionAvailability['state'], over: Partial<SessionAvailability> = {}): SessionAvailability => ({
  state,
  since: null,
  expectedBackAt: null,
  overdue: false,
  reason: null,
  ...over,
});

describe('AvailabilityBanner', () => {
  it('renders nothing while the doctor is available', () => {
    const { container } = render(<AvailabilityBanner availability={av('available')} doctorName="Dr. Rao" placement="in_queue" />);
    expect(container).toBeEmptyDOMElement();
  });

  it('away is a status with a "Heads up" word, not an alert', () => {
    render(<AvailabilityBanner availability={av('away', { expectedBackAt: '2026-11-11T05:15:00Z' })} doctorName="Dr. Rao" placement="in_queue" />);
    const banner = screen.getByTestId('availability-banner');
    expect(banner).toHaveAttribute('role', 'status');
    expect(banner).toHaveTextContent('Heads up');
    expect(banner).toHaveTextContent('Dr. Rao has stepped away and is expected back about 10:45 am');
    expect(banner).toHaveTextContent('Your place in the queue is kept.');
  });

  it('unavailable is an alert with its actions', () => {
    render(<AvailabilityBanner availability={av('unavailable')} doctorName="Dr. Rao" placement="booked" actions={<button>Rebook with another doctor</button>} />);
    expect(screen.getByRole('alert')).toHaveTextContent('Action needed');
    expect(screen.getByRole('button', { name: 'Rebook with another doctor' })).toBeInTheDocument();
  });

  it('confirms the return for a short while after away turns into available, then goes quiet', () => {
    vi.useFakeTimers();
    const { rerender } = render(<AvailabilityBanner availability={av('away')} doctorName="Dr. Rao" placement="in_queue" />);
    rerender(<AvailabilityBanner availability={av('available')} doctorName="Dr. Rao" placement="in_queue" />);
    expect(screen.getByTestId('availability-banner')).toHaveTextContent('Dr. Rao is back.');
    act(() => {
      vi.advanceTimersByTime(BACK_NOTICE_MS + 1);
    });
    expect(screen.queryByTestId('availability-banner')).not.toBeInTheDocument();
  });
});
