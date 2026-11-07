import { randomUUID } from 'node:crypto';
import { loadEnvironment } from '@hmn/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDatabaseClient } from './database.js';
import { withTenantTx } from './tenant.js';

// This test writes fixtures. Run only with dedicated DATABASE_* URLs.
describe.skipIf(process.env.HNOBAT_DB_TESTS !== 'isolated')('scheduling RLS on PostgreSQL', () => {
  const env = loadEnvironment();
  const app = createDatabaseClient({ connectionString: env.DATABASE_APP_URL });
  const admin = createDatabaseClient({ connectionString: env.DATABASE_URL });
  const tenantA = randomUUID(), tenantB = randomUUID(), doctorId = randomUUID();
  beforeAll(async () => {
    const user = await app.$queryRaw<{ who: string }[]>`SELECT current_user AS who`;
    expect(user[0]?.who).toBe('hmn_app');
    await admin.tenant.createMany({ data: [
      { id: tenantA, name: 'Isolated scheduling A', slug: `scheduling-a-${tenantA}` },
      { id: tenantB, name: 'Isolated scheduling B', slug: `scheduling-b-${tenantB}` },
    ] });
    await withTenantTx(app, tenantA, (tx) => tx.schedulingDoctor.create({ data: {
      id: doctorId, tenantId: tenantA, name: 'Test', engineUserId: 1,
      keyCiphertext: Uint8Array.from([1]), keyIv: Uint8Array.from([2]), keyAuthTag: Uint8Array.from([3]), keyVersion: 1,
    } }));
  });
  afterAll(async () => {
    await admin.tenant.deleteMany({ where: { id: { in: [tenantA, tenantB] } } });
    await app.$disconnect();
    await admin.$disconnect();
  });
  it('shows only the current tenant and fails closed without context', async () => {
    expect(await app.schedulingDoctor.findMany()).toEqual([]);
    expect(await withTenantTx(app, tenantA, (tx) => tx.schedulingDoctor.findMany())).toHaveLength(1);
    expect(await withTenantTx(app, tenantB, (tx) => tx.schedulingDoctor.findMany())).toEqual([]);
    expect(await withTenantTx(app, tenantB, (tx) => tx.schedulingDoctor.findUnique({ where: { id: doctorId } }))).toBeNull();
  });
  it('rejects cross-tenant inserts and ignores cross-tenant updates', async () => {
    await expect(withTenantTx(app, tenantB, (tx) => tx.schedulingDoctor.create({ data: {
      id: randomUUID(), tenantId: tenantA, name: 'Unauthorized', engineUserId: 2,
      keyCiphertext: Uint8Array.from([1]), keyIv: Uint8Array.from([2]), keyAuthTag: Uint8Array.from([3]), keyVersion: 1,
    } }))).rejects.toThrow();
    const result = await withTenantTx(app, tenantB, (tx) => tx.schedulingDoctor.updateMany({ where: { id: doctorId }, data: { name: 'Changed' } }));
    expect(result.count).toBe(0);
  });
});
