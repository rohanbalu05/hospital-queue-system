import { useEffect, useMemo, useRef, useState } from 'react';
import type { Appointment } from '@hqms/contracts';
import { useDoctorsQuery, useReturnBooking, useSessionsQuery, type FollowUpTaskView } from '@/api';
import { EmptyState, ErrorState, SkeletonRows } from '@/components/queue';
import { SessionChoiceList, bookability } from '@/components/scheduling/sessions';
import { InlineAlert } from '@/components/scheduling/status';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { ApiRequestError } from '@/lib/api';
import { addDays, formatLocalDate, istDate } from '@/lib/dates';

interface ReturnBookingDialogProps {
  open: boolean;
  task: FollowUpTaskView;
  onOpenChange: (open: boolean) => void;
  onBooked: (appointment: Appointment) => void;
}

const HORIZON_DAYS = 14;

/**
 * "Book return visit": pick the doctor's session and book through normal capacity (POST /follow-up-tasks/:id/return-booking).
 * A full session is an explicit 409 CAPACITY_FULL: nothing is booked, and the list refreshes.
 */
export function ReturnBookingDialog({ open, task, onOpenChange, onBooked }: ReturnBookingDialogProps) {
  const doctors = useDoctorsQuery();
  const [doctorPick, setDoctorPick] = useState<string>(task.sourceVisit?.doctorId ?? '');
  const doctorId = doctorPick || doctors.data?.[0]?.id || '';
  const [sessionId, setSessionId] = useState('');
  const today = istDate();
  const sessionsQ = useSessionsQuery({ from: today, to: addDays(today, HORIZON_DAYS), doctorId }, { enabled: open && doctorId !== '' });
  const sessions = useMemo(() => [...(sessionsQ.data ?? [])].sort((a, b) => a.startsAt.localeCompare(b.startsAt)), [sessionsQ.data]);
  const booking = useReturnBooking();
  const justBooked = useRef(false);

  const { reset } = booking;
  useEffect(() => {
    if (!open) {
      setSessionId('');
      reset();
    }
  }, [open, reset]);

  const chosen = sessions.find((s) => s.id === sessionId);
  const full = booking.error instanceof ApiRequestError && booking.error.code === 'CAPACITY_FULL';
  const anyBookable = sessions.some((s) => bookability(s).ok);

  const book = () => {
    if (!chosen || booking.isPending) return;
    booking.mutate(
      { taskId: task.id, sessionId: chosen.id },
      {
        onSuccess: (appt) => {
          justBooked.current = true;
          onBooked(appt);
        },
        onError: (e) => {
          if (e instanceof ApiRequestError && e.code === 'CAPACITY_FULL') setSessionId('');
        },
      },
    );
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !booking.isPending && onOpenChange(o)}>
      <DialogContent
        className="max-h-[90dvh] overflow-y-auto sm:max-w-xl"
        // After a booking the disposition form moves focus to the outcome note; do not steal it back.
        onCloseAutoFocus={(e) => {
          if (justBooked.current) {
            justBooked.current = false;
            e.preventDefault();
          }
        }}
      >
        <DialogHeader>
          <DialogTitle>Book return visit</DialogTitle>
          <DialogDescription>
            For {task.patientName}. This uses a normal booked place, so a full session cannot be booked.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-1.5">
          <Label htmlFor="return-doctor">Doctor</Label>
          <Select
            value={doctorId}
            onValueChange={(v) => {
              setDoctorPick(v);
              setSessionId('');
              booking.reset();
            }}
          >
            <SelectTrigger id="return-doctor" className="w-full">
              <SelectValue placeholder="Choose a doctor" />
            </SelectTrigger>
            <SelectContent>
              {(doctors.data ?? []).map((d) => (
                <SelectItem key={d.id} value={d.id}>
                  {d.fullName}, {d.department}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {task.sourceVisit && doctorId === task.sourceVisit.doctorId ? (
            <p className="text-sm text-muted-foreground">The doctor from the source visit.</p>
          ) : null}
        </div>

        <div className="grid gap-1.5">
          <p className="text-sm font-bold">Session, next {HORIZON_DAYS} days</p>
          {doctors.isError ? (
            <ErrorState title="Doctors could not be loaded" error={doctors.error} onRetry={() => void doctors.refetch()} />
          ) : sessionsQ.isPending || doctors.isPending ? (
            <SkeletonRows count={4} />
          ) : sessionsQ.isError ? (
            <ErrorState title="Sessions could not be loaded" error={sessionsQ.error} onRetry={() => void sessionsQ.refetch()} />
          ) : sessions.length === 0 || !anyBookable ? (
            <EmptyState title="No session with a free place">Choose another doctor, or ask an admin to add sessions or raise capacity.</EmptyState>
          ) : (
            <div className="max-h-64 overflow-y-auto rounded-xl">
              <SessionChoiceList sessions={sessions} value={sessionId} onValueChange={setSessionId} showDate={(s) => formatLocalDate(s.sessionDate)} onEnter={book} />
            </div>
          )}
        </div>

        {full ? (
          <InlineAlert title="That session is full">
            Nobody was booked. {booking.error?.message} Choose another session; the places shown have been refreshed.
          </InlineAlert>
        ) : booking.isError ? (
          <InlineAlert title="The return visit was not booked">
            {booking.error?.message} Press Book return visit again. The same request is sent, so the patient is never booked twice.
          </InlineAlert>
        ) : null}

        <DialogFooter>
          <Button variant="outline" size="lg" onClick={() => onOpenChange(false)} disabled={booking.isPending}>
            Not now
          </Button>
          <Button size="lg" onClick={book} disabled={!chosen || booking.isPending}>
            {booking.isPending ? 'Booking…' : 'Book return visit'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
