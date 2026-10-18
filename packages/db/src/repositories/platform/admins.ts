import type { PrismaClient } from '../../generated/prisma/client.js';

/**
 * Platform-level lookup of `platform_admins` (ADR-0004 D-A).
 *
 * Must be called with the `hmn_platform` client: `hmn_app` holds no grant on
 * this table, so a tenant runtime connection cannot even see whether a user is
 * a platform owner.
 *
 * This module is not re-exported from `@hmn/db`.
 */
export async function findPlatformAdminByUserId(client: PrismaClient, userId: string) {
  return client.platformAdmin.findUnique({
    where: { userId },
    select: { id: true, userId: true, mfaEnrolled: true },
  });
}
