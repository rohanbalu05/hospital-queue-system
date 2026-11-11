import { HOSPITAL_TIMEZONE } from '@hqms/contracts';

export type ISTStyle = 'time' | 'time-seconds' | 'date' | 'date-time' | 'weekday-date';

const OPTIONS: Record<ISTStyle, Intl.DateTimeFormatOptions> = {
  time: { hour: 'numeric', minute: '2-digit', hour12: true },
  'time-seconds': { hour: 'numeric', minute: '2-digit', second: '2-digit', hour12: true },
  date: { day: 'numeric', month: 'short', year: 'numeric' },
  'date-time': { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', hour12: true },
  'weekday-date': { weekday: 'short', day: 'numeric', month: 'short' },
};

const cache = new Map<ISTStyle, Intl.DateTimeFormat>();

function formatter(style: ISTStyle): Intl.DateTimeFormat {
  let f = cache.get(style);
  if (!f) {
    f = new Intl.DateTimeFormat('en-IN', { ...OPTIONS[style], timeZone: HOSPITAL_TIMEZONE });
    cache.set(style, f);
  }
  return f;
}

/**
 * Render an instant in hospital-local time (Asia/Kolkata), whatever the browser's own zone.
 * Every time the UI shows goes through this helper (CLAUDE.md: UI renders Asia/Kolkata).
 * Returns an em-free placeholder "-" for null/invalid input so tables never show "Invalid Date".
 */
export function formatIST(value: string | number | Date | null | undefined, style: ISTStyle = 'time'): string {
  if (value === null || value === undefined) return '-';
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return '-';
  return formatter(style).format(d).replace(/\s?(am|pm)$/i, (_m, mer: string) => ` ${mer.toLowerCase()}`);
}

/** "about 25-40 min" style range for ETAs; callers pass minutes. */
export function formatMinuteRange(low: number, high: number): string {
  const l = Math.round(low);
  const h = Math.round(high);
  return l === h ? `about ${l} min` : `about ${l}–${h} min`;
}
