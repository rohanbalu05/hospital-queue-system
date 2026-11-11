import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { connectStream, type StreamStatus } from './stream';
import { FakeEventSource } from './fakeEventSource';

function setup(options = {}) {
  const events: Array<[string, string]> = [];
  const opens: boolean[] = [];
  const statuses: StreamStatus[] = [];
  const stop = connectStream(
    '/api/sessions/s1/events',
    {
      onEvent: (name, data) => events.push([name, data]),
      onOpen: ({ reconnect }) => opens.push(reconnect),
      onStatus: (s) => statuses.push(s),
    },
    { factory: (url) => new FakeEventSource(url), ...options },
  );
  return { events, opens, statuses, stop };
}

describe('connectStream', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    FakeEventSource.reset();
  });
  afterEach(() => vi.useRealTimers());

  it('goes live on open and delivers queue events, treating ping as proof of life only', () => {
    const { events, opens, statuses } = setup();
    FakeEventSource.last.open();
    FakeEventSource.last.emit('ping', '');
    FakeEventSource.last.emit('queue', { queueVersion: 4 });
    expect(statuses).toEqual(['live']);
    expect(opens).toEqual([false]);
    expect(events).toEqual([['queue', '{"queueVersion":4}']]);
  });

  it('reconnects with exponential backoff and reports every open after a drop as a reconnect', () => {
    const { opens } = setup({ backoffStartMs: 1000, backoffMaxMs: 4000 });
    FakeEventSource.last.open();
    FakeEventSource.last.fail();
    expect(FakeEventSource.instances).toHaveLength(1);

    vi.advanceTimersByTime(999);
    expect(FakeEventSource.instances).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(FakeEventSource.instances).toHaveLength(2);

    // Second attempt fails too: wait is now 2 s, then capped at 4 s.
    FakeEventSource.last.fail();
    vi.advanceTimersByTime(1999);
    expect(FakeEventSource.instances).toHaveLength(2);
    vi.advanceTimersByTime(1);
    expect(FakeEventSource.instances).toHaveLength(3);
    FakeEventSource.last.fail();
    vi.advanceTimersByTime(4000);
    expect(FakeEventSource.instances).toHaveLength(4);

    FakeEventSource.last.open();
    expect(opens).toEqual([false, true]);

    // Backoff resets after a successful open.
    FakeEventSource.last.fail();
    vi.advanceTimersByTime(1000);
    expect(FakeEventSource.instances).toHaveLength(5);
  });

  it('is stale at first, then reconnecting after 5 s without a connection, then live again', () => {
    const { statuses } = setup();
    FakeEventSource.last.open();
    FakeEventSource.last.fail();
    expect(statuses).toEqual(['live', 'stale']);

    vi.advanceTimersByTime(4999);
    expect(statuses).toEqual(['live', 'stale']);
    vi.advanceTimersByTime(1);
    expect(statuses).toEqual(['live', 'stale', 'reconnecting']);

    // A retry that fails does not flip back to stale.
    FakeEventSource.last.fail();
    expect(statuses.at(-1)).toBe('reconnecting');

    vi.advanceTimersByTime(20_000);
    FakeEventSource.last.open();
    expect(statuses.at(-1)).toBe('live');
  });

  it('a connection that never opens still counts as a reconnect once it does', () => {
    const { opens } = setup();
    FakeEventSource.last.fail();
    vi.advanceTimersByTime(1000);
    FakeEventSource.last.open();
    expect(opens).toEqual([true]);
  });

  it('treats 45 s of silence as a dead connection and reconnects', () => {
    const { statuses } = setup();
    FakeEventSource.last.open();
    vi.advanceTimersByTime(30_000);
    FakeEventSource.last.emit('ping', '');
    vi.advanceTimersByTime(44_000);
    expect(FakeEventSource.instances).toHaveLength(1);
    vi.advanceTimersByTime(1000);
    expect(FakeEventSource.instances[0]?.closed).toBe(true);
    expect(statuses.at(-1)).toBe('stale');
    vi.advanceTimersByTime(1000);
    expect(FakeEventSource.instances).toHaveLength(2);
  });

  it('stops everything when closed', () => {
    const { statuses, stop } = setup();
    FakeEventSource.last.open();
    FakeEventSource.last.fail();
    stop();
    vi.advanceTimersByTime(60_000);
    expect(FakeEventSource.instances).toHaveLength(1);
    expect(statuses).toEqual(['live', 'stale']);
  });
});
