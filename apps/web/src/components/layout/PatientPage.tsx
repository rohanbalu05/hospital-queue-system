import { useEffect, useRef, type ReactNode } from 'react';
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
  const listRef = useRef<HTMLUListElement>(null);
  const { pathname } = useLocation();
  useEffect(() => {
    // Six tabs scroll sideways on a phone: keep the current one in view.
    listRef.current
      ?.querySelector<HTMLElement>('[aria-current="page"]')
      ?.scrollIntoView?.({ inline: 'center', block: 'nearest' });
  }, []);
  return (
    <nav aria-label="Patient" className="border-b border-rule bg-surface">
      <ul ref={listRef} className="mx-auto flex max-w-2xl overflow-x-auto px-2 [scrollbar-width:none]">
        {NAV.map((n) => {
          // My visit (/patient/visit/:id) belongs to the Today tab.
          const forced = n.to === '/patient' && pathname.startsWith('/patient/visit/');
          const classes = (active: boolean) =>
            cn(
              'flex min-h-12 items-center justify-center border-b-[3px] px-3 text-center text-base leading-5 font-bold whitespace-nowrap sm:px-4',
              active ? 'border-ink text-ink' : 'border-transparent text-muted-foreground hover:text-ink',
            );
          return (
            <li key={n.to} className="shrink-0">
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
