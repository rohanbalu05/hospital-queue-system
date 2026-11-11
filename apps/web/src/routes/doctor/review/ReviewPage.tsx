import { useState, type ReactNode } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { toast } from 'sonner';
import type { VerifyInstructionRequest } from '@hqms/contracts';
import { API_BASE } from '@/lib/api';
import { useDocumentDrafts, useInstructions, useRetryOcr, useReviewInbox, useVerifyInstruction, type ReviewItem } from '@/api';
import { StaffShell } from '@/components/layout/Shells';
import { EmptyState, ErrorState, SkeletonRows } from '@/components/queue';
import { InlineAlert } from '@/components/scheduling/status';
import { Button } from '@/components/ui/button';
import { fileSizeWord, STAFF_DOCUMENT_STATUS } from '@/lib/followup';
import { formatIST } from '@/lib/format';
import { cn } from '@/lib/utils';
import { InstructionForm, titleFromDraft } from './InstructionForm';
import { InstructionHistory } from './InstructionHistory';

function InboxList({ items, selectedId }: { items: ReviewItem[]; selectedId: string | null }) {
  return (
    <section aria-labelledby="inbox-h" className="overflow-hidden rounded-xl border border-rule bg-surface">
      <header className="flex h-10 items-center gap-2 border-b border-rule px-3">
        <h2 id="inbox-h" className="font-bold">
          Awaiting verification
        </h2>
        <span className="ml-auto text-muted-foreground tabular-nums">{items.length}</span>
      </header>
      <ul className="divide-y divide-rule">
        {items.map((d) => {
          const failed = d.status === 'ocr_failed';
          return (
            <li key={d.id}>
              <Link
                to={`/doctor/review/${d.id}`}
                aria-current={d.id === selectedId ? 'true' : undefined}
                className={cn(
                  'block border-l-[3px] px-3 py-2 outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ink',
                  d.id === selectedId ? 'border-l-ink bg-secondary' : 'border-l-transparent hover:bg-secondary/60',
                )}
              >
                <span className="flex items-baseline gap-2">
                  <span className="min-w-0 flex-1 truncate font-bold">{d.patientName}</span>
                  <span className={cn('shrink-0 text-xs font-bold', failed ? 'text-priority' : 'text-ink')}>{STAFF_DOCUMENT_STATUS[d.status] ?? d.status}</span>
                </span>
                <span className="mt-0.5 block truncate text-muted-foreground">{d.originalName}</span>
                <span className="block text-xs text-muted-foreground tabular-nums">
                  Uploaded {formatIST(d.createdAt, 'date-time')}, {d.pageCount} {d.pageCount === 1 ? 'page' : 'pages'}
                </span>
              </Link>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function Panel({ title, label, children, className }: { title: string; label?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section aria-label={title} className={cn('rounded-xl border border-rule bg-surface', className)}>
      <header className="flex min-h-10 flex-wrap items-center gap-x-3 gap-y-1 border-b border-rule px-3 py-2">
        <h3 className="font-bold">{title}</h3>
        {label}
      </header>
      <div className="p-3">{children}</div>
    </section>
  );
}

function ReviewDetail({ item, onDone }: { item: ReviewItem; onDone: () => void }) {
  const failed = item.status === 'ocr_failed';
  const [manual, setManual] = useState(false);
  const drafts = useDocumentDrafts(failed ? undefined : item.id);
  const instructions = useInstructions(item.patientId);
  const verify = useVerifyInstruction();
  const retry = useRetryOcr();

  const latest = drafts.data && drafts.data.length > 0 ? [...drafts.data].sort((a, b) => a.createdAt.localeCompare(b.createdAt)).at(-1) : undefined;
  const current = (instructions.data ?? []).filter((v) => v.status === 'current');
  const showForm = failed ? manual : latest !== undefined || drafts.isError || (drafts.data !== undefined && drafts.data.length === 0);

  const doVerify = (req: VerifyInstructionRequest) => {
    verify.mutate(
      { documentId: item.id, patientId: item.patientId, ...req },
      {
        onSuccess: (v) => {
          toast.success('Instruction verified', { description: `${v.title}, version ${v.version}` });
          onDone();
        },
      },
    );
  };

  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
        <h2 className="text-lg font-bold">{item.patientName}</h2>
        <p className="text-muted-foreground tabular-nums">
          {item.originalName}, {fileSizeWord(item.sizeBytes)}, {item.pageCount} {item.pageCount === 1 ? 'page' : 'pages'}
        </p>
        <a
          href={`${API_BASE}/documents/${item.id}/file`}
          target="_blank"
          rel="noreferrer"
          className="ml-auto font-bold underline underline-offset-2 focus-visible:rounded-xs"
        >
          Open original document
        </a>
      </div>

      <div className="grid items-start gap-4 xl:grid-cols-2">
        <Panel
          title="OCR draft"
          label={<span className="rounded-xs bg-muted px-1.5 py-0.5 text-xs font-bold text-muted-foreground">Draft, not visible to the patient&apos;s assistant</span>}
        >
          {failed ? (
            <div className="grid gap-3">
              <InlineAlert title="OCR failed">
                {item.lastError ?? 'The text could not be read from this document.'} {item.ocrAttempts > 0 ? `Attempts so far: ${item.ocrAttempts}.` : ''}
              </InlineAlert>
              {retry.isError ? <InlineAlert title="Retry was not started">{retry.error.message}</InlineAlert> : null}
              <div className="flex flex-wrap gap-2">
                <Button
                  size="lg"
                  disabled={retry.isPending}
                  onClick={() =>
                    retry.mutate(
                      { documentId: item.id, expectedVersion: item.version },
                      { onSuccess: () => { toast.success('OCR retry started'); onDone(); } },
                    )
                  }
                >
                  {retry.isPending ? 'Retrying…' : 'Retry OCR'}
                </Button>
                <Button variant="outline" size="lg" onClick={() => setManual(true)} disabled={manual}>
                  Transcribe manually
                </Button>
              </div>
              {manual ? <p className="text-muted-foreground">Open the original, then type the instruction in the form. Nothing is saved until you verify it.</p> : null}
            </div>
          ) : drafts.isPending ? (
            <SkeletonRows count={6} className="border-0" />
          ) : drafts.isError ? (
            <ErrorState title="The draft could not be loaded" error={drafts.error} onRetry={() => void drafts.refetch()} />
          ) : latest ? (
            <pre
              tabIndex={0}
              aria-label="OCR draft text, read only"
              className="max-h-[28rem] overflow-auto rounded-md border border-rule bg-paper p-3 font-[inherit] text-sm leading-6 whitespace-pre-wrap focus-visible:outline-2"
            >
              {latest.text}
            </pre>
          ) : (
            <p className="text-muted-foreground">No draft text was produced. Open the original and type the instruction yourself.</p>
          )}
          {latest ? <p className="mt-2 text-xs text-muted-foreground tabular-nums">Read by {latest.provider} at {formatIST(latest.createdAt, 'date-time')}.</p> : null}
        </Panel>

        <Panel title="Instruction to verify">
          {showForm ? (
            instructions.isPending ? (
              <SkeletonRows count={4} className="border-0" />
            ) : (
              <InstructionForm
                key={`${item.id}-${latest?.id ?? 'manual'}`}
                initialTitle={latest ? titleFromDraft(latest.text) : ''}
                initialBody={latest?.text ?? ''}
                current={current}
                sourceDraftId={latest?.id}
                pending={verify.isPending}
                error={verify.isError ? verify.error.message : null}
                onVerify={doVerify}
              />
            )
          ) : failed ? (
            <p className="text-muted-foreground">Retry OCR, or choose Transcribe manually to write the instruction from the original.</p>
          ) : (
            <SkeletonRows count={4} className="border-0" />
          )}
        </Panel>
      </div>

      <InstructionHistory patientId={item.patientId} patientName={item.patientName} />
    </div>
  );
}

/** FR-13: documents awaiting verification, the OCR draft beside the editable instruction. */
export default function ReviewPage({ nav }: { nav: ReactNode }) {
  const { documentId } = useParams();
  const navigate = useNavigate();
  const inbox = useReviewInbox();
  const items = inbox.data ?? [];
  const selected = items.find((d) => d.id === documentId) ?? items[0] ?? null;

  const next = (current: ReviewItem) => {
    const rest = items.filter((d) => d.id !== current.id);
    void navigate(rest[0] ? `/doctor/review/${rest[0].id}` : '/doctor/review', { replace: true });
  };

  return (
    <StaffShell title="Doctor console" description="Review inbox: verify what the patient assistant may use.">
      {nav}
      {inbox.isPending ? (
        <SkeletonRows count={6} />
      ) : inbox.isError && !inbox.data ? (
        <ErrorState title="The review inbox could not be loaded" error={inbox.error} onRetry={() => void inbox.refetch()} />
      ) : items.length === 0 ? (
        <EmptyState title="Nothing to verify">
          Documents your patients upload appear here once their text has been read. Verifying an instruction is what lets the patient assistant quote it.
        </EmptyState>
      ) : (
        <div className="grid items-start gap-4 lg:grid-cols-[320px_minmax(0,1fr)]">
          <InboxList items={items} selectedId={selected?.id ?? null} />
          {selected ? <ReviewDetail key={selected.id} item={selected} onDone={() => next(selected)} /> : null}
        </div>
      )}
    </StaffShell>
  );
}
