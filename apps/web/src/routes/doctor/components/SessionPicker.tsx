import type { Session } from '@hqms/contracts';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { formatIST } from '@/lib/format';

const STATUS_WORD: Record<Session['status'], string> = {
  scheduled: 'not started',
  open: 'open',
  paused: 'paused',
  unavailable: 'unavailable',
  closed: 'closed',
};

const LABEL_WORD: Record<Session['label'], string> = { morning: 'Morning', afternoon: 'Afternoon', evening: 'Evening' };

export function sessionTitle(s: Session): string {
  return `${LABEL_WORD[s.label]} ${formatIST(s.startsAt)} to ${formatIST(s.endsAt)}, ${s.department}, ${s.room}`;
}

interface SessionPickerProps {
  sessions: Session[];
  value: string;
  onChange: (sessionId: string) => void;
}

/** The doctor's sessions for today. */
export function SessionPicker({ sessions, value, onChange }: SessionPickerProps) {
  return (
    <div className="grid gap-1.5">
      <Label htmlFor="session-picker">Session</Label>
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger id="session-picker" className="min-w-80">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {sessions.map((s) => (
            <SelectItem key={s.id} value={s.id}>
              {sessionTitle(s)} ({STATUS_WORD[s.status]})
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
