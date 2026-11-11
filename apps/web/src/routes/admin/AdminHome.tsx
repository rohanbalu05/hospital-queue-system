import { StaffShell } from '@/components/layout/Shells';
import { EmptyState } from '@/components/queue';

/** W0 placeholder. W3 adds sessions and capacity, staff assignments, the policy view and reports. */
export default function AdminHome() {
  return (
    <StaffShell title="Administration" description="Sessions, capacity, staff assignments and reports.">
      <EmptyState title="Nothing configured here yet">
        Session capacity, staff assignments, the current queue policy and reports appear here. Reports label each figure as measured or target.
      </EmptyState>
    </StaffShell>
  );
}
