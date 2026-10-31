import { loadEnvironment } from '@hmn/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { checkDatabase, createDatabaseClient } from './database.js';
import type { Prisma } from './generated/prisma/client.js';
import { withTenantTx } from './tenant.js';

/**
 * Security integration tests S6 and S7 (ADR-0003 Phase 3 security test plan).
 *
 * S6 proves the runtime role `hmn_app` is least-privileged: it cannot create
 * tables, cannot read the migration bookkeeping table, and cannot write global
 * tables (SELECT-only grants there, ADR-0003 D5).
 *
 * S7 proves the platform role `hmn_platform` cannot silently bypass RLS: with
 * no tenant context it sees zero tenant rows and cannot write them, while it
 * retains access to global tables and can enter tenant data only through an
 * explicitly contextualised `withTenantTx` (the audited platform path, D5).
 *
 * Everything runs against the real PostgreSQL with the real roles; nothing is
 * mocked. Fixtures use tenant IDs distinct from `tenant-rls.integration.test.ts`
 * so both files can run in parallel without touching each other's rows, and
 * cleanup deletes exactly the rows created here.
 */

const environment = loadEnvironment();

const app = createDatabaseClient({ connectionString: environment.DATABASE_APP_URL });
const platform = environment.DATABASE_PLATFORM_URL
  ? createDatabaseClient({ connectionString: environment.DATABASE_PLATFORM_URL })
  : undefined;
const admin = createDatabaseClient({ connectionString: environment.DATABASE_URL });

// Deliberately distinct from the other integration file's fixtures (A/B).
const TENANT_C = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const TENANT_D = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

// Availability probe at module load — the tests skip (loudly) when PostgreSQL
// is unreachable, they never silently pass on a missing database.
const probe = await checkDatabase(app, 3_000);
const dbAvailable = probe.status === 'ok';

async function asOwner<T>(fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
  return admin.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SET LOCAL ROLE hmn_migrator`);
    return fn(tx);
  });
}

beforeAll(async () => {
  if (!dbAvailable) return;

  // Guard: the tests are meaningless if they accidentally run as another role.
  const me = await app.$queryRaw<Array<{ who: string }>>`SELECT current_user AS who`;
  expect(me[0]?.who).toBe('hmn_app');

  if (platform) {
    const platformUser = await platform.$queryRaw<
      Array<{ who: string }>
    >`SELECT current_user AS who`;
    expect(platformUser[0]?.who).toBe('hmn_platform');
  }

  await asOwner(async (tx) => {
    await tx.$executeRawUnsafe(
      `INSERT INTO tenants (id, name, slug)
       VALUES ($1::uuid, 'Tenant C', 'tenant-c-role-test'), ($2::uuid, 'Tenant D', 'tenant-d-role-test')
       ON CONFLICT (id) DO NOTHING`,
      TENANT_C,
      TENANT_D,
    );
    await tx.$executeRawUnsafe(
      `INSERT INTO domains (id, "tenantId", hostname) VALUES
         (gen_random_uuid(), $1::uuid, 'c.role-test.invalid'),
         (gen_random_uuid(), $2::uuid, 'd.role-test.invalid')
       ON CONFLICT DO NOTHING`,
      TENANT_C,
      TENANT_D,
    );
  });
});

afterAll(async () => {
  if (dbAvailable) {
    await asOwner(async (tx) => {
      // Fixture teardown. The first two statements are defensive only: they
      // matter if an S6 assertion failed because a privilege was NOT denied.
      await tx.$executeRawUnsafe(`DROP TABLE IF EXISTS "s6_capability_probe"`);
      await tx.$executeRawUnsafe(`DELETE FROM "subscription_plans" WHERE name = 's6-probe'`);
      await tx.$executeRawUnsafe(
        `DELETE FROM tenants WHERE id IN ($1::uuid, $2::uuid)`,
        TENANT_C,
        TENANT_D,
      );
    });
  }
  await app.$disconnect();
  if (platform) await platform.$disconnect();
  await admin.$disconnect();
});

describe.skipIf(!dbAvailable)('S6 — hmn_app is least-privileged', () => {
  it('cannot create tables (no CREATE privilege on schema public)', async () => {
    await expect(
      app.$executeRawUnsafe(`CREATE TABLE "s6_capability_probe" (id integer)`),
    ).rejects.toThrow(/permission denied/i);
  });

  it('cannot read the migration bookkeeping table', async () => {
    await expect(
      app.$queryRawUnsafe(`SELECT count(*) AS count FROM "_prisma_migrations"`),
    ).rejects.toThrow(/permission denied/i);
  });

  it('cannot write global tables — SELECT-only grants (ADR-0003 D5)', async () => {
    await expect(
      app.$executeRawUnsafe(
        `INSERT INTO "subscription_plans" (id, tier, name, "maxUsers", "monthlyMessageUnits")
         VALUES (gen_random_uuid(), 'FREE', 's6-probe', 1, 1)`,
      ),
    ).rejects.toThrow(/permission denied/i);
  });
});

describe.skipIf(!dbAvailable || !platform)('S7 — hmn_platform cannot silently bypass RLS', () => {
  it('reads zero tenant rows without tenant context', async () => {
    const rows = await platform!.domain.findMany();
    expect(rows).toHaveLength(0);
  });

  it('a raw count without context returns zero (RLS filters, it is not empty tables)', async () => {
    const counts = await platform!.$queryRaw<
      Array<{ count: bigint }>
    >`SELECT count(*) AS count FROM "domains"`;
    expect(counts[0]?.count).toBe(0n);
  });

  it('a write without tenant context is rejected (fail closed, WITH CHECK)', async () => {
    await expect(
      platform!.domain.create({
        data: { tenantId: TENANT_C, hostname: 'platform-no-context.role-test.invalid' },
      }),
    ).rejects.toThrow();
  });

  it('still reads global tables — the zero tenant rows come from RLS, not broken access', async () => {
    const tenants = await platform!.tenant.findMany();
    expect(tenants.length).toBeGreaterThanOrEqual(2);
  });

  it('enters tenant data only through explicitly contextualised transactions (audited path)', async () => {
    const rows = await withTenantTx(platform!, TENANT_C, async (tx) => tx.domain.findMany());

    expect(rows).toHaveLength(1);
    expect(rows[0]?.tenantId).toBe(TENANT_C);
    expect(rows[0]?.hostname).toBe('c.role-test.invalid');
  });
});
