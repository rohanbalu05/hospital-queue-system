import { HOSPITAL_TIMEZONE, type LocalDate } from '@hqms/contracts';
import { formatIST, type ISTStyle } from './format';

const ymd = new Intl.DateTimeFormat('en-CA', {
  timeZone: HOSPITAL_TIMEZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

/** The hospital-local calendar date (Asia/Kolkata) of an instant, as YYYY-MM-DD. */
export function istDate(at: Date | number | string = new Date()): LocalDate {
  return ymd.format(at instanceof Date ? at : new Date(at));
}

/** Add whole days to a YYYY-MM-DD date. IST has no daylight saving, so noon-UTC arithmetic is safe. */
export function addDays(date: LocalDate, days: number): LocalDate {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Today and the next `count - 1` days in IST. */
export function nextDays(count: number, from: Date = new Date()): LocalDate[] {
  const start = istDate(from);
  return Array.from({ length: count }, (_, i) => addDays(start, i));
}

/** "Thu, 12 Nov" for a hospital-local calendar date. */
export function formatLocalDate(date: LocalDate, style: ISTStyle = 'weekday-date'): string {
  return formatIST(`${date}T12:00:00+05:30`, style);
}

/** Whole minutes between two instants (b - a), rounded down. */
export function minutesBetween(a: string | Date, b: string | Date): number {
  return Math.floor((new Date(b).getTime() - new Date(a).getTime()) / 60_000);
}
