import { useEffect, useRef, useState } from 'react';
import { connectStream, type StreamOptions, type StreamStatus } from './stream';

export interface UseStreamArgs {
  /** SSE URL (already prefixed with /api). Null disables the connection. */
  url: string | null;
  onEvent: (name: string, data: string) => void;
  /** Called on every open that follows a disconnect: refetch the snapshot (FR-09). */
  onReconnect: () => void;
  options?: StreamOptions;
}

/** Subscribes to an SSE URL for the life of the component and reports the connection status. */
export function useStream({ url, onEvent, onReconnect, options }: UseStreamArgs): StreamStatus {
  const [status, setStatus] = useState<StreamStatus>('stale');
  const eventRef = useRef(onEvent);
  const reconnectRef = useRef(onReconnect);
  const optionsRef = useRef(options);
  eventRef.current = onEvent;
  reconnectRef.current = onReconnect;
  optionsRef.current = options;

  useEffect(() => {
    if (!url) return;
    setStatus('stale');
    return connectStream(
      url,
      {
        onEvent: (name, data) => eventRef.current(name, data),
        onOpen: ({ reconnect }) => {
          if (reconnect) reconnectRef.current();
        },
        onStatus: setStatus,
      },
      optionsRef.current,
    );
  }, [url]);

  return status;
}
