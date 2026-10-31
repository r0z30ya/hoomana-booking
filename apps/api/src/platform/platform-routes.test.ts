import { checkDatabase, createDatabaseClient } from '@hmn/db';
import {
  createLogger,
  hashPassword,
  loadEnvironment,
  mfaConfigFromEnvironment,
  totpCode,
} from '@hmn/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildServer } from '../server.js';

const environment = loadEnvironment();
const platform = createDatabaseClient({
  connectionString: environment.DATABASE_PLATFORM_URL ?? environment.DATABASE_APP_URL,
});
const migrator = createDatabaseClient({ connectionString: environment.DATABASE_URL });
const mfa = mfaConfigFromEnvironment(environment);
const logger = createLogger({ name: 'platform-routes-test', level: 'silent', environment: 'test' });
const run = String(Date.now()).slice(-7);
const adminMobile = `09${run}91`;
const ownerMobile = `09${run}92`;
let adminId = '';
let tenantId = '';

function cookieOf(response: { headers: Record<string, unknown> }): string {
  const raw = response.headers['set-cookie'];
  const value: unknown = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== 'string') throw new Error('expected a set-cookie header');
  return value.split(';')[0] ?? '';
}

const app = buildServer({
  logger,
  exposeDependencyErrors: true,
  health: {
    database: () => Promise.resolve({ dependency: 'database', status: 'ok', latencyMs: 1 }),
    redis: () => Promise.resolve({ dependency: 'redis', status: 'ok', latencyMs: 1 }),
  },
  platform: { client: platform, ...(mfa === undefined ? {} : { mfa }) },
});

const dbAvailable = (await checkDatabase(platform, 3_000)).status === 'ok';

beforeAll(async () => {
  if (!dbAvailable || mfa === undefined) return;
  const passwordHash = await hashPassword('platform-test-passphrase');
  const admin = await migrator.user.create({
    data: { mobile: adminMobile, displayName: 'Platform Test Admin' },
  });
  adminId = admin.id;
  await migrator.credential.create({ data: { userId: admin.id, passwordHash } });
  await migrator.platformAdmin.create({ data: { userId: admin.id } });
  await migrator.subscriptionPlan.upsert({
    where: { tier: 'PRO' },
    update: {},
    create: { tier: 'PRO', name: 'Pro', maxUsers: 10, monthlyMessageUnits: 1000 },
  });
});

afterAll(async () => {
  if (adminId) await migrator.user.delete({ where: { id: adminId } });
  if (tenantId) await migrator.tenant.delete({ where: { id: tenantId } });
  await platform.$disconnect();
  await migrator.$disconnect();
});

describe('platform admin routes', () => {
  it('enrols MFA, signs in, manages customer state and exposes audited details', async ({
    skip,
  }) => {
    if (!dbAvailable || mfa === undefined) {
      skip('platform database or MFA key is unavailable');
      return;
    }

    const first = await app.inject({
      method: 'POST',
      url: '/platform/auth/login',
      payload: { mobile: adminMobile, password: 'platform-test-passphrase' },
    });
    expect(first.statusCode).toBe(200);
    const enrollment = first.json() as { enrollmentToken: string; secret: string };
    const secret = Buffer.from(enrollment.secret, 'base64');
    const enroll = await app.inject({
      method: 'POST',
      url: '/platform/auth/enroll',
      payload: { enrollmentToken: enrollment.enrollmentToken, code: totpCode(secret) },
    });
    expect(enroll.statusCode).toBe(200);
    const cookie = cookieOf(enroll);

    const created = await app.inject({
      method: 'POST',
      url: '/platform/accounts',
      headers: { cookie },
      payload: {
        name: `Platform Test Clinic ${run}`,
        slug: `platform-test-${run}`,
        ownerName: 'Clinic Owner',
        ownerMobile,
        planTier: 'PRO',
      },
    });
    expect(created.statusCode).toBe(201);
    tenantId = (created.json() as { account: { tenantId: string } }).account.tenantId;

    const listed = await app.inject({
      method: 'GET',
      url: '/platform/accounts',
      headers: { cookie },
    });
    expect(listed.statusCode).toBe(200);
    expect(
      (listed.json() as { accounts: Array<{ id: string }> }).accounts.some(
        (item) => item.id === tenantId,
      ),
    ).toBe(true);

    const suspended = await app.inject({
      method: 'POST',
      url: `/platform/accounts/${tenantId}/state`,
      headers: { cookie },
      payload: { state: 'SUSPENDED', reason: 'Test suspension' },
    });
    expect(suspended.statusCode).toBe(200);

    const detail = await app.inject({
      method: 'GET',
      url: `/platform/accounts/${tenantId}`,
      headers: { cookie },
    });
    expect(detail.statusCode).toBe(200);
    expect(
      (detail.json() as { account: { state: string }; activity: unknown[] }).account.state,
    ).toBe('SUSPENDED');
    expect((detail.json() as { activity: unknown[] }).activity.length).toBeGreaterThan(0);

    const subscription = await app.inject({
      method: 'POST',
      url: `/platform/accounts/${tenantId}/subscription`,
      headers: { cookie },
      payload: { planTier: 'PRO', months: 3 },
    });
    expect(subscription.statusCode).toBe(200);

    const deleted = await app.inject({
      method: 'DELETE',
      url: `/platform/accounts/${tenantId}`,
      headers: { cookie },
    });
    expect(deleted.statusCode).toBe(200);
  });
});
