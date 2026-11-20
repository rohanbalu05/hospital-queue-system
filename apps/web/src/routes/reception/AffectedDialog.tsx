import { useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import type { AffectedPatients, AlternativeSession, MoveAffectedResult } from '@hqms/contracts';
import { useAffectedPatients, useMoveAffected } from '@/api/queue';
import { ErrorState, GroupTag, SkeletonRows, TokenText } from '@/components/queue';
import { InlineAlert } from '@/components/scheduling/status';
import { sessionLabelWord, sessionTimes } from '@/components/scheduling/sessions';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { useQueueSnapshot } from '@/live/useQueue';
import { ApiRequestError } from '@/lib/api';
import { formatIST } from '@/lib/format';
import { istDate } from '@/lib/dates';
import { cn } from '@/lib/utils';

const apptKey = (id: string) => `a:${id}`;
const entryKey = (id: string) => `q:${id}`;

const ENTRY_STATE_WORD = { waiting: 'Waiting', skipped: 'Skipped', absent: 'Absent' } as const;

/** Server reason codes for a patient who was not moved, in words the desk can say to the patient. */
function skipWords(code: string | null, message: string | null, target: string): string {
  if (code === 'CAPACITY_FULL') return `No place left in ${target}'s session`;
  if (message) return message;
  if (code === 'CONFLICT' || code === 'INVALID_TRANSITION') return 'Their status changed, so they were left where they are';
  return 'Could not be moved';
}

interface Moved {
  result: MoveAffectedResult;
  targetDoctor: string;
  /** Names by source id, captured before the move so they survive the refetch. */
  names: Map<string, string>;
}

function moveFailure(err: unknown): string {
  if (err instanceof ApiRequestError) {
    if (err.code === 'FORBIDDEN') return 'You are not assigned to both doctors, so you cannot move patients between them. Ask an admin.';
    if (err.code === 'NETWORK') return 'Cannot reach the server. Nobody was moved. Check the connection and press the button again; the same request is sent, so nobody is moved twice.';
    return err.message;
  }
  return 'Something went wrong. Nobody was moved. Try again.';
}

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  sessionId: string;
}

/**
 * Affected patients (B3): when the doctor is away or unavailable, reception chooses patients, chooses another
 * doctor's session and moves them. Capacity rules live on the server; this screen shows the places it reports and then
 * shows, patient by patient, who moved and who could not be.
 */
export function AffectedDialog({ open, onOpenChange, sessionId }: Props) {
  const q = useAffectedPatients(sessionId, open, { fresh: true });
  // The board keeps this snapshot live over SSE. A newer queue version while the dialog is open means the list may have changed
  // (a patient rebooked, arrived or was moved), so the list is fetched again.
  const queueVersion = useQueueSnapshot(open ? sessionId : null).data?.queueVersion;
  const seenVersion = useRef<number | undefined>(undefined);
  const refetchAffected = q.refetch;
  useEffect(() => {
    if (!open) {
      seenVersion.current = undefined;
      return;
    }
    if (queueVersion === undefined) return;
    if (seenVersion.current !== undefined && seenVersion.current !== queueVersion) void refetchAffected();
    seenVersion.current = queueVersion;
  }, [open, queueVersion, refetchAffected]);
  const move = useMoveAffected(sessionId);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [targetId, setTargetId] = useState<string | null>(null);
  const [done, setDone] = useState<Moved | null>(null);

  useEffect(() => {
    if (open) {
      setPicked(new Set());
      setTargetId(null);
      setDone(null);
      move.reset();
    }
  }, [open]);

  const data = q.data;
  const allKeys = useMemo(() => (data ? [...data.inQueue.map((e) => entryKey(e.queueEntryId)), ...data.notArrived.map((a) => apptKey(a.appointmentId))] : []), [data]);
  // Patients who left the lists (moved, cancelled, arrived) drop out of the selection.
  const live = useMemo(() => new Set(allKeys), [allKeys]);
  const chosen = [...picked].filter((k) => live.has(k));
  const target = data?.alternatives.find((a) => a.sessionId === targetId) ?? null;

  const toggle = (key: string, on: boolean) =>
    setPicked((prev) => {
      const next = new Set(prev);
      if (on) next.add(key);
      else next.delete(key);
      return next;
    });
  const setAll = (on: boolean) => setPicked(on ? new Set(allKeys) : new Set());

  function submit() {
    if (!data || !target || chosen.length === 0) return;
    const names = new Map<string, string>();
    for (const e of data.inQueue) names.set(e.queueEntryId, e.patientName);
    for (const a of data.notArrived) names.set(a.appointmentId, a.patientName);
    const targetDoctor = target.doctorName;
    move.mutate(
      {
        targetSessionId: target.sessionId,
        queueEntryIds: data.inQueue.filter((e) => picked.has(entryKey(e.queueEntryId))).map((e) => e.queueEntryId),
        appointmentIds: data.notArrived.filter((a) => picked.has(apptKey(a.appointmentId))).map((a) => a.appointmentId),
      },
      {
        onSuccess: (result) => {
          setDone({ result, targetDoctor, names });
          setPicked(new Set());
          toast.success(result.skipped === 0 ? `Moved ${result.moved} to ${targetDoctor}` : `Moved ${result.moved}, ${result.skipped} not moved`);
        },
      },
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[92dvh] overflow-y-auto sm:max-w-3xl" aria-describedby="affected-desc">
        <DialogHeader>
          <DialogTitle>Affected patients{data ? `, ${data.doctorName}` : ''}</DialogTitle>
          <DialogDescription id="affected-desc">
            Choose who to move and which doctor takes them. Each patient is told about the change; nobody is moved without you choosing.
          </DialogDescription>
        </DialogHeader>

        {q.isPending ? (
          <SkeletonRows count={6} />
        ) : !data ? (
          <ErrorState title="The affected patients could not be loaded" error={q.error} onRetry={() => void q.refetch()} />
        ) : done ? (
          <Results done={done} onBack={() => setDone(null)} onClose={() => onOpenChange(false)} />
        ) : allKeys.length === 0 ? (
          <div className="rounded-md border border-rule bg-surface px-4 py-6">
            <p className="font-bold">No one is affected</p>
            <p className="mt-1 text-muted-foreground">Nobody is booked for this session who has not arrived, and nobody is waiting in its queue.</p>
          </div>
        ) : (
          <div className="grid gap-5">
            {q.isRefetchError ? <InlineAlert title="The list may be out of date">The last refresh failed. Check the lists before you move anyone.</InlineAlert> : null}

            <div className="flex items-center gap-3 rounded-md border border-rule bg-paper px-3 py-2">
              <Checkbox
                id="affected-all"
                checked={chosen.length === allKeys.length ? true : chosen.length > 0 ? 'indeterminate' : false}
                onCheckedChange={(v) => setAll(v === true)}
              />
              <Label htmlFor="affected-all" className="flex-1 cursor-pointer">
                Select all
              </Label>
              <span className="text-muted-foreground tabular-nums" data-testid="affected-count">
                {chosen.length} of {allKeys.length} selected
              </span>
            </div>

            <PatientList title="In the queue" count={data.inQueue.length} empty="Nobody has checked in yet.">
              {data.inQueue.map((e) => {
                const key = entryKey(e.queueEntryId);
                const id = `affected-${key}`;
                return (
                  <li key={key} className="flex min-h-12 items-center gap-3 px-3 py-1.5">
                    <Checkbox id={id} checked={picked.has(key)} onCheckedChange={(v) => toggle(key, v === true)} />
                    <Label htmlFor={id} className="flex min-w-0 flex-1 cursor-pointer flex-wrap items-center gap-x-3 gap-y-0.5 font-normal">
                      <GroupTag group={e.group} />
                      <TokenText token={e.token} size="md" />
                      <span className="min-w-0 flex-1 truncate font-bold">{e.patientName}</span>
                      <span className="text-muted-foreground">{ENTRY_STATE_WORD[e.state]}</span>
                    </Label>
                  </li>
                );
              })}
            </PatientList>

            <PatientList title="Booked, not arrived" count={data.notArrived.length} empty="Everyone booked has arrived.">
              {data.notArrived.map((a) => {
                const key = apptKey(a.appointmentId);
                const id = `affected-${key}`;
                return (
                  <li key={key} className="flex min-h-12 items-center gap-3 px-3 py-1.5">
                    <Checkbox id={id} checked={picked.has(key)} onCheckedChange={(v) => toggle(key, v === true)} />
                    <Label htmlFor={id} className="flex min-w-0 flex-1 cursor-pointer flex-wrap items-center gap-x-3 gap-y-0.5 font-normal">
                      <span className="w-[4.25rem] shrink-0 font-bold tabular-nums">{formatIST(a.scheduledAt)}</span>
                      <span className="min-w-0 flex-1 truncate font-bold">{a.patientName}</span>
                      <span className="text-muted-foreground tabular-nums">{a.patientPhone ?? 'No phone'}</span>
                      <span className="w-20 shrink-0 text-right text-muted-foreground">Has app: {a.hasLogin ? 'yes' : 'no'}</span>
                    </Label>
                  </li>
                );
              })}
            </PatientList>

            <fieldset className="grid gap-2">
              <legend className="mb-1 font-bold">Move to</legend>
              {data.alternatives.length === 0 ? (
                <p className="rounded-md border border-rule bg-surface px-3 py-3 text-muted-foreground">
                  No other {data.department} doctor has a session with room today. Tell the patients to rebook for another day, or ask an admin to open a session.
                </p>
              ) : (
                <RadioGroup value={targetId ?? ''} onValueChange={setTargetId} className="gap-0 overflow-hidden rounded-md border border-rule bg-surface divide-y divide-rule" aria-label="Target session">
                  {data.alternatives.map((alt) => (
                    <Alternative key={alt.sessionId} alt={alt} selected={alt.sessionId === targetId} />
                  ))}
                </RadioGroup>
              )}
              <p className="text-sm text-muted-foreground">
                Appointment patients take a booked place and walk-in patients take a walk-in place. When a session is full, the rest are not moved and you will see who.
              </p>
            </fieldset>

            {move.isError ? <InlineAlert title="Nobody was moved">{moveFailure(move.error)}</InlineAlert> : null}

            <DialogFooter className="gap-2">
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
                Close
              </Button>
              <Button type="button" disabled={move.isPending || chosen.length === 0 || !target} onClick={submit}>
                {move.isPending
                  ? 'Moving…'
                  : target
                    ? `Move ${chosen.length} ${chosen.length === 1 ? 'patient' : 'patients'} to ${target.doctorName}`
                    : 'Choose a doctor to move to'}
              </Button>
            </DialogFooter>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

function PatientList({ title, count, empty, children }: { title: string; count: number; empty: string; children: React.ReactNode }) {
  return (
    <section aria-label={title} className="overflow-hidden rounded-md border border-rule bg-surface">
      <header className="flex h-10 items-center border-b border-rule px-3">
        <h3 className="font-bold">{title}</h3>
        <span className="ml-auto text-muted-foreground tabular-nums">{count}</span>
      </header>
      {count > 0 ? <ul className="divide-y divide-rule">{children}</ul> : <p className="px-3 py-3 text-muted-foreground">{empty}</p>}
    </section>
  );
}

function Alternative({ alt, selected }: { alt: AlternativeSession; selected: boolean }) {
  const id = `alt-${alt.sessionId}`;
  const today = alt.sessionDate === istDate();
  return (
    <div className={cn('flex min-h-14 items-start gap-3 px-3 py-2', selected && 'bg-secondary')}>
      <RadioGroupItem id={id} value={alt.sessionId} className="mt-0.5" />
      <Label htmlFor={id} className="grid flex-1 cursor-pointer gap-0.5 font-normal">
        <span className="font-bold">
          {alt.doctorName}, {alt.department}
          <span className="font-normal text-muted-foreground"> · {alt.room}</span>
        </span>
        <span className="tabular-nums">
          {today ? 'Today' : formatIST(alt.startsAt, 'weekday-date')}, {sessionLabelWord(alt)} {sessionTimes(alt)}
        </span>
        <span className="text-muted-foreground tabular-nums">
          {alt.bookedAvailable} booked {alt.bookedAvailable === 1 ? 'place' : 'places'} free, {alt.walkinAvailable} walk-in {alt.walkinAvailable === 1 ? 'place' : 'places'} free
          {alt.nextSlotAt ? `, next slot ${formatIST(alt.nextSlotAt)}` : ', no slot left'}
        </span>
      </Label>
    </div>
  );
}

function Results({ done, onBack, onClose }: { done: Moved; onBack: () => void; onClose: () => void }) {
  const { result, targetDoctor, names } = done;
  return (
    <div className="grid gap-4" data-testid="move-results">
      <div role="status">
        <p className="text-lg font-bold">
          {result.moved} moved to {targetDoctor}
          {result.skipped > 0 ? `, ${result.skipped} not moved` : ''}
        </p>
        <p className="text-muted-foreground">Every patient who moved has been told. Patients who were not moved stay with their original doctor.</p>
      </div>
      <ul className="divide-y divide-rule overflow-hidden rounded-md border border-rule bg-surface">
        {result.results.map((r) => {
          const moved = r.outcome === 'moved';
          return (
            <li key={`${r.kind}-${r.sourceId}`} data-outcome={r.outcome} className={cn('flex min-h-12 flex-wrap items-center gap-x-3 gap-y-0.5 border-l-[3px] px-3 py-1.5', moved ? 'border-l-done' : 'border-l-priority')}>
              <span className={cn('w-20 shrink-0 font-bold', moved ? 'text-done' : 'text-priority')}>{moved ? 'Moved' : 'Not moved'}</span>
              <span className="min-w-0 flex-1 truncate font-bold">{names.get(r.sourceId) ?? 'Patient'}</span>
              <span className="tabular-nums">
                {moved
                  ? r.token
                    ? `New token ${r.token}`
                    : r.scheduledAt
                      ? `New time ${formatIST(r.scheduledAt)}`
                      : 'Moved'
                  : skipWords(r.code, r.message, targetDoctor)}
              </span>
            </li>
          );
        })}
      </ul>
      <DialogFooter className="gap-2">
        {result.skipped > 0 ? (
          <Button type="button" variant="outline" onClick={onBack}>
            Back to the list
          </Button>
        ) : null}
        <Button type="button" onClick={onClose}>
          Done
        </Button>
      </DialogFooter>
    </div>
  );
}

export type { AffectedPatients };
