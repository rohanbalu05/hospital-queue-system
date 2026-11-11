import type { Session } from '@hqms/contracts';
import { formatIST } from '@/lib/format';
import { cn } from '@/lib/utils';
import { Choice, ChoiceList } from './choice';

const LABEL_WORD: Record<Session['label'], string> = { morning: 'Morning', afternoon: 'Afternoon', evening: 'Evening' };
export const sessionLabelWord = (s: Pick<Session, 'label'>) => LABEL_WORD[s.label];

export const sessionTimes = (s: Pick<Session, 'startsAt' | 'endsAt'>) => `${formatIST(s.startsAt)} to ${formatIST(s.endsAt)}`;

/** Places left for booking in a session. */
export function placesLeft(s: Session): { left: number; of: number } {
  return { left: s.capacity.bookedAvailable, of: s.capacity.bookedCapacity };
}

export type Bookability = { ok: true } | { ok: false; reason: 'full' | 'unavailable' | 'ended' };

export function bookability(s: Session, now: number = Date.now()): Bookability {
  if (new Date(s.endsAt).getTime() <= now) return { ok: false, reason: 'ended' };
  if (s.status !== 'scheduled' && s.status !== 'open') return { ok: false, reason: 'unavailable' };
  if (s.capacity.bookedAvailable <= 0) return { ok: false, reason: 'full' };
  return { ok: true };
}

export function PlacesLeft({ session, className }: { session: Session; className?: string }) {
  const b = bookability(session);
  const { left, of } = placesLeft(session);
  if (!b.ok && b.reason === 'unavailable') return <span className={className}>Not available</span>;
  if (!b.ok && b.reason === 'ended') return <span className={className}>Ended</span>;
  return (
    <span className={cn(className)}>
      {b.ok ? (
        <>
          <span className="font-bold">{left}</span> of {of} places left
        </>
      ) : (
        <>Full, 0 of {of} places left</>
      )}
    </span>
  );
}

interface SessionChoiceListProps {
  sessions: Session[];
  value: string;
  onValueChange: (id: string) => void;
  onEnter?: () => void;
  /** Prefix each row with a date, for lists that span several days. */
  showDate?: (s: Session) => string;
}

/** Radio list of sessions: "Morning, 9:00 am to 1:00 pm", with "x of 10 places left". Full sessions are disabled. */
export function SessionChoiceList({ sessions, value, onValueChange, onEnter, showDate }: SessionChoiceListProps) {
  return (
    <ChoiceList label="Session" value={value} onValueChange={onValueChange} {...(onEnter ? { onEnter } : {})}>
      {sessions.map((s) => (
        <Choice
          key={s.id}
          value={s.id}
          disabled={!bookability(s).ok}
          title={showDate ? showDate(s) : sessionLabelWord(s)}
          detail={showDate ? `${sessionLabelWord(s)}, ${sessionTimes(s)}` : sessionTimes(s)}
          aside={<PlacesLeft session={s} />}
        />
      ))}
    </ChoiceList>
  );
}
