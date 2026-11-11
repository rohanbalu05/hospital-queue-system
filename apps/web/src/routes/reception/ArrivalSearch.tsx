import { useId, type KeyboardEvent, type RefObject } from 'react';
import { Search } from 'lucide-react';
import type { Doctor, Session } from '@hqms/contracts';
import { ErrorState, GroupTag, SkeletonRows } from '@/components/queue';
import { StatusWord } from '@/components/scheduling/status';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { sessionLabelWord } from '@/components/scheduling/sessions';
import { formatIST } from '@/lib/format';
import { cn } from '@/lib/utils';
import type { ArrivalItem } from './model';

interface ArrivalSearchProps {
  doctors: Doctor[];
  doctorId: string;
  onDoctor: (id: string) => void;
  sessions: Session[];
  sessionId: string;
  onSession: (id: string) => void;
  query: string;
  onQuery: (q: string) => void;
  searchRef: RefObject<HTMLInputElement | null>;
  items: ArrivalItem[];
  activeKey: string | null;
  onActive: (key: string) => void;
  /** Enter on the search box: check in the active arrival. */
  onEnter: () => void;
  loading: boolean;
  error: unknown;
  onRetry: () => void;
}

export function ArrivalSearch(p: ArrivalSearchProps) {
  const listId = useId();
  const optionId = (key: string) => `${listId}-${key}`;
  const idx = p.items.findIndex((i) => i.key === p.activeKey);

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (p.items.length === 0) return;
      const next = e.key === 'ArrowDown' ? Math.min(p.items.length - 1, idx + 1) : Math.max(0, idx - 1);
      const target = p.items[next];
      if (target) p.onActive(target.key);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      p.onEnter();
    } else if (e.key === 'Escape' && p.query) {
      e.preventDefault();
      p.onQuery('');
    }
  };

  return (
    <section aria-label="Find arrivals" className="flex min-w-0 flex-col gap-3">
      <div className="space-y-3 rounded-xl border border-rule bg-surface p-3">
        <div className="space-y-1">
          <Label htmlFor="doctor-select">Doctor</Label>
          <Select value={p.doctorId} onValueChange={p.onDoctor}>
            <SelectTrigger id="doctor-select" className="h-10 w-full">
              <SelectValue placeholder="Choose a doctor" />
            </SelectTrigger>
            <SelectContent>
              {p.doctors.map((d) => (
                <SelectItem key={d.id} value={d.id}>
                  {d.fullName}, {d.department}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {p.sessions.length > 0 ? (
          <Tabs value={p.sessionId} onValueChange={p.onSession}>
            <TabsList aria-label="Session today" className="h-auto w-full">
              {p.sessions.map((s) => (
                <TabsTrigger key={s.id} value={s.id} className="h-9 flex-1 flex-col gap-0 text-sm leading-4 font-bold">
                  <span>{sessionLabelWord(s)}</span>
                  <span className="text-xs font-normal tabular-nums">{formatIST(s.startsAt)}</span>
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>
        ) : null}

        <div className="space-y-1">
          <Label htmlFor="arrival-search">Find an arrival</Label>
          <div className="relative">
            <Search aria-hidden="true" className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              id="arrival-search"
              ref={p.searchRef}
              role="combobox"
              aria-expanded="true"
              aria-controls={listId}
              aria-autocomplete="list"
              aria-activedescendant={p.activeKey ? optionId(p.activeKey) : undefined}
              aria-keyshortcuts="/"
              autoComplete="off"
              spellCheck={false}
              inputMode="search"
              placeholder="Name, phone or MRN"
              value={p.query}
              onChange={(e) => p.onQuery(e.target.value)}
              onKeyDown={onKeyDown}
              className="h-10 pl-9"
            />
          </div>
          <p className="text-xs text-muted-foreground">
            Press <kbd className="rounded-xs border border-rule bg-paper px-1 font-bold">/</kbd> to search, arrows to choose,{' '}
            <kbd className="rounded-xs border border-rule bg-paper px-1 font-bold">Enter</kbd> to check in.
          </p>
        </div>
      </div>

      {p.loading ? <SkeletonRows count={6} /> : null}
      {p.error ? <ErrorState title="Arrivals could not be loaded" error={p.error} onRetry={p.onRetry} /> : null}

      {!p.loading && !p.error ? (
        p.items.length === 0 ? (
          <p role="status" className="rounded-xl border border-rule bg-surface px-3 py-6 text-muted-foreground">
            {p.query.trim()
              ? `No patient matches "${p.query.trim()}". Check the spelling, or register them as a new patient in the action panel.`
              : 'No appointments in this session yet. Search for a patient to admit a walk-in.'}
          </p>
        ) : (
          <div className="overflow-hidden rounded-xl border border-rule bg-surface">
            <h2 className="flex h-10 items-center border-b border-rule px-3 text-sm font-bold">
              {p.query.trim() ? 'Matches' : 'Today’s appointments'}
              <span className="ml-auto font-normal text-muted-foreground tabular-nums">{p.items.length}</span>
            </h2>
            <ul id={listId} role="listbox" aria-label="Arrivals" className="max-h-[calc(100dvh-26rem)] min-h-40 divide-y divide-rule overflow-y-auto">
              {p.items.map((item) => {
                const active = item.key === p.activeKey;
                const a = item.appointment;
                return (
                  <li
                    key={item.key}
                    id={optionId(item.key)}
                    role="option"
                    aria-selected={active}
                    onClick={() => {
                      p.onActive(item.key);
                      p.searchRef.current?.focus();
                    }}
                    className={cn(
                      'flex min-h-12 cursor-pointer items-center gap-2 border-l-[3px] px-3 py-1.5 text-sm hover:bg-secondary',
                      a && (a.status === 'booked' || a.status === 'checked_in') ? 'border-l-appt' : 'border-l-rule',
                      active && 'bg-secondary outline-2 -outline-offset-2 outline-ink',
                    )}
                  >
                    {a ? <span className="w-[4.25rem] shrink-0 font-bold tabular-nums">{formatIST(a.scheduledAt)}</span> : null}
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-bold">{item.name}</span>
                      <span className="block truncate text-xs text-muted-foreground tabular-nums">{[item.mrn, item.phone].filter(Boolean).join('  ') || ' '}</span>
                    </span>
                    {a ? (
                      <span className="flex shrink-0 flex-col items-end gap-0.5">
                        <GroupTag group="A" />
                        <StatusWord status={a.status} className="text-xs" />
                      </span>
                    ) : (
                      <span className="shrink-0 text-xs text-muted-foreground">No appointment</span>
                    )}
                  </li>
                );
              })}
            </ul>
          </div>
        )
      ) : null}
    </section>
  );
}
