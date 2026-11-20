import { Link } from 'react-router-dom';
import type { Appointment } from '@hqms/contracts';
import { useSessionRead } from '@/api';
import { AvailabilityBanner } from '@/components/scheduling/AvailabilityBanner';
import { Button } from '@/components/ui/button';

/**
 * Doctor availability for a BOOKED appointment whose patient has not arrived (no queue entry, so no queue snapshot yet).
 * Reads the session (GET /sessions/{id}) instead. An away doctor says when they are expected back; an unavailable
 * doctor is urgent, with "Rebook with another doctor" and "Cancel appointment" one click away.
 */
export function BookedAvailability({
  appointment,
  onCancel,
  className,
}: {
  appointment: Appointment;
  onCancel: (a: Appointment) => void;
  className?: string;
}) {
  const session = useSessionRead(appointment.sessionId);
  const availability = session.data?.availability;
  if (!availability) return null;
  return (
    <AvailabilityBanner
      availability={availability}
      doctorName={session.data?.doctorName ?? appointment.doctorName}
      placement="booked"
      {...(className ? { className } : {})}
      actions={
        availability.state === 'unavailable' ? (
          <>
            <Button asChild size="lg">
              <Link to={`/patient/visits?rebook=${appointment.id}`}>Rebook with another doctor</Link>
            </Button>
            <Button variant="outline" size="lg" onClick={() => onCancel(appointment)}>
              Cancel appointment
            </Button>
          </>
        ) : null
      }
    />
  );
}
