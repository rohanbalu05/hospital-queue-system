import { toast } from 'sonner';
import type { Appointment } from '@hqms/contracts';
import { useCancelAppointment } from '@/api';
import { InlineAlert } from '@/components/scheduling/status';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { ApiRequestError } from '@/lib/api';
import { formatLocalDate, istDate } from '@/lib/dates';
import { formatIST } from '@/lib/format';

/** "Cancel this appointment?" confirmation shared by My visits, Today and the rebook panel. */
export function CancelDialog({
  appointment,
  onClose,
  onCancelled,
}: {
  appointment: Appointment | null;
  onClose: () => void;
  onCancelled?: (appointment: Appointment) => void;
}) {
  const cancel = useCancelAppointment();
  const err = cancel.error instanceof ApiRequestError ? cancel.error : null;
  const close = () => {
    cancel.reset();
    onClose();
  };
  return (
    <Dialog open={appointment !== null} onOpenChange={(o) => !o && close()}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto p-4 sm:p-6">
        <DialogHeader>
          <DialogTitle>Cancel this appointment?</DialogTitle>
          <DialogDescription className="text-base">
            {appointment ? (
              <>
                {appointment.doctorName}, {formatLocalDate(istDate(appointment.scheduledAt))}, {formatIST(appointment.scheduledAt)}. Your place is released so another patient can book it.
              </>
            ) : null}
          </DialogDescription>
        </DialogHeader>
        {err ? <InlineAlert title="The appointment was not cancelled">{err.message}</InlineAlert> : null}
        <DialogFooter>
          <Button variant="outline" size="lg" onClick={close} disabled={cancel.isPending}>
            Keep appointment
          </Button>
          <Button
            variant="destructive"
            size="lg"
            disabled={cancel.isPending}
            onClick={() =>
              appointment &&
              cancel.mutate(
                { appointmentId: appointment.id },
                {
                  onSuccess: (done) => {
                    toast.success('Cancelled', { description: 'Your place has been released.' });
                    onCancelled?.(done);
                    close();
                  },
                },
              )
            }
          >
            {cancel.isPending ? 'Cancelling…' : 'Cancel appointment'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
