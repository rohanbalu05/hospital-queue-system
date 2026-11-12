import type { UserRecord } from '@hqms/db';

export interface IssuedSession {
  /** Opaque bearer value for the httpOnly cookie. Only its SHA-256 is stored. */
  token: string;
  expiresAt: Date;
}

/**
 * Identity adapter (FR-01). `local` (email + password, argon2, server-side sessions) is the default;
 * `identity-platform` is a later adapter. Authorization (roles, assignments, ownership) never lives
 * here: the provider only answers "who is this?".
 */
export interface IdentityProvider {
  readonly name: 'local' | 'identity-platform';
  /** Verify credentials. Returns the active user, or null (never says which part was wrong). */
  authenticate(email: string, password: string): Promise<UserRecord | null>;
  /** Start a login session for an authenticated user. */
  issueSession(user: UserRecord, now: Date): Promise<IssuedSession>;
  /** Resolve a cookie token to its active user, or null when unknown, expired or revoked. */
  resolveSession(token: string): Promise<UserRecord | null>;
  revokeSession(token: string): Promise<void>;
}
