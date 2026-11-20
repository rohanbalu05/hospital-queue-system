import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { Eta, SessionAvailability } from '@hqms/contracts';
import { availabilityWords, type Placement } from '@/lib/availability';
import { cn } from '@/lib/utils';

/** How long "Dr X is back" stays on screen after the doctor returns. */
export const BACK_NOTICE_MS = 30_000;

/** True for a short while after the state moves from away to available while this screen is open. */
export function useBackNotice(state: SessionAvailability['state'] | undefined): boolean {
  const previous = useRef<SessionAvailability['state'] | undefined>(state);
  const [show, setShow] = useState(false);
  useEffect(() => {
    const was = previous.current;
    previous.current = state;
    if (was === 'away' && state === 'available') {
      setShow(true);
      const t = setTimeout(() => setShow(false), BACK_NOTICE_MS);
      return () => clearTimeout(t);
    }
    if (state !== 'available') setShow(false);
    return undefined;
  }, [state]);
  return show;
}

/** Tone is a word and an edge weight, never colour alone, and none of them is red: red belongs to clinical priority. */
const TONE = {
  info: { edge: 'border-l-[3px] border-l-rule', word: null },
  warning: { edge: 'border-l-[3px] border-l-ink', word: 'Heads up' },
  urgent: { edge: 'border-l-[6px] border-l-ink', word: 'Action needed' },
} as const;

interface AvailabilityBannerProps {
  availability: SessionAvailability;
  doctorName: string;
  /** booked: has not arrived yet. in_queue: checked in or in the visit. */
  placement: Placement;
  /** The patient's own ETA, to show the updated wait while the doctor is away. */
  eta?: Eta | null;
  /** Buttons that go with the message (rebook, cancel). */
  actions?: ReactNode;
  className?: string;
}

/**
 * One banner for the doctor's availability on Today and My visit. Away keeps the place and shows the updated wait;
 * unavailable is urgent and says what to do next. Available shows nothing, apart from a short "is back" confirmation.
 */
export function AvailabilityBanner({ availability, doctorName, placement, eta, actions, className }: AvailabilityBannerProps) {
  const back = useBackNotice(availability.state);
  const words = availabilityWords(availability, doctorName, placement, eta);

  if (!words) {
    if (!back) return null;
    return (
      <p role="status" data-testid="availability-banner" data-state="back" className={cn('rounded-md border border-l-[3px] border-rule border-l-done bg-surface px-4 py-3', className)}>
        <span className="font-bold">{doctorName} is back.</span> Your visit continues from your place in the queue.
      </p>
    );
  }

  const tone = TONE[words.tone];
  return (
    <section
      role={words.tone === 'urgent' ? 'alert' : 'status'}
      data-testid="availability-banner"
      data-state={availability.state}
      className={cn('rounded-xl border border-rule bg-surface px-4 py-4', tone.edge, className)}
    >
      {tone.word ? (
        <p className={cn('mb-2 inline-block rounded-xs px-1.5 py-0.5 text-sm font-bold', words.tone === 'urgent' ? 'bg-ink text-white' : 'border border-ink text-ink')}>
          {tone.word}
        </p>
      ) : null}
      <h2 className="text-lg font-bold">{words.title}</h2>
      {words.lines.map((line) => (
        <p key={line} className="mt-1">
          {line}
        </p>
      ))}
      {actions ? <div className="mt-4 flex flex-col gap-3 sm:flex-row">{actions}</div> : null}
    </section>
  );
}
