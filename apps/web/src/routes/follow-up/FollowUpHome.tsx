import { StaffShell } from '@/components/layout/Shells';
import { EmptyState } from '@/components/queue';

/** W0 placeholder. W3 adds the owned-task inbox, task detail and Book return visit. */
export default function FollowUpHome() {
  return (
    <StaffShell title="Follow-up tasks" description="Tasks assigned to you, with due times and the visit they came from.">
      <EmptyState title="No tasks assigned">
        Your owned follow-up tasks appear here, with due and overdue times, the patient and the source visit.
      </EmptyState>
    </StaffShell>
  );
}
