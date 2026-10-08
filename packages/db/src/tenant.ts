import { ValidationError } from '@hmn/shared';
import type { Prisma, PrismaClient } from './generated/prisma/client.js';

/**
 * Phantom brand making the boundary compile-time real: `Prisma.TransactionClient`
 * alone is a structural type that a raw `PrismaClient` also satisfies, so a
 * bare alias would NOT reject a raw client. The required brand exists only in
 * the type system (never at runtime) and is produced exclusively by
 * `withTenantTx`, which is exactly what makes passing a raw `PrismaClient` to
 * a repository a compile error, enforced by `src/tenant-boundary.check.ts`
 * (test U1).
 */
declare const tenantTxBrand: unique symbol;

/**
 * The transaction handle every tenant-scoped repository method must accept.
 *
 * This is Prisma's interactive-transaction client branded as having come from
 * `withTenantTx`. It is the ONLY argument type tenant repositories accept, and
 * the only way to obtain one is `withTenantTx`. That makes the ADR-0003 D4 rule
 * ("tenant-scoped operations must run inside the transaction that set the
 * context") a compile-time guarantee instead of a convention.
 */
export type TenantTx = Prisma.TransactionClient & {
  readonly [tenantTxBrand]: true;
};

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Run `fn` inside a transaction whose RLS context names exactly one tenant.
 *
 * This is the single sanctioned way to touch tenant-owned data (ADR-0003 D3/D4):
 *
 * 1. `tenantId` is validated BEFORE any database work — missing or non-UUID
 *    values throw immediately (fail closed at the application layer too; U2).
 * 2. The transaction's FIRST statement is
 *    `set_config('app.current_tenant_id', $1, true)` — parameterized (no
 *    injection surface) and transaction-local (U3).
 * 3. `is_local => true` discards the setting at COMMIT/ROLLBACK, so a pooled
 *    connection is returned clean: the next borrower — a different request,
 *    possibly a different tenant — cannot inherit stale context (security test
 *    S5). PostgreSQL keeps an empty-string placeholder for the GUC afterwards;
 *    the fail-closed policies (ADR-0003 D6, amended) treat '' like unset via
 *    NULLIF, so a context-less query on a reused connection sees zero rows.
 *
 * Plain `SET` / session-scoped `set_config` is forbidden in application code.
 */
export async function withTenantTx<T>(
  client: PrismaClient,
  tenantId: string,
  fn: (tx: TenantTx) => Promise<T>,
): Promise<T> {
  if (typeof tenantId !== 'string' || !UUID_PATTERN.test(tenantId)) {
    throw new ValidationError('A valid tenant identifier is required', {
      code: 'INVALID_TENANT_CONTEXT',
    });
  }

  return client.$transaction(async (tx) => {
    // First statement of the transaction, is_local => true (third argument).
    await tx.$executeRaw`SELECT set_config('app.current_tenant_id', ${tenantId}, true)`;

    // The single sanctioned promotion of a raw transaction client to TenantTx:
    // the brand asserts "this handle was created inside the transaction whose
    // RLS context was just set", which holds at exactly this point.
    return fn(tx as TenantTx);
  });
}
