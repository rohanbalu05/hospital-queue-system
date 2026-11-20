import type { DisplaySnapshot } from '@hqms/contracts';

/**
 * A screen must never go back to an older queueVersion (FR-09). A response can be older than what is already
 * on screen when it was served by a lagging replica, or was started before a newer one finished.
 * These helpers keep whichever snapshot is newer; equal versions take the incoming one (it is the fresher read).
 */
export function keepNewest<T extends { queueVersion: number }>(held: T | undefined, incoming: T): T {
  return held !== undefined && held.queueVersion > incoming.queueVersion ? held : incoming;
}

/** Per column: the display snapshot has one version per session, so each column keeps its own newest state. */
export function keepNewestDisplay(held: DisplaySnapshot | undefined, incoming: DisplaySnapshot): DisplaySnapshot {
  if (held === undefined) return incoming;
  const heldBySession = new Map(held.columns.map((c) => [c.sessionId, c]));
  let changed = false;
  const columns = incoming.columns.map((c) => {
    const older = heldBySession.get(c.sessionId);
    if (older && older.queueVersion > c.queueVersion) {
      changed = true;
      return older;
    }
    return c;
  });
  return changed ? { ...incoming, columns } : incoming;
}
