import type { QueueEntry } from '@hqms/contracts';
import { GroupTag, TokenText } from '@/components/queue';
import { Button } from '@/components/ui/button';
import { formatLocalDate, istDate } from '@/lib/dates';
import type { CreatedFollowUp } from './FollowUpDialog';

/** What the doctor sees once a follow-up exists: the title and due day, no link. */
export function FollowUpConfirmation({ created }: { created: CreatedFollowUp }) {
  return (
    <p data-testid="followup-confirmation" className="mt-3 rounded-md border border-l-[3px] border-rule border-l-done bg-surface px-3 py-2">
      <span className="font-bold text-done">Follow-up created.</span> {created.title}, due {formatLocalDate(istDate(created.dueAt))}.
    </p>
  );
}

/**
 * The patient the doctor has just completed stays on screen until the next call, so a follow-up can still be created for them
 * after Complete (PR-32).
 */
export function JustCompleted({ entry, created, onFollowUp }: { entry: QueueEntry; created: CreatedFollowUp | undefined; onFollowUp: () => void }) {
  return (
    <section aria-label="Just completed" className="rounded-xl border border-l-[6px] border-rule border-l-done bg-surface p-4">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <h2 className="text-lg font-bold">Just completed</h2>
        <TokenText token={entry.token} size="md" priority={entry.priorityClass !== null} />
        <GroupTag group={entry.group} />
        <p className="min-w-0 flex-1 truncate font-bold">{entry.patientName}</p>
        <Button variant="outline" onClick={onFollowUp}>
          Create follow-up
        </Button>
      </div>
      {created ? <FollowUpConfirmation created={created} /> : <p className="mt-2 text-sm text-muted-foreground">This stays here until you call the next patient.</p>}
    </section>
  );
}
