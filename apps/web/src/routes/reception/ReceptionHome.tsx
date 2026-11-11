import { StaffShell } from '@/components/layout/Shells';
import { EmptyState } from '@/components/queue';

/** W0 placeholder. W1 adds arrivals search and check-in; W2 adds the session board lanes. */
export default function ReceptionHome() {
  return (
    <StaffShell title="Reception desk" description="Arrivals, walk-ins and the session board for your doctors.">
      <EmptyState title="Nothing to show yet">
        Arrivals and the session board appear here. Search by name, phone or appointment to check someone in.
      </EmptyState>
    </StaffShell>
  );
}
