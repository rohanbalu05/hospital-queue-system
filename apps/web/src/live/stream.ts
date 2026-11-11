/**
 * SSE connection controller (FR-09). Framework-free so it can be tested with a fake EventSource and fake timers.
 *
 * - Connects with credentials, listens for `queue` events, ignores `ping` except as proof of life.
 * - On error it closes and reconnects with exponential backoff (browsers do not retry after an HTTP error).
 * - Every open after the first one is reported as a reconnect so the caller refetches the snapshot.
 * - Silence for longer than the watchdog (three missed 15 s pings) counts as a dead connection.
 */

/** Live = connected. Stale = disconnected for up to 5 s (screen may be behind). Reconnecting = disconnected > 5 s. */
export type StreamStatus = 'live' | 'stale' | 'reconnecting';

/** FR-09: a disconnect longer than 5 s shows "Reconnecting…". */
export const RECONNECT_BANNER_MS = 5000;
export const BACKOFF_START_MS = 1000;
export const BACKOFF_MAX_MS = 15000;
/** The server pings every 15 s; 45 s of silence means the socket is dead even though the browser has not noticed. */
export const WATCHDOG_MS = 45000;

export interface EventSourceLike {
  readonly readyState: number;
  onopen: ((ev: Event) => void) | null;
  onerror: ((ev: Event) => void) | null;
  addEventListener(type: string, listener: (ev: MessageEvent) => void): void;
  close(): void;
}

export type EventSourceFactory = (url: string) => EventSourceLike;

export const defaultEventSourceFactory: EventSourceFactory = (url) =>
  new EventSource(url, { withCredentials: true }) as unknown as EventSourceLike;

export interface StreamHandlers {
  /** A named event arrived (`queue` carries a QueueVersionNotice as JSON). */
  onEvent: (name: string, data: string) => void;
  /** The connection opened. `reconnect` is true for every open that follows a disconnect. Refetch the snapshot. */
  onOpen: (info: { reconnect: boolean }) => void;
  onStatus: (status: StreamStatus) => void;
}

export interface StreamOptions {
  factory?: EventSourceFactory;
  backoffStartMs?: number;
  backoffMaxMs?: number;
  reconnectBannerMs?: number;
  watchdogMs?: number;
}

/** Event names the server sends. */
export const STREAM_EVENTS = ['queue', 'ping'] as const;

export function connectStream(url: string, handlers: StreamHandlers, options: StreamOptions = {}): () => void {
  const factory = options.factory ?? defaultEventSourceFactory;
  const backoffStart = options.backoffStartMs ?? BACKOFF_START_MS;
  const backoffMax = options.backoffMaxMs ?? BACKOFF_MAX_MS;
  const bannerMs = options.reconnectBannerMs ?? RECONNECT_BANNER_MS;
  const watchdogMs = options.watchdogMs ?? WATCHDOG_MS;

  let source: EventSourceLike | null = null;
  let closed = false;
  let opened = false;
  let disconnected = false;
  let attempt = 0;
  let status: StreamStatus = 'stale';
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let bannerTimer: ReturnType<typeof setTimeout> | undefined;
  let watchdog: ReturnType<typeof setTimeout> | undefined;

  const setStatus = (next: StreamStatus) => {
    if (next === status) return;
    status = next;
    handlers.onStatus(next);
  };

  const armWatchdog = () => {
    clearTimeout(watchdog);
    watchdog = setTimeout(() => {
      handleDisconnect();
    }, watchdogMs);
  };

  const teardownSource = () => {
    if (source) {
      source.onopen = null;
      source.onerror = null;
      source.close();
      source = null;
    }
    clearTimeout(watchdog);
  };

  const handleDisconnect = () => {
    if (closed) return;
    teardownSource();
    disconnected = true;
    setStatus(status === 'reconnecting' ? 'reconnecting' : 'stale');
    if (bannerTimer === undefined) {
      bannerTimer = setTimeout(() => {
        bannerTimer = undefined;
        if (!closed && status !== 'live') setStatus('reconnecting');
      }, bannerMs);
    }
    const delay = Math.min(backoffMax, backoffStart * 2 ** attempt);
    attempt += 1;
    clearTimeout(retryTimer);
    retryTimer = setTimeout(connect, delay);
  };

  function connect() {
    if (closed) return;
    const es = factory(url);
    source = es;
    es.onopen = () => {
      if (closed || source !== es) return;
      const reconnect = opened || disconnected;
      opened = true;
      disconnected = false;
      attempt = 0;
      clearTimeout(bannerTimer);
      bannerTimer = undefined;
      setStatus('live');
      armWatchdog();
      handlers.onOpen({ reconnect });
    };
    es.onerror = () => {
      if (closed || source !== es) return;
      handleDisconnect();
    };
    for (const name of STREAM_EVENTS) {
      es.addEventListener(name, (ev) => {
        if (closed || source !== es) return;
        armWatchdog();
        if (name !== 'ping') handlers.onEvent(name, typeof ev.data === 'string' ? ev.data : '');
      });
    }
  }

  connect();

  return () => {
    closed = true;
    clearTimeout(retryTimer);
    clearTimeout(bannerTimer);
    teardownSource();
  };
}
