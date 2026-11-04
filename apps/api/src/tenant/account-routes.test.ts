import { checkDatabase, createDatabaseClient, withTenantTx, type PrismaClient } from '@hmn/db';
import { createLogger, loadEnvironment } from '@hmn/shared';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('node:dns/promises', () => ({ resolveTxt: vi.fn() }));
import { resolveTxt } from 'node:dns/promises';
import { buildServer } from '../server.js';

const environment = loadEnvironment();
const app: PrismaClient = createDatabaseClient({ connectionString: environment.DATABASE_APP_URL });
const migrator: PrismaClient = createDatabaseClient({ connectionString: environment.DATABASE_URL });
const dbAvailable = (await checkDatabase(app, 3_000)).status === 'ok';
const logger = createLogger({ name: 'account-routes-test', level: 'silent', environment: 'test' });
const key = Buffer.alloc(32, 7);
const run = String(Date.now()).slice(-7);
const mobile = `09${run}91`;
const tenantName = `TEST-${run}-account-settings`;

const server = buildServer({
  logger,
  exposeDependencyErrors: true,
  health: {
    database: () => Promise.resolve({ dependency: 'database', status: 'ok', latencyMs: 1 }),
    redis: () => Promise.resolve({ dependency: 'redis', status: 'ok', latencyMs: 1 }),
  },
  auth: { client: app, cookieSecure: false, exposeOtpInResponse: true },
  tenantAccount: { client: app, smsEncryption: { key, keyVersion: 1 }, customDomainsEnabled: true },
});
const disabledServer = buildServer({
  logger,
  exposeDependencyErrors: true,
  health: {
    database: () => Promise.resolve({ dependency: 'database', status: 'ok', latencyMs: 1 }),
    redis: () => Promise.resolve({ dependency: 'redis', status: 'ok', latencyMs: 1 }),
  },
  auth: { client: app, cookieSecure: false },
  tenantAccount: { client: app },
});

function cookieOf(response: { headers: Record<string, unknown> }): string {
  const raw = response.headers['set-cookie'];
  const value: unknown = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== 'string') throw new Error('expected a session cookie');
  return value.split(';')[0] ?? '';
}

describe.skipIf(!dbAvailable)('tenant account management', () => {
  let cookie = '';

  beforeAll(async () => {
    await migrator.subscriptionPlan.upsert({
      where: { tier: 'FREE' },
      update: {},
      create: { tier: 'FREE', name: 'پایه', maxUsers: 1, monthlyMessageUnits: 100 },
    });
    await migrator.subscriptionPlan.upsert({
      where: { tier: 'PRO' },
      update: {},
      create: { tier: 'PRO', name: 'حرفه‌ای', maxUsers: 20, monthlyMessageUnits: 5000 },
    });

    const response = await server.inject({
      method: 'POST',
      url: '/auth/register',
      payload: {
        mobile,
        password: 'a-long-enough-passphrase',
        displayName: 'مدیر تست',
        tenantName,
      },
    });
    expect(response.statusCode).toBe(201);
    cookie = cookieOf(response);
  });

  afterAll(async () => {
    await server.close();
    await disabledServer.close();
    if (dbAvailable) {
      await migrator.$executeRaw`DELETE FROM "tenants" WHERE "name" = ${tenantName}`;
      await migrator.$executeRaw`DELETE FROM "users" WHERE "mobile" = ${mobile}`;
    }
    await app.$disconnect();
    await migrator.$disconnect();
  });

  it('manages a verified domain, independent SMS panel and subscription', async () => {
    const settings = await server.inject({
      method: 'GET',
      url: '/tenant/settings',
      headers: { cookie },
    });
    expect(settings.statusCode).toBe(200);
    expect(settings.json()).toMatchObject({ tenant: { name: tenantName }, domains: [], sms: null });

    for (const tier of ['STARTER', 'PRO', 'BUSINESS', 'ENTERPRISE']) {
      const subscription = await server.inject({
        method: 'POST',
        url: '/tenant/subscription',
        headers: { cookie },
        payload: { tier, months: 3 },
      });
      expect(subscription.statusCode).toBe(403);
      expect(subscription.json()).toMatchObject({
        error: { code: 'PAID_SUBSCRIPTION_REQUIRES_ACTIVATION' },
      });
    }

    const freeDomain = await server.inject({
      method: 'POST',
      url: '/tenant/domains',
      headers: { cookie },
      payload: { hostname: `${tenantName.toLowerCase()}.example.com` },
    });
    expect(freeDomain.statusCode).toBe(403);
    expect(freeDomain.json()).toMatchObject({ error: { code: 'DOMAIN_PAID_PLAN_REQUIRED' } });

    const tenantId = settings.json<{ tenant: { id: string } }>().tenant.id;
    const pro = await migrator.subscriptionPlan.findUniqueOrThrow({ where: { tier: 'PRO' } });
    await withTenantTx(migrator, tenantId, async (tx) => {
      const current = await tx.tenantSubscription.findFirstOrThrow({
        orderBy: { createdAt: 'desc' },
      });
      await tx.tenantSubscription.update({
        where: { id: current.id },
        data: {
          planId: pro.id,
          status: 'ACTIVE',
          currentPeriodStart: new Date(Date.now() - 60_000),
          currentPeriodEnd: new Date(Date.now() + 86_400_000),
        },
      });
    });

    const disabledDomain = await disabledServer.inject({
      method: 'POST',
      url: '/tenant/domains',
      headers: { cookie },
      payload: { hostname: `${tenantName.toLowerCase()}.example.com` },
    });
    expect(disabledDomain.statusCode).toBe(403);
    expect(disabledDomain.json()).toMatchObject({ error: { code: 'DOMAIN_FEATURE_DISABLED' } });

    const domain = await server.inject({
      method: 'POST',
      url: '/tenant/domains',
      headers: { cookie },
      payload: { hostname: `${tenantName.toLowerCase()}.example.com` },
    });
    expect(domain.statusCode, domain.body).toBe(201);
    const domainBody = domain.json<{ domain: { id: string; verificationToken: string } }>();
    expect(domainBody.domain.verificationToken).toHaveLength(36);

    vi.mocked(resolveTxt).mockResolvedValueOnce([['incorrect']]);
    const rejected = await server.inject({
      method: 'POST',
      url: `/tenant/domains/${domainBody.domain.id}/verify`,
      headers: { cookie },
      payload: { token: domainBody.domain.verificationToken },
    });
    expect(rejected.statusCode).toBe(422);
    vi.mocked(resolveTxt).mockResolvedValueOnce([[domainBody.domain.verificationToken]]);
    const verified = await server.inject({
      method: 'POST',
      url: `/tenant/domains/${domainBody.domain.id}/verify`,
      headers: { cookie },
      payload: { token: domainBody.domain.verificationToken },
    });
    expect(verified.statusCode).toBe(200);
    expect(verified.json()).toMatchObject({
      domain: { isVerified: true, verificationStatus: 'VERIFIED' },
    });

    await withTenantTx(migrator, tenantId, async (tx) => {
      const current = await tx.tenantSubscription.findFirstOrThrow({
        orderBy: { createdAt: 'desc' },
      });
      await tx.tenantSubscription.update({
        where: { id: current.id },
        data: { currentPeriodEnd: new Date(Date.now() - 1000) },
      });
    });
    const expiredDomain = await server.inject({
      method: 'POST',
      url: '/tenant/domains',
      headers: { cookie },
      payload: { hostname: `expired-${run}.example.com` },
    });
    expect(expiredDomain.statusCode).toBe(403);
    expect(expiredDomain.json()).toMatchObject({ error: { code: 'DOMAIN_PAID_PLAN_REQUIRED' } });

    for (const url of ['/tenant/sms', '/tenant/sms/disable', '/tenant/sms/check']) {
      const response = await server.inject({
        method: 'POST',
        url,
        headers: { cookie },
        payload: {},
      });
      expect(response.statusCode).toBe(403);
    }
  });
});
