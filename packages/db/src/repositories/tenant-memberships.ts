import type { TenantTx } from '../tenant.js';

/**
 * Tenant-scoped repository: `tenant_memberships`.
 *
 * Boundary rules (ADR-0003 D4):
 * - Every method takes a `TenantTx` — obtainable only from `withTenantTx`. A raw
 *   `PrismaClient` is a compile error (see `src/tenant-boundary.check.ts`, test U1).
 * - This module must not import `PrismaClient`, the generated client or
 *   `../database.js` — enforced by the ESLint `no-restricted-imports` boundary.
 * - Rows are filtered by RLS using the transaction-local context; the explicit
 *   `tenantId` parameters below keep the API honest and are asserted by
 *   `WITH CHECK` (wrong-tenant writes are rejected by the database, S4).
 */

export interface CreateMembershipInput {
  readonly tenantId: string;
  readonly userId: string;
  readonly role: 'PLATFORM_OWNER' | 'TENANT_ADMIN' | 'DOCTOR' | 'RECEPTION';
}

export async function createMembership(tx: TenantTx, input: CreateMembershipInput) {
  return tx.tenantMembership.create({
    data: {
      tenantId: input.tenantId,
      userId: input.userId,
      role: input.role,
    },
  });
}

export async function listMemberships(tx: TenantTx, tenantId: string) {
  return tx.tenantMembership.findMany({
    where: { tenantId },
    orderBy: { createdAt: 'asc' },
  });
}

export async function findMembership(tx: TenantTx, tenantId: string, userId: string) {
  return tx.tenantMembership.findUnique({
    where: { tenantId_userId: { tenantId, userId } },
  });
}
