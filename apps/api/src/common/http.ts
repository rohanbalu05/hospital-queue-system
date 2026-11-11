import type { Response } from 'express';
import { IdempotencyKey } from '@hqms/contracts';
import type { IdempotentResult } from '@hqms/db';
import { validationFailed } from './errors.js';

/** Idempotency-Key header: required on book / check-in / walk-in / reschedule (D-012). */
export function requireIdempotencyKey(header: string | undefined): string {
  if (header === undefined || header === '') throw validationFailed('Idempotency-Key header is required');
  const parsed = IdempotencyKey.safeParse(header);
  if (!parsed.success) throw validationFailed('Idempotency-Key must be 8 to 128 characters');
  return parsed.data;
}

/** Optional on creates where a retry is harmless but safe to protect (assisted registration). */
export function optionalIdempotencyKey(header: string | undefined): string | undefined {
  return header === undefined || header === '' ? undefined : requireIdempotencyKey(header);
}

/** Send the status chosen inside the transaction (or stored for a replay) and return its body. */
export function sendResult<B>(res: Response, result: IdempotentResult<B>): B {
  res.status(result.status);
  if (result.replayed) res.setHeader('Idempotency-Replayed', 'true');
  return result.body;
}

/** Hospital-local (Asia/Kolkata) calendar date of an instant, YYYY-MM-DD. */
export function localDate(at: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(at);
}
