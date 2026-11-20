import { useSyncExternalStore } from 'react';

const QUERY = '(max-width: 639px)';

function subscribe(onChange: () => void): () => void {
  if (typeof window === 'undefined' || !window.matchMedia) return () => undefined;
  const mq = window.matchMedia(QUERY);
  mq.addEventListener('change', onChange);
  return () => mq.removeEventListener('change', onChange);
}

const snapshot = () => (typeof window !== 'undefined' && window.matchMedia ? window.matchMedia(QUERY).matches : false);

/** True under 640 px, where admin tables turn into stacked cards (one DOM, so tests and screen readers see each row once). */
export function useNarrow(): boolean {
  return useSyncExternalStore(subscribe, snapshot, () => false);
}
