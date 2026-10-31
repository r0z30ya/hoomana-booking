import { checkDatabase, createDatabaseClient, type PrismaClient } from '@hmn/db';
import { createLogger } from '@hmn/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildServer } from '../server.js';

const app: PrismaClient = createDatabaseClient({
  connectionString:
    process.env.DATABASE_APP_URL ??
    'postgresql://hmn_app:app@127.0.0.1:5432/hmn_saas?schema=public',
});
const migrator: PrismaClient = createDatabaseClient({
  connectionString:
    process.env.DATABASE_URL ??
    'postgresql://hmn_migrator:migrator@127.0.0.1:5432/hmn_saas?schema=public',
});
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
  tenantAccount: { client: app, smsEncryption: { key, keyVersion: 1 } },
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

    const domain = await server.inject({
      method: 'POST',
      url: '/tenant/domains',
      headers: { cookie },
      payload: { hostname: `${tenantName.toLowerCase()}.example.com` },
    });
    expect(domain.statusCode).toBe(201);
    const domainBody = domain.json<{ domain: { id: string; verificationToken: string } }>();
    expect(domainBody.domain.verificationToken).toHaveLength(36);

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

    const sms = await server.inject({
      method: 'POST',
      url: '/tenant/sms',
      headers: { cookie },
      payload: { provider: 'melipayamak', panelRef: 'PANEL-REFERENCE-123456', sender: '50001234' },
    });
    expect(sms.statusCode).toBe(200);
    expect(sms.json()).toMatchObject({ sms: { configured: true, sender: '50001234' } });
    expect(JSON.stringify(sms.json())).not.toContain('PANEL-REFERENCE-123456');

    const checked = await server.inject({
      method: 'POST',
      url: '/tenant/sms/check',
      headers: { cookie },
    });
    expect(checked.statusCode).toBe(200);
    expect(checked.json()).toMatchObject({ sms: { configured: true, panelRefLength: 22 } });

    const subscription = await server.inject({
      method: 'POST',
      url: '/tenant/subscription',
      headers: { cookie },
      payload: { tier: 'PRO', months: 3 },
    });
    expect(subscription.statusCode).toBe(200);
    expect(subscription.json()).toMatchObject({ subscription: { tier: 'PRO', status: 'ACTIVE' } });
  });
});
