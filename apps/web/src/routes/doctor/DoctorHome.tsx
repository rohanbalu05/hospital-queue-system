import { NavLink, Navigate, Route, Routes, useSearchParams } from 'react-router-dom';
import { StaffShell } from '@/components/layout/Shells';
import { EmptyState, ErrorState, SkeletonRows } from '@/components/queue';
import { useDoctorSessions } from '@/api/queue';
import { useAuth } from '@/lib/auth';
import { formatIST } from '@/lib/format';
import { cn } from '@/lib/utils';
import { useTodayIST } from '@/live';
import { SessionConsole } from './components/SessionConsole';
import { SessionPicker } from './components/SessionPicker';

function DoctorNav() {
  const link = ({ isActive }: { isActive: boolean }) =>
    cn(
      'inline-flex h-10 items-center border-b-2 px-1 font-bold',
      isActive ? 'border-ink text-ink' : 'border-transparent text-muted-foreground hover:text-ink',
    );
  return (
    <nav aria-label="Doctor sections" className="mb-4 flex gap-6 border-b border-rule">
      <NavLink to="/doctor" end className={link}>
        Queue
      </NavLink>
      <NavLink to="/doctor/review" className={link}>
        Review inbox
      </NavLink>
    </nav>
  );
}

function QueuePage() {
  const { me } = useAuth();
  const date = useTodayIST();
  const doctorId = me?.doctorId ?? null;
  const sessions = useDoctorSessions(date, doctorId);
  const [params, setParams] = useSearchParams();

  const list = sessions.data ?? [];
  const requested = params.get('session');
  const selected =
    list.find((s) => s.id === requested) ?? list.find((s) => s.status === 'open' || s.status === 'paused') ?? list[0] ?? null;

  return (
    <StaffShell
      title="Doctor console"
      description={`${formatIST(`${date}T12:00:00+05:30`, 'weekday-date')}${me ? `, ${me.displayName}` : ''}`}
    >
      <DoctorNav />
      {doctorId === null && me ? (
        <ErrorState title="This account is not linked to a doctor" hint="Ask an admin to link your login to your doctor record." />
      ) : sessions.isPending ? (
        <SkeletonRows count={6} />
      ) : sessions.isError ? (
        <ErrorState title="Your sessions could not be loaded" error={sessions.error} onRetry={() => void sessions.refetch()} />
      ) : !selected ? (
        <EmptyState title="No session today">
          You have no sessions on today&apos;s schedule. If that is wrong, ask an admin to check the session calendar.
        </EmptyState>
      ) : (
        <SessionConsole
          key={selected.id}
          session={selected}
          date={date}
          picker={
            <SessionPicker
              sessions={list}
              value={selected.id}
              onChange={(id) => setParams((p) => {
                const next = new URLSearchParams(p);
                next.set('session', id);
                return next;
              }, { replace: true })}
            />
          }
        />
      )}
    </StaffShell>
  );
}

/** Slot for the W3 review inbox (OCR drafts awaiting verification). */
function ReviewSlot() {
  return (
    <StaffShell title="Doctor console" description="Review inbox">
      <DoctorNav />
      <EmptyState title="Review inbox is not switched on yet">
        Prescription drafts that need your verification will be listed here, with the draft and the editable instruction side by side.
        For now, the Queue tab is all you need.
      </EmptyState>
    </StaffShell>
  );
}

export default function DoctorHome() {
  return (
    <Routes>
      <Route index element={<QueuePage />} />
      <Route path="review" element={<ReviewSlot />} />
      <Route path="*" element={<Navigate to="/doctor" replace />} />
    </Routes>
  );
}
