/**
 * Source of "now" for every rule that depends on time (booking window, arrival classification,
 * eligibility). Production uses the system clock; tests replace the CLOCK provider with a controllable
 * one. There is deliberately no HTTP route that changes the clock.
 */
export interface Clock {
  now(): Date;
}

export class SystemClock implements Clock {
  now(): Date {
    return new Date();
  }
}

/** Test double: starts at the real time, can be set or advanced. */
export class FakeClock implements Clock {
  private current: Date | null = null;
  now(): Date {
    return this.current ? new Date(this.current) : new Date();
  }
  set(at: Date | string): void {
    this.current = new Date(at);
  }
  /** Back to the real system time. */
  reset(): void {
    this.current = null;
  }
}
