import { hash, verify } from '@node-rs/argon2';

/** argon2id hash for the `local` identity provider (OWASP-style parameters, DECISIONS D-014). */
export function hashPassword(plain: string): Promise<string> {
  return hash(plain, { memoryCost: 19456, timeCost: 2, parallelism: 1 });
}

/** Constant-time verify; returns false for a malformed hash or a missing hash instead of throwing. */
export async function verifyPassword(passwordHash: string | null | undefined, plain: string): Promise<boolean> {
  if (!passwordHash) return false;
  try {
    return await verify(passwordHash, plain);
  } catch {
    return false;
  }
}
