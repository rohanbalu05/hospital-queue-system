import type { UserRecord } from '@hqms/db';
import { notImplemented } from '../common/errors.js';
import type { IdentityProvider, IssuedSession } from './identity.provider.js';

/**
 * Stub for the hosted reference deployment (Google Identity Platform). Selected with
 * IDENTITY_PROVIDER=identity-platform; every operation is "not implemented" until that adapter is built.
 */
export class IdentityPlatformProvider implements IdentityProvider {
  readonly name = 'identity-platform' as const;

  authenticate(_email: string, _password: string): Promise<UserRecord | null> {
    return Promise.reject(notImplemented('identity-platform provider is not implemented'));
  }
  issueSession(_user: UserRecord, _now: Date): Promise<IssuedSession> {
    return Promise.reject(notImplemented('identity-platform provider is not implemented'));
  }
  resolveSession(_token: string): Promise<UserRecord | null> {
    return Promise.reject(notImplemented('identity-platform provider is not implemented'));
  }
  revokeSession(_token: string): Promise<void> {
    return Promise.reject(notImplemented('identity-platform provider is not implemented'));
  }
}
