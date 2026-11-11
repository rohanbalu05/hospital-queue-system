import { useEffect, useMemo, useRef, useState } from 'react';
import type { ConversationMessage, InstructionVersion } from '@hqms/contracts';
import { AskAssistantRequest } from '@hqms/contracts';
import { useAskAssistant, useConversationMessages, useFollowUpTasks, useInstructions } from '@/api';
import { Field } from '@/components/layout/Field';
import { PatientPage } from '@/components/layout/PatientPage';
import { ErrorState, SkeletonRows } from '@/components/queue';
import { InlineAlert } from '@/components/scheduling/status';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { useAuth } from '@/lib/auth';
import { formatIST } from '@/lib/format';
import { cn } from '@/lib/utils';

/** Per-viewer convenience only: which conversation to reopen. The messages themselves live on the server. */
const storageKey = (patientId: string) => `hqms.assistant.${patientId}`;
function readConversation(patientId: string): string | null {
  try {
    return window.localStorage.getItem(storageKey(patientId));
  } catch {
    return null;
  }
}
function saveConversation(patientId: string, id: string) {
  try {
    window.localStorage.setItem(storageKey(patientId), id);
  } catch {
    // private window or blocked storage: the conversation simply is not reopened next time
  }
}

export function citationLine(c: { title: string; version: number }, verifiedAt: string | undefined): string {
  return `From: ${c.title} (version ${c.version}${verifiedAt ? `, verified ${formatIST(verifiedAt, 'date')}` : ''})`;
}

interface MessageViewProps {
  message: ConversationMessage;
  versions: Map<string, InstructionVersion>;
  dueByTask: Map<string, string>;
}

/** One message. Answers are plain rows with an ink edge: no avatar, no sparkle. */
export function MessageView({ message: m, versions, dueByTask }: MessageViewProps) {
  if (m.role === 'patient') {
    return (
      <li className="border-l-[3px] border-l-rule px-4 py-3" data-role="patient">
        <p className="text-sm font-bold text-muted-foreground">You asked</p>
        <p className="mt-0.5 whitespace-pre-wrap">{m.body}</p>
      </li>
    );
  }
  if (m.outcome === 'escalated') {
    const due = m.escalationTaskId ? dueByTask.get(m.escalationTaskId) : undefined;
    return (
      <li className="border-l-[3px] border-l-ink px-4 py-3" data-role="assistant" data-outcome="escalated">
        <p className="text-sm font-bold text-muted-foreground">Reply</p>
        <p className="mt-0.5 font-bold">
          Sent to the follow-up team.
          {due ? <span> You&apos;ll hear back by {formatIST(due, 'date-time')}.</span> : <span> You&apos;ll hear back soon.</span>}
        </p>
        <p className="mt-1 text-muted-foreground">Your question needs a person, so it was not answered here.</p>
      </li>
    );
  }
  return (
    <li className="border-l-[3px] border-l-ink px-4 py-3" data-role="assistant" data-outcome={m.outcome ?? 'answered'}>
      <p className="text-sm font-bold text-muted-foreground">{m.outcome === 'refused' ? 'Not answered' : 'Answer from your verified instructions'}</p>
      <p className="mt-0.5 whitespace-pre-wrap">{m.body}</p>
      {m.citations.length > 0 ? (
        <ul className="mt-2 grid gap-0.5 text-sm text-muted-foreground tabular-nums">
          {m.citations.map((c) => (
            <li key={c.instructionVersionId}>{citationLine(c, versions.get(c.instructionVersionId)?.verifiedAt)}</li>
          ))}
        </ul>
      ) : null}
    </li>
  );
}

export default function AssistantPage() {
  const { me } = useAuth();
  const patientId = me?.patientId ?? null;
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [question, setQuestion] = useState('');
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [asked, setAsked] = useState<string | null>(null);
  const [dueNow, setDueNow] = useState<Record<string, string>>({});
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (patientId) setConversationId(readConversation(patientId));
  }, [patientId]);

  const messages = useConversationMessages(conversationId);
  const instructions = useInstructions(patientId);
  const tasks = useFollowUpTasks({ patientId: patientId ?? undefined, owner: 'all' }, { enabled: patientId !== null });
  const ask = useAskAssistant();

  const versions = useMemo(() => new Map((instructions.data ?? []).map((v) => [v.id, v])), [instructions.data]);
  const dueByTask = useMemo(() => {
    const m = new Map<string, string>(Object.entries(dueNow));
    for (const t of tasks.data ?? []) m.set(t.id, t.dueAt);
    return m;
  }, [tasks.data, dueNow]);

  const list = useMemo(() => [...(messages.data ?? [])].sort((a, b) => a.createdAt.localeCompare(b.createdAt)), [messages.data]);

  useEffect(() => {
    endRef.current?.scrollIntoView?.({ block: 'nearest' });
  }, [list.length, asked]);

  const send = () => {
    const parsed = AskAssistantRequest.safeParse({ question: question.trim(), ...(conversationId ? { conversationId } : {}) });
    if (!parsed.success) {
      setFieldError('Type your question first, at least 2 characters.');
      return;
    }
    setFieldError(null);
    setAsked(parsed.data.question);
    ask.mutate(parsed.data, {
      onSuccess: (a) => {
        if (patientId) saveConversation(patientId, a.conversationId);
        setConversationId(a.conversationId);
        const esc = a.escalation;
        if (esc) setDueNow((d) => ({ ...d, [esc.taskId]: esc.dueAt }));
        setQuestion('');
        setAsked(null);
      },
      onError: () => undefined,
    });
  };

  return (
    <PatientPage title="Questions about your instructions" description="Ask about the instructions your doctor has verified.">
      <p className="rounded-xl border border-rule bg-surface px-4 py-3" data-testid="assistant-note">
        This assistant only uses instructions your doctor has verified. It cannot change your treatment. For anything else, your question goes to the follow-up team.
      </p>

      <section aria-label="Conversation" className="mt-4">
        {conversationId !== null && messages.isPending ? (
          <SkeletonRows count={3} />
        ) : messages.isError && !messages.data ? (
          <ErrorState title="Your earlier questions could not be loaded" error={messages.error} onRetry={() => void messages.refetch()} />
        ) : list.length === 0 && asked === null ? (
          <p className="rounded-xl border border-rule bg-surface px-4 py-6 text-muted-foreground">
            No questions yet. Try &ldquo;When should I take the second dose?&rdquo; Answers show which verified instruction they come from.
          </p>
        ) : (
          <ul className="divide-y divide-rule overflow-hidden rounded-xl border border-rule bg-surface" aria-live="polite">
            {list.map((m) => (
              <MessageView key={m.id} message={m} versions={versions} dueByTask={dueByTask} />
            ))}
            {asked !== null ? (
              <>
                <li className="border-l-[3px] border-l-rule px-4 py-3" data-role="patient">
                  <p className="text-sm font-bold text-muted-foreground">You asked</p>
                  <p className="mt-0.5 whitespace-pre-wrap">{asked}</p>
                </li>
                {ask.isPending ? (
                  <li className="border-l-[3px] border-l-ink px-4 py-3 text-muted-foreground" aria-busy="true">
                    Checking your verified instructions…
                  </li>
                ) : null}
              </>
            ) : null}
          </ul>
        )}
        <div ref={endRef} />
      </section>

      <form
        className="mt-4 grid gap-3"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          if (!ask.isPending) send();
        }}
      >
        <Field label="Your question" error={fieldError}>
          <Textarea
            value={question}
            onChange={(e) => {
              setQuestion(e.target.value);
              setFieldError(null);
            }}
            rows={3}
            maxLength={1000}
            className={cn('min-h-24')}
          />
        </Field>
        {ask.isError ? (
          <InlineAlert title="Your question was not sent">
            {ask.error.code === 'NETWORK' ? ask.error.message : 'Something went wrong on our side.'} Your text is still here. Press Ask question to try again.
          </InlineAlert>
        ) : null}
        <Button type="submit" size="lg" disabled={ask.isPending} className="sm:w-fit">
          {ask.isPending ? 'Asking…' : 'Ask question'}
        </Button>
      </form>
    </PatientPage>
  );
}
