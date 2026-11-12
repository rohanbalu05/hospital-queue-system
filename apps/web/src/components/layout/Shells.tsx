import type { ReactNode } from 'react';
import { LogOut } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ROLE_LABEL, useAuth } from '@/lib/auth';
import { HOSPITAL_NAME, HOSPITAL_SHORT_NAME } from '@/lib/config';
import { cn } from '@/lib/utils';

function SkipLink() {
  return (
    <a
      href="#main"
      className="sr-only rounded-md bg-surface px-3 py-2 font-bold text-ink focus:not-sr-only focus:absolute focus:top-2 focus:left-2 focus:z-50"
    >
      Skip to main content
    </a>
  );
}

/** Ink band with the hospital name, like the header of a wayfinding sign. Shared by every shell. */
function TopBar({ compact }: { compact: boolean }) {
  const { me, logout } = useAuth();
  return (
    <header className={cn('bg-ink text-white', compact ? 'h-12' : 'h-14')}>
      <div className={cn('mx-auto flex h-full items-center gap-3 px-4', compact ? 'max-w-none' : 'max-w-2xl')}>
        <span className={cn('min-w-0 truncate font-bold', compact ? 'text-base' : 'text-base sm:text-lg')}>
          <span className="sm:hidden">{HOSPITAL_SHORT_NAME}</span>
          <span className="hidden sm:inline">{HOSPITAL_NAME}</span>
        </span>
        <div className="ml-auto flex items-center gap-3">
          {me ? (
            <p className="hidden min-w-0 truncate text-sm sm:block">
              <span className="font-bold">{me.displayName}</span>
              <span className="ml-2 rounded-xs bg-white/15 px-1.5 py-0.5 text-xs font-bold">{ROLE_LABEL[me.role]}</span>
            </p>
          ) : null}
          <Button
            variant="outline"
            size={compact ? 'default' : 'lg'}
            onClick={() => void logout()}
            className="border-white/50 bg-transparent text-white hover:bg-white hover:text-ink focus-visible:outline-white"
          >
            <LogOut aria-hidden="true" />
            Sign out
          </Button>
        </div>
      </div>
    </header>
  );
}

interface ShellProps {
  title: string;
  /** One line under the title, e.g. the date and the doctor in view. */
  description?: string;
  actions?: ReactNode;
  children: ReactNode;
}

/** Staff shell: compact 48px bar, dense body at 14px. */
export function StaffShell({ title, description, actions, children }: ShellProps) {
  return (
    <div className="min-h-dvh bg-paper">
      <SkipLink />
      <TopBar compact />
      <main id="main" className="px-4 py-4 text-sm">
        <div className="mb-4 flex flex-wrap items-end gap-x-4 gap-y-2">
          <div className="min-w-0">
            <h1 className="text-xl font-bold">{title}</h1>
            {description ? <p className="text-muted-foreground">{description}</p> : null}
          </div>
          {actions ? <div className="ml-auto flex items-center gap-2">{actions}</div> : null}
        </div>
        {children}
      </main>
    </div>
  );
}

/** Patient shell: spacious, 16px body, mobile-first single column. */
export function PatientShell({ title, description, nav, children }: Omit<ShellProps, 'actions'> & { nav?: ReactNode }) {
  return (
    <div className="min-h-dvh bg-paper text-base">
      <SkipLink />
      <TopBar compact={false} />
      {nav}
      <main id="main" className="mx-auto max-w-2xl px-4 py-6 sm:py-8">
        <h1 className="text-2xl font-bold">{title}</h1>
        {description ? <p className="mt-1 text-muted-foreground">{description}</p> : null}
        <div className="mt-6">{children}</div>
      </main>
    </div>
  );
}
