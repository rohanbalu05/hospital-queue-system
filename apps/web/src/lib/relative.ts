import { istDate } from './dates';
import { formatIST } from './format';

/**
 * "just now", "5 min ago", "2 h ago" for the first day, then the hospital-local (IST) date and time.
 * Always paired with the clock time by the caller, so the relative part can stay coarse.
 */
export function relativeTime(value: string | Date, now: number | Date = Date.now()): string {
  const then = value instanceof Date ? value.getTime() : new Date(value).getTime();
  const at = now instanceof Date ? now.getTime() : now;
  const minutes = Math.floor((at - then) / 60_000);
  if (Number.isNaN(minutes) || minutes < 0) return 'just now';
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  if (minutes < 24 * 60 && istDate(new Date(then)) === istDate(new Date(at))) return `${Math.floor(minutes / 60)} h ago`;
  const yesterday = istDate(new Date(at - 24 * 3_600_000));
  if (istDate(new Date(then)) === yesterday) return 'Yesterday';
  return formatIST(value, 'date');
}

/** "5 min ago, 10:00 am" or "Yesterday, 4:30 pm" or "3 Nov 2026, 9:10 am". */
export function relativeWithClock(value: string | Date, now: number | Date = Date.now()): string {
  return `${relativeTime(value, now)}, ${formatIST(value, 'time')}`;
}
