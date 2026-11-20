import { rateLimited } from './errors.js';
import { LoginRateLimiter } from '../identity/rate-limiter.js';

/**
 * Per-user request cap for cheap-looking reads that fan out to the database (alternatives, today's visits, the bell).
 * Every request counts, in a fixed one-minute window; beyond `perMinute` the answer is 429 RATE_LIMITED. In memory,
 * like the login limiter: good enough for one API process.
 */
export class PerUserRateLimit {
  private readonly limiter: LoginRateLimiter;

  constructor(perMinute: number) {
    this.limiter = new LoginRateLimiter(perMinute, 60_000);
  }

  hit(userId: string, nowMs: number = Date.now()): void {
    const retry = this.limiter.retryAfterSec(userId, nowMs);
    if (retry > 0) throw rateLimited(retry);
    this.limiter.recordFailure(userId, nowMs);
  }
}
