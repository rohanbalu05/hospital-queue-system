import { Catch, HttpException, Logger, type ArgumentsHost, type ExceptionFilter } from '@nestjs/common';
import type { Response } from 'express';
import { ZodError } from 'zod';
import { InvalidTransitionError } from '@hqms/domain';
import { ConflictError, LockOrderError, NotFoundError, sqlState } from '@hqms/db';
import type { ApiError, ErrorCode } from '@hqms/contracts';
import { ApiException } from './errors.js';
import type { HqmsRequest } from './request-context.js';

interface Mapped {
  status: number;
  code: ErrorCode;
  message: string;
  details?: unknown;
}

const STATUS_CODE: Record<number, ErrorCode> = {
  400: 'VALIDATION_FAILED',
  401: 'UNAUTHENTICATED',
  403: 'FORBIDDEN',
  404: 'NOT_FOUND',
  409: 'CONFLICT',
  413: 'UPLOAD_TOO_LARGE',
  415: 'UNSUPPORTED_MEDIA_TYPE',
  429: 'RATE_LIMITED',
};

/**
 * Maps every thrown error to the contract `ApiError` body. Nothing user-supplied (request bodies,
 * SQL parameter values) is ever echoed or logged: zod issues carry paths and messages only.
 */
@Catch()
export class ApiExceptionFilter implements ExceptionFilter {
  private readonly log = new Logger('ApiExceptionFilter');

  catch(err: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const res = http.getResponse<Response>();
    const req = http.getRequest<HqmsRequest>();
    const mapped = this.map(err);

    if (mapped.status >= 500) {
      this.log.error(
        `${req.correlationId ?? '-'} ${req.method} ${req.path} -> ${mapped.status}: ${describe(err)}`,
        // Frames only: the first stack line repeats the message, which may contain row values.
        err instanceof Error ? err.stack?.split('\n').slice(1).join('\n') : undefined,
      );
    }
    const body: ApiError = {
      error: {
        code: mapped.code,
        message: mapped.message,
        ...(mapped.details === undefined ? {} : { details: mapped.details }),
        ...(req.correlationId ? { correlationId: req.correlationId } : {}),
      },
    };
    if (res.headersSent) return;
    res.status(mapped.status).json(body);
  }

  private map(err: unknown): Mapped {
    if (err instanceof ApiException) {
      return { status: err.getStatus(), code: err.code, message: err.message, details: err.details };
    }
    if (err instanceof ZodError) {
      return {
        status: 400,
        code: 'VALIDATION_FAILED',
        message: 'Request validation failed',
        details: { issues: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message, code: i.code })) },
      };
    }
    if (err instanceof ConflictError) {
      return { status: 409, code: err.code, message: err.message, details: err.details };
    }
    if (err instanceof NotFoundError) {
      return { status: 404, code: 'NOT_FOUND', message: `${err.entity} not found` };
    }
    if (err instanceof InvalidTransitionError) {
      return {
        status: 409,
        code: 'INVALID_TRANSITION',
        message: err.message,
        details: { machine: err.machine, from: err.from, to: err.to },
      };
    }
    if (err instanceof LockOrderError) {
      return { status: 500, code: 'INTERNAL', message: 'Internal error' };
    }
    if (sqlState(err) === '23505') {
      // A unique constraint caught a race the guards did not (e.g. a duplicate visit): a controlled conflict.
      return { status: 409, code: 'CONFLICT', message: 'The request conflicts with the current state' };
    }
    if (err instanceof HttpException) {
      const status = err.getStatus();
      const code = STATUS_CODE[status] ?? (status >= 500 ? 'INTERNAL' : 'CONFLICT');
      return { status, code, message: status >= 500 ? 'Internal error' : messageOf(err) };
    }
    const status = httpStatusOf(err);
    if (status !== undefined && status >= 400 && status < 500) {
      // body-parser / express errors (malformed JSON, payload too large).
      return {
        status,
        code: STATUS_CODE[status] ?? 'VALIDATION_FAILED',
        message: 'The request could not be processed',
      };
    }
    return { status: 500, code: 'INTERNAL', message: 'Internal error' };
  }
}

function messageOf(err: HttpException): string {
  const r = err.getResponse();
  if (typeof r === 'string') return r;
  const m = (r as { message?: unknown }).message;
  return typeof m === 'string' ? m : err.message;
}

function httpStatusOf(err: unknown): number | undefined {
  if (typeof err === 'object' && err !== null) {
    const s =
      (err as { status?: unknown; statusCode?: unknown }).status ?? (err as { statusCode?: unknown }).statusCode;
    if (typeof s === 'number') return s;
  }
  return undefined;
}

/** Error class, SQLSTATE and constraint name only: messages can contain row values. */
function describe(err: unknown): string {
  if (!(err instanceof Error)) return 'non-error thrown';
  const state = sqlState(err);
  const constraint = (err as { constraint?: unknown }).constraint;
  return [err.name, state ? `sqlstate=${state}` : '', typeof constraint === 'string' ? `constraint=${constraint}` : '']
    .filter(Boolean)
    .join(' ');
}
