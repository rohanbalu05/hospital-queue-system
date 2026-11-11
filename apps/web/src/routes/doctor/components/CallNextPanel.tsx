import type { Ref } from 'react';
import type { QueueDecision, StaffQueueSnapshot } from '@hqms/contracts';
import { DecisionReason } from '@/components/queue';
import { Button } from '@/components/ui/button';
import { formatIST } from '@/lib/format';
import { cn } from '@/lib/utils';

interface CallNextPanelProps {
  snapshot: StaffQueueSnapshot;
  /** The decision to explain: the newest of the call just made and the snapshot's last decision. */
  decision: QueueDecision | null;
  blockedReason: string | null;
  calling: boolean;
  buttonRef: Ref<HTMLButtonElement>;
  onCall: () => void;
}

/** Call next, why it is blocked when it is, and the reason for the last call in plain words. */
export function CallNextPanel({ snapshot, decision, blockedReason, calling, buttonRef, onCall }: CallNextPanelProps) {
  const blocked = blockedReason !== null || calling;
  const { rotation, rotationPointer } = snapshot;
  const nextSlot = rotation.length > 0 ? rotation[rotationPointer % rotation.length] : undefined;

  return (
    <section aria-labelledby="call-heading" className="rounded-xl border border-rule bg-surface p-5">
      <h2 id="call-heading" className="sr-only">
        Call next
      </h2>
      <Button
        ref={buttonRef}
        size="lg"
        className={cn('h-14 w-full text-lg aria-disabled:cursor-not-allowed aria-disabled:opacity-50')}
        aria-disabled={blocked}
        aria-describedby={blockedReason ? 'call-blocked' : 'call-hint'}
        aria-keyshortcuts="N"
        onClick={() => !blocked && onCall()}
      >
        {calling ? 'Calling…' : 'Call next'}
        <kbd className="ml-1 rounded-xs bg-white/20 px-1.5 py-0.5 font-sans text-sm" aria-hidden="true">
          N
        </kbd>
      </Button>

      {blockedReason ? (
        <p id="call-blocked" className="mt-2">
          {blockedReason}
        </p>
      ) : (
        <p id="call-hint" className="mt-2 text-sm text-muted-foreground">
          Press N to jump here, then Enter to call.
          {nextSlot ? ` Next rotation slot: ${nextSlot}.` : ''}
        </p>
      )}

      <div className="mt-4" aria-live="polite">
        {decision ? (
          <div data-testid="decision">
            <DecisionReason
              reason={decision.reason}
              explanation={decision.explanation}
              className="[&>p:last-child]:text-lg [&>p:last-child]:leading-6 [&>p:last-child]:font-bold"
            />
            <p className="mt-2 text-sm text-muted-foreground tabular-nums">
              Policy v{decision.policyVersion}
              {decision.token ? `, ${decision.token}` : ''}, decided {formatIST(decision.decidedAt, 'time-seconds')}
            </p>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">
            After each call the reason appears here, for example &ldquo;Called by rotation&rdquo; or &ldquo;Aging: waited 47 min&rdquo;.
          </p>
        )}
      </div>

      <p className="mt-4 border-t border-rule pt-3 text-sm text-muted-foreground tabular-nums">
        Rotation {rotation.join(', ')}. Policy v{snapshot.policyVersion}.
      </p>
    </section>
  );
}
