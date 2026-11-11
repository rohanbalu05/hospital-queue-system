import { cn } from '@/lib/utils';

interface CapacityBarProps {
  /** Booked slots reserved (appointments), of `bookedCapacity` (policy default 10). */
  booked: number;
  bookedCapacity: number;
  /** Walk-in slots used, of `walkinCapacity` (policy default 5). */
  walkin: number;
  walkinCapacity: number;
  className?: string;
}

function Cells({ used, total, fill }: { used: number; total: number; fill: string }) {
  return (
    <div className="flex gap-0.5" aria-hidden="true">
      {Array.from({ length: total }, (_, i) => (
        <span key={i} className={cn('h-3 min-w-0 flex-1 rounded-xs border', i < used ? `${fill} border-transparent` : 'border-rule bg-surface')} />
      ))}
    </div>
  );
}

/** Session capacity: booked x/10 and walk-in y/5, always with the numbers in text. */
export function CapacityBar({ booked, bookedCapacity, walkin, walkinCapacity, className }: CapacityBarProps) {
  const bookedFull = booked >= bookedCapacity;
  const walkinFull = walkin >= walkinCapacity;
  return (
    <div className={cn('grid gap-3 sm:grid-cols-[2fr_1fr]', className)}>
      <div>
        <div className="mb-1 flex items-baseline justify-between text-sm">
          <span className="font-bold">Booked</span>
          <span className="tabular-nums">
            <span className="font-bold">{booked}</span>/{bookedCapacity}
            {bookedFull ? <span className="ml-1 text-muted-foreground">full</span> : null}
          </span>
        </div>
        <Cells used={booked} total={bookedCapacity} fill="bg-appt" />
      </div>
      <div>
        <div className="mb-1 flex items-baseline justify-between text-sm">
          <span className="font-bold">Walk-in</span>
          <span className="tabular-nums">
            <span className="font-bold">{walkin}</span>/{walkinCapacity}
            {walkinFull ? <span className="ml-1 text-muted-foreground">full</span> : null}
          </span>
        </div>
        <Cells used={walkin} total={walkinCapacity} fill="bg-walkin" />
      </div>
    </div>
  );
}
