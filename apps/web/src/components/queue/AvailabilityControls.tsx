import { useState, type ReactNode } from 'react';
import { toast } from 'sonner';
import type { SessionAvailability } from '@hqms/contracts';
import { useImBack, useMarkUnavailable, useStepAway } from '@/api/queue';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { StepAwayDialog, UnavailableDialog } from './AvailabilityDialogs';
import { useNow } from '@/lib/useNow';
import { availabilityError, availabilityWords, isOverdue } from './availability';

type DialogKind = 'away' | 'unavailable' | null;

export interface AvailabilityControlsArgs {
  sessionId: string;
  /** IST date of the session, for the custom return time. */
  sessionDate: string;
  sessionEndsAt: string;
  availability: SessionAvailability;
  /** "you" on the doctor's own screen, otherwise the doctor's name (reception). */
  subject: string;
  role: 'doctor' | 'reception';
}

/** Why Step away is not offered right now, in words, or null when it is. */
export function stepAwayBlock(av: SessionAvailability): string | null {
  switch (av.state) {
    case 'not_started':
      return 'The session has not started yet.';
    case 'unavailable':
      return 'Unavailable for the rest of the session. This cannot be undone.';
    case 'ended':
      return 'The session has ended.';
    default:
      return null;
  }
}

/**
 * Step away, I'm back and Unavailable for the doctor of one session (B1). The same commands, dialogs and plain error
 * words serve the doctor console and the reception board; each screen lays out the buttons itself.
 */
export function useAvailabilityControls(a: AvailabilityControlsArgs) {
  const stepAway = useStepAway(a.sessionId);
  const back = useImBack(a.sessionId);
  const unavailable = useMarkUnavailable(a.sessionId);
  const [dialog, setDialog] = useState<DialogKind>(null);

  const state = a.availability.state;
  const away = state === 'away';
  const live = state === 'available' || state === 'away';

  const open = (kind: Exclude<DialogKind, null>) => {
    stepAway.reset();
    unavailable.reset();
    setDialog(kind);
  };

  const imBack = () =>
    back.mutate(undefined, {
      onSuccess: () => toast.success(a.subject === 'you' ? 'You are back' : `${a.subject} is back`, { description: 'Calling can continue.' }),
      onError: (err) => toast.error("I'm back failed", { description: availabilityError(err, 'back', a.role) }),
    });

  const dialogs: ReactNode = (
    <>
      <StepAwayDialog
        open={dialog === 'away'}
        onOpenChange={(o) => !o && setDialog(null)}
        pending={stepAway.isPending}
        error={stepAway.isError ? availabilityError(stepAway.error, 'step-away', a.role) : null}
        subject={a.subject}
        sessionDate={a.sessionDate}
        sessionEndsAt={a.sessionEndsAt}
        current={a.availability}
        onSubmit={(request) =>
          stepAway.mutate(request, {
            onSuccess: () => {
              toast.success(away ? 'Return time updated' : a.subject === 'you' ? 'Stepped away' : `${a.subject} stepped away`);
              setDialog(null);
            },
          })
        }
      />
      <UnavailableDialog
        open={dialog === 'unavailable'}
        onOpenChange={(o) => !o && setDialog(null)}
        pending={unavailable.isPending}
        error={unavailable.isError ? availabilityError(unavailable.error, 'unavailable', a.role) : null}
        subject={a.subject}
        onSubmit={(reason) =>
          unavailable.mutate(
            { reason },
            {
              onSuccess: () => {
                toast.success('Marked unavailable', { description: 'Waiting and booked patients are being told.' });
                setDialog(null);
              },
            },
          )
        }
      />
    </>
  );

  return {
    state,
    away,
    canStepAway: live,
    canUnavailable: live,
    openStepAway: () => open('away'),
    openUnavailable: () => open('unavailable'),
    imBack,
    backPending: back.isPending,
    dialogs,
  };
}

export type AvailabilityControls = ReturnType<typeof useAvailabilityControls>;

interface StripProps {
  availability: SessionAvailability;
  /** "You" or the doctor's name. */
  who: string;
  /** Buttons that belong with the message (I'm back, Change return time, Affected patients). */
  children?: ReactNode;
  className?: string;
}

/**
 * The status strip for an away or unavailable doctor. Away is a notice in the warning tone; unavailable is urgent.
 * Always says the state in words and, for staff, why. Renders nothing for an available doctor.
 */
export function AvailabilityStrip({ availability, who, children, className }: StripProps) {
  const now = useNow(15_000);
  if (availability.state !== 'away' && availability.state !== 'unavailable') return null;
  const urgent = availability.state === 'unavailable';
  const w = availabilityWords(availability, who, now);
  return (
    <div
      role="status"
      data-testid="availability-strip"
      data-state={availability.state}
      className={cn(
        'flex flex-wrap items-center gap-x-4 gap-y-2 rounded-md border border-l-[6px] px-3 py-2.5',
        urgent ? 'border-priority/40 border-l-priority bg-priority/10' : 'border-walkin/40 border-l-walkin bg-walkin/10',
        className,
      )}
    >
      <div className="min-w-0 flex-1">
        <p className="text-base font-bold">
          {w.headline}
          {w.since ? <span className="font-normal"> · {w.since}</span> : null}
          {w.expected ? <span className={cn(isOverdue(availability, now) ? 'font-bold' : 'font-normal')}> · {w.expected}</span> : null}
        </p>
        {availability.reason ? <p className="text-muted-foreground">Reason: {availability.reason}</p> : null}
        {urgent ? <p className="text-muted-foreground">Waiting and booked patients have been told. Reception moves them to other doctors.</p> : null}
      </div>
      {children ? <div className="flex flex-wrap items-center gap-2">{children}</div> : null}
    </div>
  );
}

/** The three availability buttons in one row, as reception lays them out. */
export function AvailabilityButtons({ controls, className }: { controls: AvailabilityControls; className?: string }) {
  const { state } = controls;
  if (!controls.canStepAway) return null;
  return (
    <div className={cn('flex flex-wrap items-center gap-2', className)}>
      {controls.away ? (
        <Button type="button" onClick={controls.imBack} disabled={controls.backPending}>
          {controls.backPending ? 'Saving…' : "I'm back"}
        </Button>
      ) : null}
      <Button type="button" variant="outline" disabled={!controls.canStepAway} onClick={controls.openStepAway}>
        {controls.away ? 'Change return time' : 'Step away'}
      </Button>
      <Button
        type="button"
        variant="outline"
        className="border-priority/50 text-priority hover:text-priority"
        disabled={!controls.canUnavailable}
        onClick={controls.openUnavailable}
        title={state === 'unavailable' ? 'Already unavailable for the rest of the session' : undefined}
      >
        Unavailable for rest of session
      </Button>
    </div>
  );
}
