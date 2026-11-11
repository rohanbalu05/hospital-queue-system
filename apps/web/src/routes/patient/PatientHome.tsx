import { Route, Routes } from 'react-router-dom';
import TodayPage from './TodayPage';
import BookPage from './BookPage';
import VisitsPage from './VisitsPage';
import DocumentsPage from './DocumentsPage';
import AssistantPage from './AssistantPage';
import FollowUpsPage from './FollowUpsPage';

export default function PatientHome() {
  return (
    <Routes>
      <Route index element={<TodayPage />} />
      <Route path="book" element={<BookPage />} />
      <Route path="visits" element={<VisitsPage />} />
      <Route path="documents" element={<DocumentsPage />} />
      <Route path="questions" element={<AssistantPage />} />
      <Route path="follow-ups" element={<FollowUpsPage />} />
      <Route path="*" element={<TodayPage />} />
    </Routes>
  );
}
