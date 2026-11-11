import { SetMetadata, createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { Role } from '@hqms/contracts';
import { ctxOf, type HqmsRequest, type RequestCtx } from '../common/request-context.js';

export const IS_PUBLIC = 'hqms:public';
export const ROLES_KEY = 'hqms:roles';

/** The route needs no session (login, health). Everything else requires one: default deny. */
export const Public = () => SetMetadata(IS_PUBLIC, true);

/** Roles allowed on the route. A route with neither @Public nor @Roles is refused (default deny). */
export const Roles = (...roles: Role[]) => SetMetadata(ROLES_KEY, roles);

export const ALL_ROLES: Role[] = ['patient', 'reception', 'doctor', 'followup', 'admin'];
export const STAFF_ROLES: Role[] = ['reception', 'doctor', 'followup', 'admin'];

/** `@Ctx()` injects `{ user, correlationId }` for the authenticated request. */
export const Ctx = createParamDecorator((_data: unknown, host: ExecutionContext): RequestCtx =>
  ctxOf(host.switchToHttp().getRequest<HqmsRequest>()),
);
