import { NavLink } from 'react-router-dom';
import { cn } from '@/lib/utils';

interface SectionNavProps {
  label: string;
  items: ReadonlyArray<{ to: string; label: string; end?: boolean }>;
  className?: string;
}

/** Underlined section links for staff areas (admin, follow-up). Same look as the doctor console tabs. */
export function SectionNav({ label, items, className }: SectionNavProps) {
  return (
    <nav aria-label={label} className={cn('mb-4 flex flex-wrap gap-x-6 border-b border-rule', className)}>
      {items.map((i) => (
        <NavLink
          key={i.to}
          to={i.to}
          end={i.end ?? false}
          className={({ isActive }) =>
            cn(
              'inline-flex h-10 items-center border-b-2 px-1 font-bold',
              isActive ? 'border-ink text-ink' : 'border-transparent text-muted-foreground hover:text-ink',
            )
          }
        >
          {i.label}
        </NavLink>
      ))}
    </nav>
  );
}
