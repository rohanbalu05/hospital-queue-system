import { useEffect, useState } from 'react';
import { HOSPITAL_TIMEZONE } from '@hqms/contracts';

/** Today's date in hospital-local time (Asia/Kolkata) as YYYY-MM-DD, whatever the browser's zone. */
export function todayIST(now: Date = new Date()): string {
  // The en-CA locale formats as YYYY-MM-DD.
  return new Intl.DateTimeFormat('en-CA', { timeZone: HOSPITAL_TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

/** Today's IST date, re-checked every minute so an all-day screen rolls over at midnight. */
export function useTodayIST(): string {
  const [today, setToday] = useState(() => todayIST());
  useEffect(() => {
    const id = setInterval(() => setToday(todayIST()), 60_000);
    return () => clearInterval(id);
  }, []);
  return today;
}

/** Build an instant from an IST date and an "HH:MM" time (24 h, as <input type="time"> gives). */
export function istInstant(date: string, hhmm: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{2}:\d{2}$/.test(hhmm)) return null;
  const d = new Date(`${date}T${hhmm}:00+05:30`);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}
