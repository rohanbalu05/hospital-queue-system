import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import type { Doctor, LocalDate, Session } from '@hqms/contracts';
import { useBookAppointment, useDoctorsQuery, useSessionsQuery, useSlotsQuery } from '@/api';
import { PatientPage } from '@/components/layout/PatientPage';
import { EmptyState, ErrorState, SkeletonRows } from '@/components/queue';
import { Choice, ChoiceList } from '@/components/scheduling/choice';
import { SessionChoiceList, bookability, sessionLabelWord, sessionTimes } from '@/components/scheduling/sessions';
import { InlineAlert } from '@/components/scheduling/status';
import { Button } from '@/components/ui/button';
import { ApiRequestError } from '@/lib/api';
import { formatLocalDate, nextDays } from '@/lib/dates';
import { formatIST } from '@/lib/format';


const STEPS = ['department', 'doctor', 'date', 'session', 'confirm'] as const;
type Step = (typeof STEPS)[number];

const HEADINGS: Record<Step, string> = {
  department: 'Choose a department',
  doctor: 'Choose a doctor',
  date: 'Choose a day',
  session: 'Choose a session',
  confirm: 'Check and book',
};

const DAYS = 7;

export default function BookPage() {
  const [step, setStep] = useState<Step>('department');
  const [department, setDepartment] = useState('');
  const [doctorId, setDoctorId] = useState('');
  const [date, setDate] = useState('');
  const [sessionId, setSessionId] = useState('');

  const headingRef = useRef<HTMLHeadingElement>(null);
  const first = useRef(true);
  useEffect(() => {
    // Move focus to the new step's heading so keyboard and screen-reader users land on it.
    if (first.current) {
      first.current = false;
      return;
    }
    headingRef.current?.focus();
  }, [step]);

  const days = useMemo(() => nextDays(DAYS), []);
  const doctorsQ = useDoctorsQuery();
  const doctors = useMemo(() => (doctorsQ.data ?? []).filter((d) => d.active), [doctorsQ.data]);
  const departments = useMemo(() => [...new Set(doctors.map((d) => d.department))].sort(), [doctors]);
  const doctor = doctors.find((d) => d.id === doctorId) ?? null;

  const sessionsQ = useSessionsQuery(
    { doctorId, from: days[0] as string, to: days[DAYS - 1] as string },
    { enabled: doctorId !== '' },
  );
  const sessions = useMemo(() => sessionsQ.data ?? [], [sessionsQ.data]);
  const session = sessions.find((s) => s.id === sessionId) ?? null;

  const stepIndex = STEPS.indexOf(step);
  const back = () => setStep(STEPS[Math.max(0, stepIndex - 1)] ?? 'department');
  const go = (s: Step) => setStep(s);

  return (
    <PatientPage title="Book appointment" description="Pick a department, doctor, day and session.">
      <p className="text-sm text-muted-foreground tabular-nums" aria-live="polite">
        Step {stepIndex + 1} of {STEPS.length}
      </p>
      <h2 ref={headingRef} tabIndex={-1} className="mt-1 text-xl font-bold outline-none">
        {HEADINGS[step]}
      </h2>

      <div className="mt-4 space-y-4">
        {step === 'department' ? (
          <DepartmentStep
            loading={doctorsQ.isPending}
            error={doctorsQ.error}
            onRetry={() => void doctorsQ.refetch()}
            departments={departments}
            value={department}
            onChange={setDepartment}
            onNext={() => {
              if (!department) return;
              if (doctor && doctor.department !== department) {
                setDoctorId('');
                setDate('');
                setSessionId('');
              }
              go('doctor');
            }}
          />
        ) : null}

        {step === 'doctor' ? (
          <DoctorStep
            doctors={doctors.filter((d) => d.department === department)}
            value={doctorId}
            onChange={(id) => {
              setDoctorId(id);
              setDate('');
              setSessionId('');
            }}
            onNext={() => doctorId && go('date')}
            onBack={back}
          />
        ) : null}

        {step === 'date' ? (
          <DateStep
            days={days}
            sessions={sessions}
            loading={sessionsQ.isPending}
            error={sessionsQ.error}
            onRetry={() => void sessionsQ.refetch()}
            value={date}
            onChange={(d) => {
              setDate(d);
              setSessionId('');
            }}
            onNext={() => date && go('session')}
            onBack={back}
          />
        ) : null}

        {step === 'session' ? (
          <SessionStep
            sessions={sessions.filter((s) => s.sessionDate === date)}
            value={sessionId}
            onChange={setSessionId}
            onNext={() => sessionId && go('confirm')}
            onBack={back}
          />
        ) : null}

        {step === 'confirm' && session && doctor ? (
          <ConfirmStep session={session} doctor={doctor} onBack={back} onChooseAnother={() => go('session')} />
        ) : null}
      </div>
    </PatientPage>
  );
}

function StepActions({ onNext, onBack, nextDisabled, nextLabel = 'Continue' }: { onNext?: () => void; onBack?: () => void; nextDisabled?: boolean; nextLabel?: string }) {
  return (
    <div className="flex flex-col-reverse gap-3 sm:flex-row sm:justify-between">
      {onBack ? (
        <Button type="button" variant="outline" size="lg" onClick={onBack}>
          Back
        </Button>
      ) : (
        <span />
      )}
      {onNext ? (
        <Button type="button" size="lg" onClick={onNext} disabled={nextDisabled}>
          {nextLabel}
        </Button>
      ) : null}
    </div>
  );
}

function DepartmentStep(props: {
  loading: boolean;
  error: unknown;
  onRetry: () => void;
  departments: string[];
  value: string;
  onChange: (v: string) => void;
  onNext: () => void;
}) {
  if (props.loading) return <SkeletonRows count={5} />;
  if (props.error) return <ErrorState title="Departments could not be loaded" error={props.error} onRetry={props.onRetry} />;
  if (props.departments.length === 0) {
    return (
      <EmptyState title="No doctors are taking bookings right now">
        Please call the hospital front desk and they will book you in.
      </EmptyState>
    );
  }
  return (
    <>
      <ChoiceList label="Department" value={props.value} onValueChange={props.onChange} onEnter={props.onNext}>
        {props.departments.map((d) => (
          <Choice key={d} value={d} title={d} />
        ))}
      </ChoiceList>
      <StepActions onNext={props.onNext} nextDisabled={!props.value} />
    </>
  );
}

function DoctorStep(props: { doctors: Doctor[]; value: string; onChange: (v: string) => void; onNext: () => void; onBack: () => void }) {
  return (
    <>
      <ChoiceList label="Doctor" value={props.value} onValueChange={props.onChange} onEnter={props.onNext}>
        {props.doctors.map((d) => (
          <Choice key={d.id} value={d.id} title={d.fullName} detail={`${d.department}, room ${d.room}`} />
        ))}
      </ChoiceList>
      <StepActions onNext={props.onNext} onBack={props.onBack} nextDisabled={!props.value} />
    </>
  );
}

function DateStep(props: {
  days: LocalDate[];
  sessions: Session[];
  loading: boolean;
  error: unknown;
  onRetry: () => void;
  value: string;
  onChange: (v: string) => void;
  onNext: () => void;
  onBack: () => void;
}) {
  if (props.loading) return <SkeletonRows count={7} />;
  if (props.error) {
    return (
      <>
        <ErrorState title="Days could not be loaded" error={props.error} onRetry={props.onRetry} />
        <StepActions onBack={props.onBack} />
      </>
    );
  }
  const today = props.days[0];
  return (
    <>
      <ChoiceList label="Day" value={props.value} onValueChange={props.onChange} onEnter={props.onNext}>
        {props.days.map((d) => {
          const day = props.sessions.filter((s) => s.sessionDate === d);
          const open = day.filter((s) => bookability(s).ok);
          const aside =
            day.length === 0
              ? 'No sessions'
              : open.length === 0
                ? 'Full'
                : `${open.length} ${open.length === 1 ? 'session' : 'sessions'} with places`;
          return <Choice key={d} value={d} disabled={open.length === 0} title={formatLocalDate(d)} detail={d === today ? 'Today' : undefined} aside={aside} />;
        })}
      </ChoiceList>
      {props.sessions.length === 0 ? (
        <InlineAlert tone="notice" title="No sessions in the next 7 days">
          Try another doctor, or call the front desk.
        </InlineAlert>
      ) : null}
      <StepActions onNext={props.onNext} onBack={props.onBack} nextDisabled={!props.value} />
    </>
  );
}

function SessionStep(props: { sessions: Session[]; value: string; onChange: (v: string) => void; onNext: () => void; onBack: () => void }) {
  return (
    <>
      <SessionChoiceList sessions={props.sessions} value={props.value} onValueChange={props.onChange} onEnter={props.onNext} />
      <StepActions onNext={props.onNext} onBack={props.onBack} nextDisabled={!props.value} />
    </>
  );
}

function ConfirmStep({ session, doctor, onBack, onChooseAnother }: { session: Session; doctor: Doctor; onBack: () => void; onChooseAnother: () => void }) {
  const navigate = useNavigate();
  const slots = useSlotsQuery(session.id);
  const book = useBookAppointment();
  const nextFree = slots.data?.slots.find((s) => s.available)?.scheduledAt ?? null;

  const err = book.error instanceof ApiRequestError ? book.error : null;
  const full = err?.code === 'CAPACITY_FULL';

  const submit = () => {
    if (book.isPending) return;
    book.mutate(
      { sessionId: session.id },
      {
        onSuccess: (appt) => {
          toast.success('Booked', { description: `${formatIST(appt.scheduledAt, 'date-time')} with ${appt.doctorName}` });
          navigate('/patient/visits', { state: { bookedId: appt.id } });
        },
      },
    );
  };

  return (
    <>
      <dl className="divide-y divide-rule overflow-hidden rounded-xl border border-rule bg-surface">
        <Row term="Doctor" value={doctor.fullName} />
        <Row term="Department" value={doctor.department} />
        <Row term="Room" value={doctor.room} />
        <Row term="Date" value={formatLocalDate(session.sessionDate)} />
        <Row
          term="Session"
          value={
            <>
              <span className="block">{sessionLabelWord(session)}</span>
              <span className="block text-sm text-muted-foreground">{sessionTimes(session)}</span>
            </>
          }
        />
        <Row
          term="Your time"
          value={
            slots.isPending ? (
              <span className="text-muted-foreground">Checking the next free time…</span>
            ) : nextFree ? (
              <>
                <span className="font-bold">{formatIST(nextFree)}</span>
                <span className="block text-sm text-muted-foreground">The next free time. It is confirmed when you book.</span>
              </>
            ) : (
              <span className="text-muted-foreground">Assigned when you book.</span>
            )
          }
        />
      </dl>

      {full ? (
        <InlineAlert title="This session just filled up">
          No place was booked. Choose another session to continue.
        </InlineAlert>
      ) : err ? (
        <InlineAlert title="The appointment was not booked">
          <p>{err.message}</p>
          {err.code === 'NETWORK' ? <p className="mt-1">Press Book appointment again. You will not be booked twice.</p> : null}
        </InlineAlert>
      ) : null}

      {full ? (
        <Button
          type="button"
          size="lg"
          className="w-full"
          onClick={() => {
            book.reset();
            onChooseAnother();
          }}
        >
          Choose another session
        </Button>
      ) : (
        <div className="flex flex-col-reverse gap-3 sm:flex-row sm:justify-between">
          <Button type="button" variant="outline" size="lg" onClick={onBack} disabled={book.isPending}>
            Back
          </Button>
          <Button type="button" size="lg" onClick={submit} disabled={book.isPending} className="sm:min-w-48">
            {book.isPending ? 'Booking…' : 'Book appointment'}
          </Button>
        </div>
      )}
    </>
  );
}

function Row({ term, value }: { term: string; value: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[6.5rem_1fr] gap-3 px-4 py-3">
      <dt className="text-muted-foreground">{term}</dt>
      <dd className="min-w-0 tabular-nums">{value}</dd>
    </div>
  );
}
