import { HttpException } from '@nestjs/common';
import type { ErrorCode } from '@hqms/contracts';

/** An HTTP error that carries the contract ErrorCode; the exception filter renders it as ApiError. */
export class ApiException extends HttpException {
  constructor(
    status: number,
    readonly code: ErrorCode,
    message: string,
    readonly details?: unknown,
  ) {
    super({ code, message, details }, status);
  }
}

export const unauthenticated = (message = 'Authentication required') =>
  new ApiException(401, 'UNAUTHENTICATED', message);
export const forbidden = (message = 'You are not allowed to do this') => new ApiException(403, 'FORBIDDEN', message);
export const notFound = (what = 'Resource') => new ApiException(404, 'NOT_FOUND', `${what} not found`);
export const validationFailed = (message: string, details?: unknown) =>
  new ApiException(400, 'VALIDATION_FAILED', message, details);
export const conflict = (code: ErrorCode, message: string, details?: unknown) =>
  new ApiException(409, code, message, details);
export const rateLimited = (retryAfterSec: number) =>
  new ApiException(429, 'RATE_LIMITED', 'Too many attempts; try again later', { retryAfterSec });
export const notImplemented = (message: string) => new ApiException(501, 'INTERNAL', message);
