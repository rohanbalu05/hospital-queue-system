import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import type { ArrivalResult, RegisterPatientRequest } from '@hqms/contracts';
import {
  useAdmitWalkIn,
  useCheckIn,
  useDoctorsQuery,
  usePatientSearchQuery,
  useRegisterPatient,
  useSessionAppointmentsQuery,
  useSessionsQuery,
} from '@/api';
import { StaffShell } from '@/components/layout/Shells';
import { EmptyState, ErrorState, SkeletonRows } from '@/components/queue';
import { ApiRequestError } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { formatLocalDate, istDate, minutesBetween } from '@/lib/dates';
import { ActionPanel } from './ActionPanel';
import { ArrivalSearch } from './ArrivalSearch';
import { LateArrivalDialog } from './LateArrivalDialog';
import { SessionBoard } from './SessionBoard';
import { buildItems, canCheckIn, type ArrivalItem, type ArrivalOutcome, type PanelError } from './model';

function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

function toPanelError(e: unknown, what: 'check-in' | 'walk-in'): PanelError {
  const err = e instanceof ApiRequestError ? e : null;
  const failed = what === 'check-in' ? 'Not checked in' : 'Not admitted';
  switch (err?.code) {
    case 'CAPACITY_FULL':
      return {
        code: 'CAPACITY_FULL',
        title: 'No places left',
        message: 'Walk-in places are full for this session. Nobody was admitted.',
        hint: 'Ask an admin to raise walk-in capacity, or send the patient to another session.',
      };
    case 'NETWORK':
      return {
        code: 'NETWORK',
        title: failed,
        message: err.message,
        hint: 'Press the button again. The same request is sent, so nobody is admitted twice.',
      };
    case 'INVALID_TRANSITION':
    case 'CONFLICT':
      return { code: err.code, title: failed, message: err.message, hint: 'The list has changed. Check the arrival again, then retry.' };
    case 'FORBIDDEN':
      return { code: 'FORBIDDEN', title: failed, message: err.message, hint: 'This doctor is not on your assignments.' };
    default:
      return { code: err?.code ?? 'UNKNOWN', title: failed, message: err?.message ?? 'Something went wrong.', hint: 'Try again. If it keeps failing, tell an admin.' };
  }
}

export default function ReceptionHome() {
  const { me } = useAuth();
  const today = istDate();

  const doctorsQ = useDoctorsQuery();
  const assigned = useMemo(() => (doctorsQ.data ?? []).filter((d) => me?.assignedDoctorIds.includes(d.id)), [doctorsQ.data, me]);
  const [doctorPick, setDoctorPick] = useState('');
  const doctor = assigned.find((d) => d.id === doctorPick) ?? assigned[0] ?? null;

  const sessionsQ = useSessionsQuery({ date: today, doctorId: doctor?.id }, { enabled: doctor !== null, refetchInterval: 15_000 });
  const sessions = useMemo(() => [...(sessionsQ.data ?? [])].sort((a, b) => a.startsAt.localeCompare(b.startsAt)), [sessionsQ.data]);
  const [sessionPick, setSessionPick] = useState('');
  const session = sessions.find((s) => s.id === sessionPick) ?? sessions[0] ?? null;

  const apptQ = useSessionAppointmentsQuery(session?.id ?? null);
  const appointments = apptQ.data;

  const [query, setQuery] = useState('');
  const debounced = useDebounced(query, 200);
  const patientsQ = usePatientSearchQuery(debounced);
  const searching = query.trim().length >= 2 && (debounced !== query || patientsQ.isFetching);
  const items = useMemo(() => buildItems(debounced, appointments ?? [], patientsQ.data), [debounced, appointments, patientsQ.data]);

  const [activeKey, setActiveKey] = useState<string | null>(null);
  const active: ArrivalItem | null = items.find((i) => i.key === activeKey) ?? items[0] ?? null;

  const [tokens, setTokens] = useState<Record<string, ArrivalResult>>({});
  const [outcome, setOutcome] = useState<ArrivalOutcome | null>(null);
  const [panelError, setPanelError] = useState<PanelError | null>(null);
  const [late, setLate] = useState<{ item: ArrivalItem; minutesLate: number } | null>(null);
  const [lateError, setLateError] = useState<PanelError | null>(null);

  const searchRef = useRef<HTMLInputElement>(null);

  // "/" focuses the search box from anywhere that is not a text field.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== '/' || e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName))) return;
      e.preventDefault();
      searchRef.current?.focus();
      searchRef.current?.select();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const checkIn = useCheckIn();
  const admit = useAdmitWalkIn();
  const register = useRegisterPatient();

  const readyForNext = useCallback(() => {
    setQuery('');
    searchRef.current?.focus();
  }, []);

  const doCheckIn = useCallback(
    (item: ArrivalItem, admitLate = false) => {
      const appt = item.appointment;
      if (!appt || checkIn.isPending) return;
      setPanelError(null);
      checkIn.mutate(
        { appointmentId: appt.id, ...(admitLate ? { admitLate: true } : {}) },
        {
          onSuccess: (result) => {
            toast.success('Checked in', { description: `${item.name}, token ${result.token}` });
            setTokens((t) => ({ ...t, [appt.id]: result }));
            setOutcome({ result, name: item.name, verb: 'Checked in' });
            setLate(null);
            setLateError(null);
            readyForNext();
          },
          onError: (e) => {
            if (e instanceof ApiRequestError && e.code === 'LATE_ARRIVAL_REQUIRES_REVIEW' && !admitLate) {
              const d = e.details as { minutesLate?: number } | null | undefined;
              setLateError(null);
              setLate({ item, minutesLate: d?.minutesLate ?? Math.max(0, minutesBetween(appt.scheduledAt, new Date())) });
              return;
            }
            if (admitLate) setLate(null);
            setPanelError(toPanelError(e, 'check-in'));
          },
        },
      );
    },
    [checkIn, readyForNext],
  );

  const doAdmit = useCallback(
    (patientId: string, name: string) => {
      if (!session || admit.isPending) return;
      setPanelError(null);
      admit.mutate(
        { sessionId: session.id, patientId },
        {
          onSuccess: (result) => {
            toast.success('Admitted', { description: `${name}, token ${result.token}` });
            setOutcome({ result, name, verb: 'Admitted' });
            readyForNext();
          },
          onError: (e) => setPanelError(toPanelError(e, 'walk-in')),
        },
      );
    },
    [admit, session, readyForNext],
  );

  const doRegister = (form: RegisterPatientRequest) => {
    setPanelError(null);
    register.mutate(form, {
      onSuccess: (patient) => doAdmit(patient.id, patient.fullName),
      onError: (e) =>
        setPanelError({
          code: e instanceof ApiRequestError ? e.code : 'UNKNOWN',
          title: 'Patient not registered',
          message: e instanceof Error ? e.message : 'Something went wrong.',
          hint: 'Check the details and try again.',
        }),
    });
  };

  const pickDoctor = (id: string) => {
    setDoctorPick(id);
    setSessionPick('');
    setActiveKey(null);
    setOutcome(null);
    setPanelError(null);
  };
  const pickSession = (id: string) => {
    setSessionPick(id);
    setActiveKey(null);
    setOutcome(null);
    setPanelError(null);
  };

  const onEnter = () => {
    if (active && canCheckIn(active) && !late) doCheckIn(active);
  };

  const description = `${formatLocalDate(today, 'weekday-date')}. Arrivals, walk-ins and the session board for your doctors.`;

  if (doctorsQ.isPending) {
    return (
      <StaffShell title="Reception desk" description={description}>
        <SkeletonRows count={6} />
      </StaffShell>
    );
  }
  if (doctorsQ.isError) {
    return (
      <StaffShell title="Reception desk" description={description}>
        <ErrorState title="Doctors could not be loaded" error={doctorsQ.error} onRetry={() => void doctorsQ.refetch()} />
      </StaffShell>
    );
  }
  if (assigned.length === 0) {
    return (
      <StaffShell title="Reception desk" description={description}>
        <EmptyState title="No doctors are assigned to you">An admin can assign doctors to your account under staff assignments. Then their sessions appear here.</EmptyState>
      </StaffShell>
    );
  }

  const stale = apptQ.isError && apptQ.data !== undefined;
  const sessionError = sessionsQ.isError && !sessionsQ.data ? sessionsQ.error : null;

  return (
    <StaffShell title="Reception desk" description={description}>
      <div className="grid grid-cols-[minmax(0,1fr)] items-start gap-4 lg:grid-cols-[340px_minmax(0,1fr)_360px]">
        <div className="lg:col-start-1 lg:row-start-1">
          <ArrivalSearch
            doctors={assigned}
            doctorId={doctor?.id ?? ''}
            onDoctor={pickDoctor}
            sessions={sessions}
            sessionId={session?.id ?? ''}
            onSession={pickSession}
            query={query}
            onQuery={(q) => {
              setQuery(q);
              setActiveKey(null);
            }}
            searchRef={searchRef}
            items={items}
            activeKey={active?.key ?? null}
            onActive={setActiveKey}
            onEnter={onEnter}
            loading={session !== null && (apptQ.isPending || searching) && items.length === 0}
            error={apptQ.isError && !apptQ.data ? apptQ.error : patientsQ.isError ? patientsQ.error : null}
            onRetry={() => {
              void apptQ.refetch();
              void patientsQ.refetch();
            }}
          />
        </div>

        <div className="lg:col-start-3 lg:row-start-1">
          <ActionPanel
            item={active}
            session={session}
            knownToken={active?.appointment ? tokens[active.appointment.id] : undefined}
            onCheckIn={() => active && doCheckIn(active)}
            checkInPending={checkIn.isPending}
            onAdmit={() => active && doAdmit(active.patientId, active.name)}
            admitPending={admit.isPending}
            onRegister={doRegister}
            registerPending={register.isPending}
            outcome={outcome}
            onDismissOutcome={() => {
              setOutcome(null);
              readyForNext();
            }}
            error={panelError}
          />
        </div>

        <div className="lg:col-start-2 lg:row-start-1">
          <SessionBoard
            doctor={doctor}
            session={session}
            sessionsLoading={sessionsQ.isPending && doctor !== null}
            sessionsError={sessionError}
            onRetrySessions={() => void sessionsQ.refetch()}
            appointments={appointments}
            appointmentsLoading={apptQ.isPending && session !== null}
            appointmentsError={apptQ.isError ? apptQ.error : null}
            stale={stale}
            lastUpdated={apptQ.dataUpdatedAt || null}
            onRetry={() => void apptQ.refetch()}
            tokens={tokens}
          />
        </div>
      </div>

      <LateArrivalDialog
        open={late !== null}
        item={late?.item ?? null}
        minutesLate={late?.minutesLate ?? 0}
        pending={checkIn.isPending}
        error={lateError}
        onAdmit={() => late && doCheckIn(late.item, true)}
        onClose={() => setLate(null)}
        onClosed={() => searchRef.current?.focus()}
      />
    </StaffShell>
  );
}
