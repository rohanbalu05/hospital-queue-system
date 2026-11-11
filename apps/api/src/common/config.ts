import { z } from 'zod';

const bool = z
  .enum(['true', 'false', '1', '0', ''])
  .optional()
  .transform((v) => v === 'true' || v === '1');

const EnvSchema = z.object({
  DATABASE_URL: z.string().min(1).default('postgres://postgres:postgres@localhost:5432/hqms'),
  DB_POOL_MAX: z.coerce.number().int().positive().default(10),
  PORT: z.coerce.number().int().positive().default(3000),
  NODE_ENV: z.string().default('development'),
  SESSION_TTL_HOURS: z.coerce.number().positive().default(12),
  COOKIE_SECURE: bool,
  CORS_ORIGINS: z.string().default(''),
  TRUST_PROXY: bool,
  IDENTITY_PROVIDER: z.enum(['local', 'identity-platform']).default('local'),
  HOSPITAL_TZ: z.string().default('Asia/Kolkata'),
  RUN_MIGRATIONS_ON_START: bool,
  SEED_ON_START: bool,
  LOGIN_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(10),
  LOGIN_RATE_LIMIT_WINDOW_SEC: z.coerce.number().int().positive().default(60),
  SSE_POLL_MS: z.coerce.number().int().min(50).default(500),
  SSE_PING_MS: z.coerce.number().int().min(50).default(15_000),
  ASSISTANT_TIMEOUT_MS: z.coerce.number().int().min(50).default(15_000),
});

export interface AppConfig {
  databaseUrl: string;
  dbPoolMax: number;
  port: number;
  production: boolean;
  sessionTtlHours: number;
  cookieSecure: boolean;
  corsOrigins: string[];
  /** Honour X-Forwarded-For (behind the nginx container). Off by default so it cannot be spoofed. */
  trustProxy: boolean;
  identityProvider: 'local' | 'identity-platform';
  hospitalTz: string;
  runMigrationsOnStart: boolean;
  seedOnStart: boolean;
  loginRateLimitMax: number;
  loginRateLimitWindowSec: number;
  /** Shared SSE version poller interval (report 6.2: batch compare, not one poll per client). */
  ssePollMs: number;
  /** SSE heartbeat (`event: ping`) interval. */
  ssePingMs: number;
  /** The LLM call is abandoned after this long and the question is escalated to staff (FR-14). */
  assistantTimeoutMs: number;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const e = EnvSchema.parse(env);
  const production = e.NODE_ENV === 'production';
  return {
    databaseUrl: e.DATABASE_URL,
    dbPoolMax: e.DB_POOL_MAX,
    port: e.PORT,
    production,
    sessionTtlHours: e.SESSION_TTL_HOURS,
    cookieSecure: production || e.COOKIE_SECURE,
    corsOrigins: e.CORS_ORIGINS.split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    trustProxy: e.TRUST_PROXY,
    identityProvider: e.IDENTITY_PROVIDER,
    hospitalTz: e.HOSPITAL_TZ,
    runMigrationsOnStart: e.RUN_MIGRATIONS_ON_START,
    seedOnStart: e.SEED_ON_START,
    loginRateLimitMax: e.LOGIN_RATE_LIMIT_MAX,
    loginRateLimitWindowSec: e.LOGIN_RATE_LIMIT_WINDOW_SEC,
    ssePollMs: e.SSE_POLL_MS,
    ssePingMs: e.SSE_PING_MS,
    assistantTimeoutMs: e.ASSISTANT_TIMEOUT_MS,
  };
}
