import type { ReactNode } from 'react';
import { NavLink } from 'react-router-dom';
import { PatientShell } from '@/components/layout/Shells';
import { cn } from '@/lib/utils';

const NAV = [
  { to: '/patient', label: 'Today', end: true },
  { to: '/patient/book', label: 'Book', end: false },
  { to: '/patient/visits', label: 'My visits', end: false },
] as const;

function PatientNav() {
  return (
    <nav aria-label="Patient" className="border-b border-rule bg-surface">
      <ul className="mx-auto flex max-w-2xl px-2">
        {NAV.map((n) => (
          <li key={n.to} className="min-w-0 flex-1 sm:flex-none">
            <NavLink
              to={n.to}
              end={n.end}
              className={({ isActive }) =>
                cn(
                  'flex min-h-12 items-center justify-center border-b-[3px] px-3 text-center text-base leading-5 font-bold sm:px-4',
                  isActive ? 'border-ink text-ink' : 'border-transparent text-muted-foreground hover:text-ink',
                )
              }
            >
              {n.label}
            </NavLink>
          </li>
        ))}
      </ul>
    </nav>
  );
}

/** Wraps a patient page in the shell with the patient navigation. */
export function PatientPage({ title, description, children }: { title: string; description?: string; children: ReactNode }) {
  return (
    <PatientShell title={title} nav={<PatientNav />} {...(description ? { description } : {})}>
      {children}
    </PatientShell>
  );
}

