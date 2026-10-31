import type { PrismaClient } from '../../generated/prisma/client.js';

/**
 * Platform-level repository: `subscription_plans` (global table, no RLS —
 * ADR-0003 D5).
 *
 * This is the platform repository family: it operates on NON-tenant tables via
 * the plain client and must never touch tenant-owned tables. Entering tenant
 * data from a platform code path happens exclusively through an audited
 * `withTenantTx` call with an explicitly chosen tenant ID.
 *
 * This module is deliberately NOT re-exported from the package index, so
 * application code cannot import it through `@hmn/db` (the package `exports`
 * map allows the main entry only).
 */
export async function listActivePlans(client: PrismaClient) {
  return client.subscriptionPlan.findMany({
    where: { isActive: true },
    orderBy: { tier: 'asc' },
  });
}

export async function findPlanByTier(
  client: PrismaClient,
  tier: 'FREE' | 'STARTER' | 'PRO' | 'BUSINESS' | 'ENTERPRISE',
) {
  return client.subscriptionPlan.findUnique({ where: { tier } });
}
