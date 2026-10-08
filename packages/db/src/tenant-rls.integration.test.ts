import { loadEnvironment } from '@hmn/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { checkDatabase, createDatabaseClient } from './database.js';
import type { Prisma } from './generated/prisma/client.js';
import { withTenantTx } from './tenant.js';

/**
 * Security integration tests S2–S5 (ADR-0003 Phase 3 security test plan).
 *
 * These run against the real PostgreSQL from `docker compose` and connect as
 * the RUNTIME role `hmn_app` via DATABASE_APP_URL — the same credentials the
 * API and worker use — so the assertions exercise the actual RLS policies, not
 * a simulation. If PostgreSQL is unreachable the tests skip loudly (a probe at
 * module load decides, and the skip reason says so); they never silently pass.
 *
 * Fixtures: two tenants with one domain row each, created with migration-role
 * privileges via SET LOCAL role switching inside a transaction.
 */

const environment = loadEnvironment();

const app = createDatabaseClient({ connectionString: environment.DATABASE_APP_URL });

// Privileged client for fixture setup/teardown only: connects as the migrator
// and impersonates the table owner via SET LOCAL ROLE. Never used by tests
// themselves and never by application code.
const admin = createDatabaseClient({ connectionString: environment.DATABASE_URL });

// Availability probe at module load — decides skip vs run for every test below.
const probe = await checkDatabase(app, 3_000);
const dbAvailable = probe.status === 'ok';

const TENANT_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const TENANT_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

async function asOwner<T>(fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
  return admin.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SET LOCAL ROLE hmn_migrator`);
    return fn(tx);
  });
}

beforeAll(async () => {
  if (!dbAvailable) return;

  // Guard: the tests are meaningless if they accidentally run as the migrator.
  const me = await app.$queryRaw<Array<{ who: string }>>`SELECT current_user AS who`;
  expect(me[0]?.who).toBe('hmn_app');

  await asOwner(async (tx) => {
    await tx.$executeRawUnsafe(
      `INSERT INTO tenants (id, name, slug) VALUES ($1::uuid, 'Tenant A', 'tenant-a-rls-test'), ($2::uuid, 'Tenant B', 'tenant-b-rls-test')
       ON CONFLICT (id) DO NOTHING`,
      TENANT_A,
      TENANT_B,
    );
    await tx.$executeRawUnsafe(
      `INSERT INTO domains (id, "tenantId", hostname) VALUES
         (gen_random_uuid(), $1::uuid, 'a.rls-test.invalid'),
         (gen_random_uuid(), $2::uuid, 'b.rls-test.invalid')
       ON CONFLICT DO NOTHING`,
      TENANT_A,
      TENANT_B,
    );
  });
});

afterAll(async () => {
  if (dbAvailable) {
    await asOwner(async (tx) => {
      await tx.$executeRawUnsafe(
        `DELETE FROM tenants WHERE id IN ($1::uuid, $2::uuid)`,
        TENANT_A,
        TENANT_B,
      );
    });
  }
  await app.$disconnect();
  await admin.$disconnect();
});

describe.skipIf(!dbAvailable)(
  'S2 — fail closed: no tenant context means no rows, no writes',
  () => {
    it('reads zero tenant rows without context', async () => {
      const domains = await app.$queryRaw<Array<{ count: bigint }>>`
      SELECT count(*) AS count FROM "domains"`;
      expect(domains[0]?.count).toBe(0n);
    });

    it('rejects an insert without context', async () => {
      await expect(
        app.$executeRaw`
        INSERT INTO "domains" (id, "tenantId", hostname)
        VALUES (gen_random_uuid(), ${TENANT_A}::uuid, 'no-context.rls-test.invalid')`,
      ).rejects.toThrow();
    });

    it('rejects a model-level write without context (WITH CHECK, NULL comparison)', async () => {
      await expect(
        app.domain.create({
          data: { tenantId: TENANT_A, hostname: 'no-context-model.rls-test.invalid' },
        }),
      ).rejects.toThrow();
    });
  },
);

describe.skipIf(!dbAvailable)('S3 — wrong-tenant reads return zero rows', () => {
  it("tenant A's context sees only tenant A's domains", async () => {
    const rows = await withTenantTx(app, TENANT_A, async (tx) => tx.domain.findMany());

    expect(rows).toHaveLength(1);
    expect(rows[0]?.tenantId).toBe(TENANT_A);
    expect(rows[0]?.hostname).toBe('a.rls-test.invalid');
  });

  it("tenant A's context cannot find tenant B's row by its hostname", async () => {
    const row = await withTenantTx(app, TENANT_A, async (tx) =>
      tx.domain.findUnique({ where: { hostname: 'b.rls-test.invalid' } }),
    );

    expect(row).toBeNull();
  });

  it('a raw count under tenant A context excludes tenant B rows', async () => {
    const counts = await withTenantTx(
      app,
      TENANT_A,
      async (tx) => tx.$queryRaw<Array<{ count: bigint }>>`SELECT count(*) AS count FROM "domains"`,
    );

    expect(counts[0]?.count).toBe(1n);
  });
});

describe.skipIf(!dbAvailable)('S4 — wrong-tenant writes are rejected by WITH CHECK', () => {
  it('rejects an insert whose tenantId differs from the session context', async () => {
    await expect(
      withTenantTx(app, TENANT_A, async (tx) =>
        tx.domain.create({
          data: { tenantId: TENANT_B, hostname: 'cross-write.rls-test.invalid' },
        }),
      ),
    ).rejects.toThrow();
  });

  it('rejects an update that would move a row to another tenant', async () => {
    const domainId = await withTenantTx(app, TENANT_A, async (tx) => {
      const row = await tx.domain.findFirst({ where: { hostname: 'a.rls-test.invalid' } });
      return row?.id;
    });

    if (domainId === undefined) {
      throw new Error(
        'fixture domain a.rls-test.invalid missing — cannot exercise the S4 update case',
      );
    }

    await expect(
      withTenantTx(app, TENANT_A, async (tx) =>
        tx.domain.update({
          where: { id: domainId },
          data: { tenantId: TENANT_B },
        }),
      ),
    ).rejects.toThrow();

    // The row must still belong to tenant A.
    const stillA = await withTenantTx(app, TENANT_A, async (tx) =>
      tx.domain.findUnique({ where: { id: domainId } }),
    );
    expect(stillA?.tenantId).toBe(TENANT_A);
  });
});

describe.skipIf(!dbAvailable)('S5 — pool context leakage', () => {
  it('a connection returned to the pool carries no residual tenant context', async () => {
    // Transaction 1 sets tenant A context and commits.
    const first = await withTenantTx(
      app,
      TENANT_A,
      async (tx) =>
        tx.$queryRaw<Array<{ current_setting: string | null }>>`
        SELECT current_setting('app.current_tenant_id', true) AS current_setting`,
    );
    expect(first[0]?.current_setting).toBe(TENANT_A);

    // Transaction 2 — same pool, NO set_config — must see nothing. PostgreSQL
    // keeps an EMPTY-STRING placeholder for a custom GUC after a
    // transaction-local setting commits (it does not restore NULL), so "clean"
    // means: no residual tenant identity (NULL or '') — and, decisively, zero
    // visible rows: the policies (ADR-0003 D6, amended) treat both as
    // no-context instead of erroring on the empty-string ::uuid cast.
    const second = await app.$queryRaw<Array<{ current_setting: string | null }>>`
      SELECT current_setting('app.current_tenant_id', true) AS current_setting`;
    expect([null, '']).toContain(second[0]?.current_setting ?? null);

    const domains = await app.$queryRaw<Array<{ count: bigint }>>`
      SELECT count(*) AS count FROM "domains"`;
    expect(domains[0]?.count).toBe(0n);
  });
});
