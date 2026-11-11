import { Link, Route, Routes } from 'react-router-dom';
import { PatientPage } from '@/components/layout/PatientPage';
import { EmptyState } from '@/components/queue';
import { Button } from '@/components/ui/button';
import { useAuth } from '@/lib/auth';
import BookPage from './BookPage';
import VisitsPage from './VisitsPage';

/** W2 adds the live visit (token, position, ETA) here. */
function TodayPage() {
  const { me } = useAuth();
  return (
    <PatientPage title="My visit" {...(me ? { description: `Signed in as ${me.displayName}.` } : {})}>
      <EmptyState
        title="No visit today"
        action={
          <Button asChild size="lg">
            <Link to="/patient/book">Book appointment</Link>
          </Button>
        }
      >
        Your token, your place in the queue and the estimated wait appear here once you check in at the hospital.
      </EmptyState>
    </PatientPage>
  );
}

export default function PatientHome() {
  return (
    <Routes>
      <Route index element={<TodayPage />} />
      <Route path="book" element={<BookPage />} />
      <Route path="visits" element={<VisitsPage />} />
      <Route path="*" element={<TodayPage />} />
    </Routes>
  );
}
