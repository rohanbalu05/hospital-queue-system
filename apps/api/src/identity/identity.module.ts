import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import type { Pool } from '@hqms/db';
import { APP_CONFIG, DB_POOL, IDENTITY_PROVIDER } from '../common/tokens.js';
import type { AppConfig } from '../common/config.js';
import { AuthController } from './auth.controller.js';
import { AuthGuard, RolesGuard } from './auth.guard.js';
import { IdentityPlatformProvider } from './identity-platform.provider.js';
import type { IdentityProvider } from './identity.provider.js';
import { LocalIdentityProvider } from './local.provider.js';

@Module({
  controllers: [AuthController],
  providers: [
    {
      provide: IDENTITY_PROVIDER,
      inject: [DB_POOL, APP_CONFIG],
      useFactory: (pool: Pool, config: AppConfig): IdentityProvider =>
        config.identityProvider === 'identity-platform'
          ? new IdentityPlatformProvider()
          : new LocalIdentityProvider(pool, config.sessionTtlHours),
    },
    // Global guards, in this order: authenticate, then check the route's roles. Default deny.
    { provide: APP_GUARD, useClass: AuthGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
  ],
  exports: [IDENTITY_PROVIDER],
})
export class IdentityModule {}
