import { PatientShell } from '@/components/layout/Shells';
import { EmptyState } from '@/components/queue';
import { useAuth } from '@/lib/auth';

/** W0 placeholder. W1 adds booking; W2 adds My visit; W3 adds documents, follow-ups and the assistant. */
export default function PatientHome() {
  const { me } = useAuth();
  return (
    <PatientShell title="My visit" description={me ? `Signed in as ${me.displayName}.` : undefined}>
      <EmptyState title="No visit today">
        Your token, your place in the queue and the estimated wait appear here once you check in. Booking an appointment opens from this screen.
      </EmptyState>
    </PatientShell>
  );
}
