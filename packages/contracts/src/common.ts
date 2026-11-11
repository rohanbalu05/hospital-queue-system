import { z } from 'zod';

/** UUID identifier. */
export const Id = z.string().uuid();
export type Id = z.infer<typeof Id>;

/** ISO-8601 instant with offset (stored as timestamptz; UI renders Asia/Kolkata). */
export const Instant = z.string().datetime({ offset: true });
export type Instant = z.infer<typeof Instant>;

/** Hospital-local calendar date, YYYY-MM-DD. */
export const LocalDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
export type LocalDate = z.infer<typeof LocalDate>;

export const HOSPITAL_TIMEZONE = 'Asia/Kolkata';

export const Role = z.enum(['patient', 'reception', 'doctor', 'followup', 'admin']);
export type Role = z.infer<typeof Role>;

/** Idempotency key header for every state-changing POST (report §6.5). */
export const IDEMPOTENCY_HEADER = 'idempotency-key';
export const IdempotencyKey = z.string().min(8).max(128);

/** Every non-2xx response body. */
export const ErrorCode = z.enum([
  'VALIDATION_FAILED',
  'UNAUTHENTICATED',
  'FORBIDDEN',
  'NOT_FOUND',
  'CONFLICT', // generic stale state / version conflict
  'IDEMPOTENCY_KEY_REUSED', // same key, different request hash
  'CAPACITY_FULL',
  'INVALID_CAPACITY_REDUCTION',
  'INVALID_TRANSITION',
  'DOCTOR_OCCUPIED', // call-next while doctor has an outstanding called/in-service entry
  'SESSION_NOT_CALLABLE', // paused, unavailable or closed
  'LATE_ARRIVAL_REQUIRES_REVIEW',
  'UPLOAD_TOO_LARGE',
  'UPLOAD_TOO_MANY_PAGES',
  'UNSUPPORTED_MEDIA_TYPE',
  'RATE_LIMITED',
  'INTERNAL',
  'SERVICE_UNAVAILABLE', // database connection lost or unavailable; retry with the same Idempotency-Key
]);
export type ErrorCode = z.infer<typeof ErrorCode>;

export const ApiError = z.object({
  error: z.object({
    code: ErrorCode,
    message: z.string(),
    details: z.unknown().optional(),
    correlationId: z.string().optional(),
  }),
});
export type ApiError = z.infer<typeof ApiError>;

/** Optimistic version carried by commands that act on a specific entity state. */
export const ExpectedVersion = z.object({ expectedVersion: z.number().int().positive().optional() });

export const Page = <T extends z.ZodTypeAny>(item: T) =>
  z.object({ items: z.array(item), nextCursor: z.string().nullable() });
