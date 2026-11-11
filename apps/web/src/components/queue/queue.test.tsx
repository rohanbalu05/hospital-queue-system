import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { CapacityBar, DecisionReason, GroupTag, PressureNote, QueueRow, StaleBanner, deriveLiveStatus } from './index';

describe('GroupTag', () => {
  it.each([
    ['A', 'Appointment', 'text-appt'],
    ['W', 'Walk-in', 'text-walkin'],
    ['P', 'Priority', 'text-priority'],
  ] as const)('%s shows its letter, is named for screen readers, and uses its colour', (group, name, colour) => {
    const { container } = render(<GroupTag group={group} />);
    const tag = container.querySelector(`[data-group="${group}"]`);
    expect(tag).not.toBeNull();
    expect(tag?.textContent).toContain(group);
    expect(tag?.textContent).toContain(name);
    expect(tag?.className).toContain(colour);
    expect(tag?.className).toContain('bg-');
    expect(tag?.className).toContain('/10');
  });

  it('can print the word beside the letter', () => {
    render(<GroupTag group="W" showName />);
    expect(screen.getByText('Walk-in')).toBeVisible();
  });
});

describe('QueueRow', () => {
  it('gives a priority row the priority edge and a P tag, keeping the original token', () => {
    const { container } = render(
      <ul>
        <QueueRow token="A-015" group="A" priority title="Lakshmi Narayanan" />
      </ul>,
    );
    expect(container.querySelector('.border-l-priority')).not.toBeNull();
    expect(container.querySelector('[data-group="P"]')).not.toBeNull();
    expect(screen.getByText('A-015')).toBeInTheDocument();
  });

  it('is a keyboard-operable button when selectable', () => {
    render(
      <ul>
        <QueueRow token="W-005" group="W" title="Mohammed Irfan" onSelect={() => undefined} />
      </ul>,
    );
    expect(screen.getByRole('button', { name: /W-005/ })).toBeInTheDocument();
  });
});

describe('CapacityBar', () => {
  it('prints booked x/10 and walk-in y/5 in text', () => {
    render(<CapacityBar booked={7} bookedCapacity={10} walkin={2} walkinCapacity={5} />);
    expect(screen.getByText('Booked').parentElement).toHaveTextContent('7/10');
    expect(screen.getByText('Walk-in').parentElement).toHaveTextContent('2/5');
  });
});

describe('DecisionReason', () => {
  it('shows the explanation in the reason colour, without a second label repeating it', () => {
    const { container } = render(<DecisionReason reason="AGING" explanation="Aging: waited 47 min" />);
    expect(screen.getByText('Aging: waited 47 min')).toHaveClass('text-aging');
    expect(container.querySelectorAll('p')).toHaveLength(1);
    expect(container.querySelector('[data-reason="AGING"]')).toHaveClass('border-l-aging');
  });
});

describe('PressureNote', () => {
  it('renders nothing when the workload is normal', () => {
    const { container } = render(<PressureNote pressure={{ level: 'normal', reasons: [] }} />);
    expect(container).toBeEmptyDOMElement();
  });

  it.each([
    ['high', 'Workload: High'],
    ['overloaded', 'Workload: Overloaded'],
  ] as const)('%s: bold ink words, the reasons as a list, an ink edge and no red', (level, words) => {
    render(<PressureNote pressure={{ level, reasons: ['9 patients are waiting for 5 hours of sessions', 'A-014 has waited 52 min'] }} />);
    const note = screen.getByTestId('pressure-note');
    expect(note).toHaveAttribute('data-level', level);
    expect(note).toHaveClass('border-l-ink');
    expect(note.className).not.toContain('priority');
    const heading = screen.getByText(words);
    expect(heading).toHaveClass('font-bold', 'text-ink');
    expect(screen.getAllByRole('listitem')).toHaveLength(2);
  });

  it('shows just the level when the server gives no reasons', () => {
    render(<PressureNote pressure={{ level: 'high', reasons: [] }} />);
    expect(screen.getByText('Workload: High')).toBeInTheDocument();
    expect(screen.queryByRole('list')).toBeNull();
  });
});

describe('StaleBanner', () => {
  it('shows the last-updated time in IST when live', () => {
    render(<StaleBanner status="live" lastUpdated="2026-11-11T05:12:08Z" />);
    expect(screen.getByRole('status')).toHaveTextContent('Last updated 10:42:08 am');
  });

  it('shows Reconnecting… when stale', () => {
    render(<StaleBanner status="reconnecting" lastUpdated="2026-11-11T05:12:08Z" />);
    expect(screen.getByRole('status')).toHaveTextContent('Reconnecting…');
  });

  it('derives reconnecting only after 5 s of disconnect', () => {
    expect(deriveLiveStatus(null, 10_000)).toBe('live');
    expect(deriveLiveStatus(1_000, 5_000)).toBe('live');
    expect(deriveLiveStatus(1_000, 6_001)).toBe('reconnecting');
  });
});
