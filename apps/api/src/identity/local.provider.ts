import { createHash, randomBytes } from 'node:crypto';
import {
  createAuthSession,
  findUserByAuthToken,
  getUserByEmail,
  hashPassword,
  revokeAuthSession,
  verifyPassword,
  type Pool,
  type UserRecord,
} from '@hqms/db';
import type { IdentityProvider, IssuedSession } from './identity.provider.js';

export const sha256Hex = (s: string): string => createHash('sha256').update(s).digest('hex');

/** email + password (argon2id) with server-side sessions; the cookie carries a random 32-byte token. */
export class LocalIdentityProvider implements IdentityProvider {
  readonly name = 'local' as const;
  private dummyHash: Promise<string> | undefined;

  constructor(
    private readonly pool: Pool,
    private readonly sessionTtlHours: number,
  ) {}

  async authenticate(email: string, password: string): Promise<UserRecord | null> {
    const user = await getUserByEmail(this.pool, email);
    // Always run one argon2 verification so unknown accounts cost the same as wrong passwords.
    this.dummyHash ??= hashPassword(randomBytes(16).toString('hex'));
    const ok = await verifyPassword(user?.passwordHash ?? (await this.dummyHash), password);
    if (!user || !ok || !user.active || user.identityProvider !== 'local') return null;
    return user;
  }

  async issueSession(user: UserRecord, now: Date): Promise<IssuedSession> {
    const token = randomBytes(32).toString('base64url');
    const expiresAt = new Date(now.getTime() + this.sessionTtlHours * 3_600_000);
    await createAuthSession(this.pool, { tokenHash: sha256Hex(token), userId: user.id, expiresAt });
    return { token, expiresAt };
  }

  resolveSession(token: string): Promise<UserRecord | null> {
    return findUserByAuthToken(this.pool, sha256Hex(token));
  }

  revokeSession(token: string): Promise<void> {
    return revokeAuthSession(this.pool, sha256Hex(token));
  }
}
