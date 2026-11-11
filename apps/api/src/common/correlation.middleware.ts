import { randomUUID } from 'node:crypto';
import type { NextFunction, Response } from 'express';
import type { HqmsRequest } from './request-context.js';

export const CORRELATION_HEADER = 'x-correlation-id';
const SAFE = /^[A-Za-z0-9._-]{8,64}$/;

/** Every request gets a correlation id (client-supplied if well-formed), echoed in the response header. */
export function correlationMiddleware(req: HqmsRequest, res: Response, next: NextFunction): void {
  const incoming = req.header(CORRELATION_HEADER);
  req.correlationId = incoming && SAFE.test(incoming) ? incoming : randomUUID();
  res.setHeader(CORRELATION_HEADER, req.correlationId);
  next();
}
