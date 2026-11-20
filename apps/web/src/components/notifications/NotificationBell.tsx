import { useState } from 'react';
import { Bell } from 'lucide-react';
import { useNotifications, useRefreshOnLiveNotice, useUnreadCount } from '@/api';
import { Button } from '@/components/ui/button';
import { Sheet, SheetClose, SheetContent, SheetDescription, SheetHeader, SheetTitle, SheetTrigger } from '@/components/ui/sheet';
import { cn } from '@/lib/utils';
import { NotificationPanel } from './NotificationPanel';

/** "Notifications" or "Notifications, 3 unread": the name a screen reader gets for the bell. */
export function bellLabel(unread: number): string {
  return unread > 0 ? `Notifications, ${unread} unread` : 'Notifications';
}

/**
 * The bell in every shell header. The unread count polls every 15 s, refetches on window focus and whenever a live queue
 * snapshot on this screen is refreshed by a version notice. Opening it shows the list in a sheet (full width on a phone).
 */
export function NotificationBell({ compact = false }: { compact?: boolean }) {
  const [open, setOpen] = useState(false);
  const unread = useUnreadCount();
  const list = useNotifications({ enabled: open });
  useRefreshOnLiveNotice();
  const count = unread.data?.unreadCount ?? 0;

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>
        <button
          type="button"
          aria-label={bellLabel(count)}
          data-testid="notification-bell"
          className={cn(
            'relative inline-flex shrink-0 items-center justify-center rounded-md border border-white/50 text-white transition-colors hover:bg-white hover:text-ink focus-visible:outline-white',
            compact ? 'h-10 w-10' : 'h-12 w-12',
          )}
        >
          <Bell aria-hidden="true" className="size-5" />
          {count > 0 ? (
            <span
              aria-hidden="true"
              data-testid="notification-count"
              className="absolute -top-1.5 -right-1.5 flex h-5 min-w-5 items-center justify-center rounded-full bg-white px-1 text-xs leading-none font-bold text-ink tabular-nums ring-2 ring-ink"
            >
              {count > 99 ? '99+' : count}
            </span>
          ) : null}
        </button>
      </SheetTrigger>
      <SheetContent side="right" showCloseButton={false} className="w-full gap-0 sm:max-w-md" aria-describedby="notifications-desc">
        <SheetHeader className="flex-row items-start justify-between gap-3 border-b border-rule bg-surface px-4 py-3">
          <div className="min-w-0">
            <SheetTitle className="text-lg">Notifications</SheetTitle>
            <SheetDescription id="notifications-desc" className="text-sm">
              Newest first. Times are Bengaluru time.
            </SheetDescription>
          </div>
          <SheetClose asChild>
            <Button variant="outline" size="lg">
              Close
            </Button>
          </SheetClose>
        </SheetHeader>
        <NotificationPanel query={list} onNavigate={() => setOpen(false)} />
      </SheetContent>
    </Sheet>
  );
}
