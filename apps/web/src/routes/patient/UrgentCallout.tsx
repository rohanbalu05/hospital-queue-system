import { TriangleAlert } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { HOSPITAL_FRONT_DESK_PHONE } from '@/lib/config';
import { cn } from '@/lib/utils';

/** National emergency ambulance number shown beside the hospital front desk (PR-13). */
export const EMERGENCY_NUMBER = '108';

/** "080 4123 4500" -> "08041234500", the form a tel: link needs. */
const dialable = (phone: string) => phone.replace(/[^\d+]/g, '');

/**
 * Fixed safety-net advice for red-flag symptoms, shown above everything else about the answer. It carries the word
 * "Urgent", an icon and the advice text verbatim, so it never relies on colour alone. `announce` makes it a
 * role="alert" for the answer that has just arrived; history rows stay quiet so a screen reader does not repeat it.
 */
export function UrgentCallout({ advice, announce = false, className }: { advice: string; announce?: boolean; className?: string }) {
  return (
    <div
      data-testid="urgent-advice"
      {...(announce ? { role: 'alert' } : { role: 'group', 'aria-label': 'Urgent advice' })}
      className={cn('rounded-md border-2 border-l-[6px] border-priority bg-priority/10 p-4', className)}
    >
      <p className="flex items-center gap-2 text-xl font-bold text-priority">
        <TriangleAlert aria-hidden="true" className="size-6 shrink-0" />
        Urgent
      </p>
      <p className="mt-2 text-lg font-bold text-ink">{advice}</p>
      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        <Button asChild variant="destructive" size="lg" className="w-full text-lg">
          <a href={`tel:${EMERGENCY_NUMBER}`}>Call {EMERGENCY_NUMBER}</a>
        </Button>
        <Button asChild variant="outline" size="lg" className="h-auto min-h-12 w-full whitespace-normal py-2 text-center">
          <a href={`tel:${dialable(HOSPITAL_FRONT_DESK_PHONE)}`}>Call the hospital front desk, {HOSPITAL_FRONT_DESK_PHONE}</a>
        </Button>
      </div>
    </div>
  );
}
