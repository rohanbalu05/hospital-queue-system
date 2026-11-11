import { Body, Controller, Get, HttpCode, Inject, Post, Req, Res } from '@nestjs/common';
import type { Response } from 'express';
import { LoginRequest, type Me } from '@hqms/contracts';
import { getMe, withTransaction, writeAudit, type Pool } from '@hqms/db';
import { APP_CONFIG, CLOCK, DB_POOL, IDENTITY_PROVIDER } from '../common/tokens.js';
import type { AppConfig } from '../common/config.js';
import type { Clock } from '../common/clock.js';
import { rateLimited, unauthenticated } from '../common/errors.js';
import type { HqmsRequest, RequestCtx } from '../common/request-context.js';
import { ZodPipe } from '../common/zod.pipe.js';
import { ALL_ROLES, Ctx, Public, Roles } from './auth.decorators.js';
import { SESSION_COOKIE } from './auth.guard.js';
import type { IdentityProvider } from './identity.provider.js';
import { LoginRateLimiter } from './rate-limiter.js';

@Controller()
export class AuthController {
  private readonly limiter: LoginRateLimiter;

  constructor(
    @Inject(IDENTITY_PROVIDER) private readonly identity: IdentityProvider,
    @Inject(DB_POOL) private readonly pool: Pool,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {
    this.limiter = new LoginRateLimiter(config.loginRateLimitMax, config.loginRateLimitWindowSec * 1000);
  }

  @Public()
  @Post('auth/login')
  @HttpCode(200)
  async login(
    @Body(new ZodPipe(LoginRequest)) body: LoginRequest,
    @Req() req: HqmsRequest,
    @Res({ passthrough: true }) res: Response,
  ): Promise<Me> {
    const nowMs = Date.now();
    const key = `${req.ip ?? 'unknown'}|${body.email.toLowerCase()}`;
    const wait = this.limiter.retryAfterSec(key, nowMs);
    if (wait > 0) {
      res.setHeader('Retry-After', String(wait));
      throw rateLimited(wait);
    }
    const user = await this.identity.authenticate(body.email, body.password);
    if (!user) {
      this.limiter.recordFailure(key, nowMs);
      throw unauthenticated('Invalid email or password');
    }
    this.limiter.recordSuccess(key);
    const session = await this.identity.issueSession(user, this.clock.now());
    res.cookie(SESSION_COOKIE, session.token, {
      httpOnly: true,
      sameSite: 'lax',
      path: '/',
      secure: this.config.cookieSecure,
      expires: session.expiresAt,
    });
    await withTransaction(this.pool, (tx) =>
      writeAudit(tx, {
        actorId: user.id,
        actorRole: user.role,
        operation: 'auth.login',
        entityType: 'user',
        entityId: user.id,
        correlationId: req.correlationId,
      }),
    );
    const me = await getMe(this.pool, user.id);
    if (!me) throw unauthenticated();
    return me;
  }

  /** Idempotent and public: clears the cookie and revokes the session if there is one. */
  @Public()
  @Post('auth/logout')
  @HttpCode(204)
  async logout(@Req() req: HqmsRequest, @Res({ passthrough: true }) res: Response): Promise<void> {
    const token = (req.cookies as Record<string, string> | undefined)?.[SESSION_COOKIE];
    if (token && typeof token === 'string') await this.identity.revokeSession(token);
    res.clearCookie(SESSION_COOKIE, { httpOnly: true, sameSite: 'lax', path: '/', secure: this.config.cookieSecure });
  }

  @Roles(...ALL_ROLES)
  @Get('me')
  me(@Ctx() ctx: RequestCtx): Me {
    const { tokenHash: _tokenHash, ...me } = ctx.user;
    return me;
  }
}
