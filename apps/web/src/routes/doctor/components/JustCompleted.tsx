import type { QueueEntry } from '@hqms/contracts';
import { GroupTag, TokenText } from '@/components/queue';
import { Button } from '@/components/ui/button';
import { formatLocalDate, istDate } from '@/lib/dates';
import type { CreatedFollowUp } from './FollowUpDialog';

/** What the doctor sees once follow-ups exist for this visit: each title and due day, no link. */
export function FollowUpConfirmation({ created }: { created: CreatedFollowUp[] }) {
  return (
    <div
      data-testid="followup-confirmation"
      className="mt-3 rounded-md border border-l-[3px] border-rule border-l-done bg-surface px-3 py-2"
    >
      <p className="font-bold text-done">
        {created.length === 1 ? 'Follow-up created' : `${created.length} follow-ups created`}
      </p>
      <ul>
        {created.map((c, i) => (
          <li key={i}>
            {c.title}, due {formatLocalDate(istDate(c.dueAt))}
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * The patient the doctor has just completed stays on screen until the next call, so a follow-up can still be created for them
 * after Complete (PR-32).
 */
export function JustCompleted({
  entry,
  created,
  onFollowUp,
}: {
  entry: QueueEntry;
  created: CreatedFollowUp[];
  onFollowUp: () => void;
}) {
  return (
    <section
      aria-label="Just completed"
      className="rounded-xl border border-l-[6px] border-rule border-l-done bg-surface p-4"
    >
      <h2 className="text-lg font-bold">Just completed</h2>
      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-2">
        <TokenText token={entry.token} size="md" priority={entry.priorityClass !== null} />
        <GroupTag group={entry.group} />
        <p className="min-w-0 flex-1 basis-40 font-bold">{entry.patientName}</p>
        <Button variant="outline" onClick={onFollowUp}>
          Create follow-up
        </Button>
      </div>
      {created.length > 0 ? (
        <FollowUpConfirmation created={created} />
      ) : (
        <p className="mt-2 text-sm text-muted-foreground">This stays here until you call the next patient.</p>
      )}
    </section>
  );
}
