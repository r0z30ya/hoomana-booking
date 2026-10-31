import type { PrismaClient } from '../../generated/prisma/client.js';

/**
 * Identity repository: `credentials` (global table, no RLS — ADR-0004 D-C).
 *
 * This is the identity repository family: global auth tables operated by the
 * runtime role `hmn_app` through the plain client. Unlike tenant repositories,
 * these take a `PrismaClient` (not a `TenantTx`) because credential lookups happen
 * before any tenant context exists.
 *
 * Security invariants (ADR-0004):
 * - `passwordHash` is never returned to callers outside `packages/db` — every
 *   function here either returns a boolean or the full row for internal use only.
 * - The hash format is self-describing (`scrypt$N$r$p$salt$hash`) and is produced
 *   by `packages/shared/src/password.ts`.
 */

export interface CreateCredentialInput {
  readonly userId: string;
  /** Self-describing scrypt hash from `hashPassword()`. */
  readonly passwordHash: string;
}

export async function createCredential(client: PrismaClient, input: CreateCredentialInput) {
  return client.credential.create({
    data: {
      userId: input.userId,
      passwordHash: input.passwordHash,
    },
  });
}

/**
 * Find a credential by the owning user's id.
 *
 * Returns `undefined` when no credential exists — the caller treats this the same
 * as a wrong password (ADR-0004 D-B: non-enumerable responses).
 */
export async function findCredentialByUserId(client: PrismaClient, userId: string) {
  return client.credential.findUnique({ where: { userId } });
}

/** Store a new password hash and bump the change timestamp. */
export async function updatePasswordHash(
  client: PrismaClient,
  userId: string,
  passwordHash: string,
) {
  return client.credential.update({
    where: { userId },
    data: { passwordHash, passwordUpdatedAt: new Date() },
  });
}

/** Remove a credential entirely (e.g. account closure). */
export async function deleteCredential(client: PrismaClient, userId: string) {
  return client.credential.delete({ where: { userId } });
}
