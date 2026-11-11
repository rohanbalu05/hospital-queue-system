/**
 * Small in-memory failure counter for login attempts, keyed by IP + email. Good enough for one API
 * process; a shared store is a later step if the API is scaled out.
 */
export class LoginRateLimiter {
  private readonly failures = new Map<string, { count: number; resetAt: number }>();

  constructor(
    private readonly max: number,
    private readonly windowMs: number,
  ) {}

  /** Seconds until another attempt is allowed, or 0 when the key may try. */
  retryAfterSec(key: string, nowMs: number): number {
    const e = this.failures.get(key);
    if (!e) return 0;
    if (e.resetAt <= nowMs) {
      this.failures.delete(key);
      return 0;
    }
    return e.count >= this.max ? Math.ceil((e.resetAt - nowMs) / 1000) : 0;
  }

  recordFailure(key: string, nowMs: number): void {
    const e = this.failures.get(key);
    if (!e || e.resetAt <= nowMs) {
      this.failures.set(key, { count: 1, resetAt: nowMs + this.windowMs });
      if (this.failures.size > 10_000) this.prune(nowMs);
    } else {
      e.count += 1;
    }
  }

  recordSuccess(key: string): void {
    this.failures.delete(key);
  }

  private prune(nowMs: number): void {
    for (const [k, v] of this.failures) if (v.resetAt <= nowMs) this.failures.delete(k);
  }
}
