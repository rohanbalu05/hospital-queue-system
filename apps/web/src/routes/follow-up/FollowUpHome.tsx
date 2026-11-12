import { Navigate, Route, Routes } from 'react-router-dom';
import InboxPage from './InboxPage';
import TaskDetailPage from './TaskDetailPage';

/** Follow-up staff: owned-task inbox (FR-11) and task detail with disposition and "Book return visit". */
export default function FollowUpHome() {
  return (
    <Routes>
      <Route index element={<InboxPage />} />
      <Route path="tasks/:taskId" element={<TaskDetailPage />} />
      <Route path="*" element={<Navigate to="/follow-up" replace />} />
    </Routes>
  );
}
