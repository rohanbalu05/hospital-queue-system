import type { ReactNode } from 'react';
import { Link, NavLink, useLocation } from 'react-router-dom';
import { PatientShell } from '@/components/layout/Shells';
import { cn } from '@/lib/utils';

const NAV = [
  { to: '/patient', label: 'Today', end: true },
  { to: '/patient/book', label: 'Book', end: false },
  { to: '/patient/visits', label: 'My visits', end: false },
  { to: '/patient/documents', label: 'Documents', end: false },
  { to: '/patient/questions', label: 'Questions', end: false },
  { to: '/patient/follow-ups', label: 'Follow-ups', end: false },
] as const;

function PatientNav() {
  const { pathname } = useLocation();
  return (
    <nav aria-label="Patient" className="border-b border-rule bg-surface">
      {/* Six tabs: two rows of three on a phone so no label is clipped or hidden behind a scroll; one row from 640 px. */}
      <ul className="mx-auto grid max-w-2xl grid-cols-3 px-2 sm:flex">
        {NAV.map((n) => {
          // My visit (/patient/visit/:id) belongs to the Today tab.
          const forced = n.to === '/patient' && pathname.startsWith('/patient/visit/');
          const classes = (active: boolean) =>
            cn(
              'flex min-h-12 items-center justify-center border-b-[3px] px-2 text-center text-base leading-5 font-bold whitespace-nowrap sm:px-4',
              active ? 'border-ink text-ink' : 'border-transparent text-muted-foreground hover:text-ink',
            );
          return (
            <li key={n.to} className="sm:shrink-0">
              {forced ? (
                <Link to={n.to} aria-current="page" className={classes(true)}>
                  {n.label}
                </Link>
              ) : (
                <NavLink to={n.to} end={n.end} className={({ isActive }) => classes(isActive)}>
                  {n.label}
                </NavLink>
              )}
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

/** Wraps a patient page in the shell with the patient navigation. */
export function PatientPage({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: ReactNode;
}) {
  return (
    <PatientShell title={title} nav={<PatientNav />} {...(description ? { description } : {})}>
      {children}
    </PatientShell>
  );
}
