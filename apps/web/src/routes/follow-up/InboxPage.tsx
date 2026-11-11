import { useMemo } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useFollowUpTasks, type FollowUpTaskView } from '@/api';
import { TaskStatusWord, TimingWord } from '@/components/followup/words';
import { StaffShell } from '@/components/layout/Shells';
import { EmptyState, ErrorState, SkeletonRows } from '@/components/queue';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { formatLocalDate, istDate } from '@/lib/dates';
import { formatIST } from '@/lib/format';
import { isClosed, KIND_WORD, sortTasks, sourceVisitWord, taskTiming } from '@/lib/followup';
import { useNow } from '@/lib/useNow';
import { cn } from '@/lib/utils';

type Tab = 'mine' | 'unassigned' | 'all';
const OWNER: Record<Tab, 'me' | 'unassigned' | 'all'> = { mine: 'me', unassigned: 'unassigned', all: 'all' };
const EMPTY: Record<Tab, { title: string; body: string }> = {
  mine: { title: 'No tasks are yours right now', body: 'Open the Unassigned tab and acknowledge a task to take it. Tasks you own stay here until you resolve or cancel them.' },
  unassigned: { title: 'No unassigned tasks', body: 'New tasks from visits, document reviews and assistant questions appear here until someone acknowledges them.' },
  all: { title: 'No follow-up tasks', body: 'Nothing has been raised yet. Tasks appear here when a doctor, a document review or a patient question creates one.' },
};

export function TaskTable({ tasks, now }: { tasks: FollowUpTaskView[]; now: number }) {
  const navigate = useNavigate();
  return (
    <div className="overflow-hidden rounded-xl border border-rule bg-surface">
      <Table>
        <TableHeader className="bg-paper">
          <TableRow className="hover:bg-transparent">
            <TableHead className="pl-3">Due</TableHead>
            <TableHead>Overdue</TableHead>
            <TableHead>Patient</TableHead>
            <TableHead>Task</TableHead>
            <TableHead>Source visit</TableHead>
            <TableHead>Owner</TableHead>
            <TableHead>Status</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {tasks.map((t) => {
            const overdue = taskTiming(t, now).overdue;
            return (
              <TableRow
                key={t.id}
                data-testid="task-row"
                data-overdue={overdue ? 'true' : 'false'}
                className={cn('h-10 cursor-pointer', isClosed(t.status) && 'text-muted-foreground')}
                onClick={() => void navigate(`/follow-up/tasks/${t.id}`)}
              >
                <TableCell className={cn('border-l-[3px] pl-3 tabular-nums', overdue ? 'border-l-priority' : 'border-l-transparent')}>
                  {formatIST(t.dueAt, 'date-time')}
                </TableCell>
                <TableCell>
                  <TimingWord task={t} now={now} />
                </TableCell>
                <TableCell>
                  <Link
                    to={`/follow-up/tasks/${t.id}`}
                    className="font-bold underline-offset-2 hover:underline focus-visible:rounded-xs"
                    onClick={(e) => e.stopPropagation()}
                  >
                    {t.patientName}
                  </Link>
                </TableCell>
                <TableCell className="max-w-72 truncate" title={t.title}>
                  <span className="text-muted-foreground">{KIND_WORD[t.kind] ?? t.kind}: </span>
                  {t.title}
                </TableCell>
                <TableCell>{sourceVisitWord(t, (d) => formatLocalDate(d))}</TableCell>
                <TableCell>{t.ownerName ?? <span className="text-muted-foreground">Unassigned</span>}</TableCell>
                <TableCell>
                  <TaskStatusWord status={t.status} />
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}

function TabPanel({ tab, showClosed, now }: { tab: Tab; showClosed: boolean; now: number }) {
  const q = useFollowUpTasks({ owner: OWNER[tab] });
  const tasks = useMemo(() => sortTasks((q.data ?? []).filter((t) => showClosed || !isClosed(t.status)), now), [q.data, showClosed, now]);

  if (q.isPending) return <SkeletonRows count={6} />;
  if (q.isError && !q.data) return <ErrorState title="Follow-up tasks could not be loaded" error={q.error} onRetry={() => void q.refetch()} />;
  return (
    <div className="grid gap-3">
      {q.isError ? (
        <p role="status" className="rounded-md border border-ink bg-secondary px-3 py-2">
          <span className="font-bold">The last refresh failed.</span> Showing the list as of {formatIST(q.dataUpdatedAt, 'time-seconds')}.
        </p>
      ) : null}
      {tasks.length === 0 ? <EmptyState title={EMPTY[tab].title}>{EMPTY[tab].body}</EmptyState> : <TaskTable tasks={tasks} now={now} />}
    </div>
  );
}

export default function InboxPage() {
  const [params, setParams] = useSearchParams();
  const tab: Tab = params.get('tab') === 'unassigned' ? 'unassigned' : params.get('tab') === 'all' ? 'all' : 'mine';
  const showClosed = params.get('closed') === '1';
  const now = useNow();

  // Counts of unresolved work for the tab labels.
  const mine = useFollowUpTasks({ owner: 'me' });
  const unassigned = useFollowUpTasks({ owner: 'unassigned' });
  const open = (list: FollowUpTaskView[] | undefined) => (list ? list.filter((t) => !isClosed(t.status)).length : null);
  const overdueMine = mine.data ? mine.data.filter((t) => taskTiming(t, now).overdue).length : 0;

  const setParam = (key: string, value: string | null) =>
    setParams(
      (p) => {
        const next = new URLSearchParams(p);
        if (value === null) next.delete(key);
        else next.set(key, value);
        return next;
      },
      { replace: true },
    );

  const label = (word: string, count: number | null) => (count === null ? word : `${word} (${count})`);

  return (
    <StaffShell
      title="Follow-up tasks"
      description={`${formatLocalDate(istDate(now), 'weekday-date')}${overdueMine > 0 ? `. ${overdueMine} of your tasks ${overdueMine === 1 ? 'is' : 'are'} overdue.` : '. Tasks you own, with due times and the visit they came from.'}`}
    >
      <Tabs value={tab} onValueChange={(v) => setParam('tab', v === 'mine' ? null : v)}>
        <div className="flex flex-wrap items-center gap-x-6 gap-y-2 border-b border-rule pb-1">
          <TabsList variant="line" aria-label="Task owner" className="h-10 gap-4">
            <TabsTrigger value="mine" className="flex-none px-1">
              {label('Mine', open(mine.data))}
            </TabsTrigger>
            <TabsTrigger value="unassigned" className="flex-none px-1">
              {label('Unassigned', open(unassigned.data))}
            </TabsTrigger>
            <TabsTrigger value="all" className="flex-none px-1">
              All
            </TabsTrigger>
          </TabsList>
          <div className="ml-auto flex items-center gap-2">
            <Checkbox id="show-closed" checked={showClosed} onCheckedChange={(c) => setParam('closed', c === true ? '1' : null)} />
            <Label htmlFor="show-closed">Show resolved and cancelled</Label>
          </div>
        </div>
        <TabsContent value="mine" className="pt-3">
          <TabPanel tab="mine" showClosed={showClosed} now={now} />
        </TabsContent>
        <TabsContent value="unassigned" className="pt-3">
          <TabPanel tab="unassigned" showClosed={showClosed} now={now} />
        </TabsContent>
        <TabsContent value="all" className="pt-3">
          <TabPanel tab="all" showClosed={showClosed} now={now} />
        </TabsContent>
      </Tabs>
    </StaffShell>
  );
}
