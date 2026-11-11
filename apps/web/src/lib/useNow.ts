import { useEffect, useState } from 'react';

/** The current time in ms, refreshed on an interval, so "overdue" turns on while a screen stays open. */
export function useNow(intervalMs = 30_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return now;
}
