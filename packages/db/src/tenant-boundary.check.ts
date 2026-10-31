/**
 * Compile-time boundary check — security test U1 (ADR-0003 D4).
 *
 * This file is executed by `tsc -b` (it is part of the packages/db project), not
 * by Vitest: the assertion IS the type system.
 *
 * Tenant-scoped repository methods accept only a `TenantTx` handle (obtainable
 * only from `withTenantTx`). If someone widens a repository signature to accept
 * a raw `PrismaClient`, the `@ts-expect-error` below becomes unused and the
 * TypeScript build FAILS — the boundary cannot silently regress.
 */
import { createMembership } from './repositories/tenant-memberships.js';
import type { PrismaClient } from './generated/prisma/client.js';
import type { TenantTx } from './tenant.js';

declare const rawClient: PrismaClient;
declare const tx: TenantTx;

// A raw client must NOT be accepted where a TenantTx handle is required.
void createMembership(
  // @ts-expect-error — passing PrismaClient where TenantTx is required must not compile.
  rawClient,
  {
    tenantId: '00000000-0000-4000-8000-000000000000',
    userId: '00000000-0000-4000-8000-000000000001',
    role: 'RECEPTION',
  },
);

// The correct handle compiles (kept as a positive control so this file fails if
// the repository disappears rather than if the boundary weakens).
export const _positiveControl: Promise<unknown> = createMembership(tx, {
  tenantId: '00000000-0000-4000-8000-000000000000',
  userId: '00000000-0000-4000-8000-000000000001',
  role: 'RECEPTION',
});
