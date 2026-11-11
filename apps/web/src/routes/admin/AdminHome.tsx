import { Navigate, Route, Routes } from 'react-router-dom';
import { SectionNav } from '@/components/layout/SectionNav';
import { StaffShell } from '@/components/layout/Shells';
import AuditPage from './AuditPage';
import PolicyPage from './PolicyPage';
import ReportsPage from './ReportsPage';
import SessionsPage from './SessionsPage';
import StaffPage from './StaffPage';

const NAV = [
  { to: '/admin', label: 'Sessions and capacity', end: true },
  { to: '/admin/staff', label: 'Staff assignments' },
  { to: '/admin/policy', label: 'Current policy' },
  { to: '/admin/reports', label: 'Reports' },
  { to: '/admin/audit', label: 'Audit trail' },
] as const;

/** Admin: session capacity, staff assignments, the read-only policy, measured vs target reports, audit. */
export default function AdminHome() {
  return (
    <StaffShell title="Administration" description="Sessions, capacity, staff assignments, policy, reports and the audit trail.">
      <SectionNav label="Admin sections" items={NAV} />
      <Routes>
        <Route index element={<SessionsPage />} />
        <Route path="staff" element={<StaffPage />} />
        <Route path="policy" element={<PolicyPage />} />
        <Route path="reports" element={<ReportsPage />} />
        <Route path="audit" element={<AuditPage />} />
        <Route path="*" element={<Navigate to="/admin" replace />} />
      </Routes>
    </StaffShell>
  );
}
