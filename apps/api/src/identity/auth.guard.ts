import { Inject, Injectable, Logger, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { getMe, type Pool } from '@hqms/db';
import { DB_POOL, IDENTITY_PROVIDER } from '../common/tokens.js';
import { forbidden, unauthenticated } from '../common/errors.js';
import type { AuthUser, HqmsRequest } from '../common/request-context.js';
import { IS_PUBLIC, ROLES_KEY } from './auth.decorators.js';
import type { IdentityProvider } from './identity.provider.js';
import { sha256Hex } from './local.provider.js';
import type { Role } from '@hqms/contracts';

export const SESSION_COOKIE = 'hqms_session';

/** Authenticates the session cookie for every route that is not @Public. */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(DB_POOL) private readonly pool: Pool,
    @Inject(IDENTITY_PROVIDER) private readonly identity: IdentityProvider,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (this.reflector.getAllAndOverride<boolean | undefined>(IS_PUBLIC, [context.getHandler(), context.getClass()])) {
      return true;
    }
    const req = context.switchToHttp().getRequest<HqmsRequest>();
    const token = (req.cookies as Record<string, string> | undefined)?.[SESSION_COOKIE];
    if (!token || typeof token !== 'string') throw unauthenticated();
    const record = await this.identity.resolveSession(token);
    if (!record) throw unauthenticated();
    const me = await getMe(this.pool, record.id);
    if (!me) throw unauthenticated();
    const user: AuthUser = { ...me, tokenHash: sha256Hex(token) };
    req.user = user;
    return true;
  }
}

/** Role gate. A route that declares no roles is denied (a forgotten decorator must never open a route). */
@Injectable()
export class RolesGuard implements CanActivate {
  private readonly log = new Logger('RolesGuard');

  constructor(@Inject(Reflector) private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const targets = [context.getHandler(), context.getClass()];
    if (this.reflector.getAllAndOverride<boolean | undefined>(IS_PUBLIC, targets)) return true;
    const roles = this.reflector.getAllAndOverride<Role[] | undefined>(ROLES_KEY, targets);
    const req = context.switchToHttp().getRequest<HqmsRequest>();
    if (!roles || roles.length === 0) {
      this.log.error(`Route ${req.method} ${req.path} declares no roles: denied (default deny)`);
      throw forbidden();
    }
    if (!req.user || !roles.includes(req.user.role)) throw forbidden();
    return true;
  }
}
