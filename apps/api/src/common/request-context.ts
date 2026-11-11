import type { Request } from 'express';
import type { Me } from '@hqms/contracts';

/** The authenticated principal attached to a request by the AuthGuard. */
export interface AuthUser extends Me {
  /** SHA-256 of the session cookie token (for logout). */
  tokenHash: string;
}

export interface HqmsRequest extends Request {
  user?: AuthUser;
  correlationId: string;
}

/** What services need from the HTTP layer. */
export interface RequestCtx {
  user: AuthUser;
  correlationId: string;
}

export function ctxOf(req: HqmsRequest): RequestCtx {
  if (!req.user) throw new Error('ctxOf called on an unauthenticated request');
  return { user: req.user, correlationId: req.correlationId };
}
