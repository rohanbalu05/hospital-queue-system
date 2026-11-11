import { StaffShell } from '@/components/layout/Shells';
import { EmptyState } from '@/components/queue';

/** W0 placeholder. W2 adds the Now panel, Call next with its reason, and the waiting list. */
export default function DoctorHome() {
  return (
    <StaffShell title="Doctor console" description="Your session, the patient in service and who is next.">
      <EmptyState title="No session running">
        The patient in service, Call next and the reason for each call appear here once your session starts.
      </EmptyState>
    </StaffShell>
  );
}
