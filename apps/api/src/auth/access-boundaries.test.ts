import { randomInt, randomUUID } from 'node:crypto';
import {
  checkDatabase,
  createDatabaseClient,
  createOtp,
  hashOtpCode,
  hashToken,
  withTenantTx,
} from '@hmn/db';
import { createLogger, loadEnvironment } from '@hmn/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildServer } from '../server.js';

const env = loadEnvironment();
const app = createDatabaseClient({ connectionString: env.DATABASE_APP_URL });
const admin = createDatabaseClient({ connectionString: env.DATABASE_URL });
const available = (await checkDatabase(app, 3000)).status === 'ok';
const server = buildServer({
  logger: createLogger({ name: 'access-boundaries', level: 'silent', environment: 'test' }),
  exposeDependencyErrors: true,
  health: {
    database: () => Promise.resolve({ dependency: 'database', status: 'ok', latencyMs: 1 }),
    redis: () => Promise.resolve({ dependency: 'redis', status: 'ok', latencyMs: 1 }),
  },
  auth: { client: app, cookieSecure: false, exposeOtpInResponse: true },
  tenantAccount: { client: app, customDomainsEnabled: true },
});

const passphrase = 'a-long-enough-test-passphrase';
const clinics: Array<{ mobile: string; userId: string; tenantId: string; cookie: string }> = [];
const ownedMobiles: string[] = [];

function cookieOf(response: { headers: Record<string, unknown> }): string {
  const raw = response.headers['set-cookie'];
  const value: unknown = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== 'string') throw new Error('missing cookie');
  return value.split(';')[0] ?? '';
}

async function login(mobile: string) {
  return server.inject({
    method: 'POST',
    url: '/auth/login',
    payload: { mobile, password: passphrase },
  });
}

describe.skipIf(!available)('identity and tenant boundaries', () => {
  beforeAll(async () => {
    // Never reuse an existing mobile: cleanup is limited to records created by this run.
    for (let i = 0; i < 2; i++) {
      let mobile: string;
      do {
        mobile = `09${String(randomInt(0, 1_000_000_000)).padStart(9, '0')}`;
      } while (
        ownedMobiles.includes(mobile) ||
        (await admin.user.findUnique({ where: { mobile } })) !== null ||
        (await admin.authOtp.count({ where: { identifier: mobile } })) !== 0 ||
        (await admin.authAttempt.count({ where: { identifier: mobile } })) !== 0
      );
      const response = await server.inject({
        method: 'POST',
        url: '/auth/register',
        payload: {
          mobile,
          password: passphrase,
          displayName: 'Test',
          tenantName: `TEST-${randomUUID()}`,
        },
      });
      expect(response.statusCode, response.body).toBe(201);
      const body = response.json<{ userId: string; tenantId: string }>();
      ownedMobiles.push(mobile);
      clinics.push({ mobile, ...body, cookie: cookieOf(response) });
    }
  });

  afterAll(async () => {
    await server.close();
    for (const clinic of clinics) {
      await admin.tenant.deleteMany({ where: { id: clinic.tenantId } });
      await admin.user.deleteMany({ where: { id: clinic.userId } });
    }
    for (const mobile of ownedMobiles) {
      await admin.authOtp.deleteMany({ where: { identifier: mobile } });
      await admin.authAttempt.deleteMany({ where: { identifier: mobile } });
    }
    await app.$disconnect();
    await admin.$disconnect();
  });

  it('isolates clinic rows using the application database role', async () => {
    const first = clinics[0]!;
    const second = clinics[1]!;
    const domain = await withTenantTx(admin, second.tenantId, (tx) =>
      tx.domain.create({
        data: { tenantId: second.tenantId, hostname: `${randomUUID()}.example.test` },
      }),
    );
    const visible = await withTenantTx(app, first.tenantId, (tx) =>
      tx.domain.findMany({ where: { id: domain.id } }),
    );
    const modified = await withTenantTx(app, first.tenantId, (tx) =>
      tx.domain.updateMany({
        where: { id: domain.id },
        data: { isPrimary: true },
      }),
    );
    expect(visible).toHaveLength(0);
    expect(modified.count).toBe(0);
    const settings = await server.inject({
      method: 'GET',
      url: '/tenant/settings',
      headers: { cookie: first.cookie },
    });
    expect(settings.statusCode).toBe(200);
    expect(settings.json<{ tenant: { id: string }; domains: unknown[] }>().tenant.id).toBe(
      first.tenantId,
    );
    expect(settings.json<{ domains: unknown[] }>().domains).toHaveLength(0);
  });

  it('denies owner settings after a role change', async () => {
    const clinic = clinics[0]!;
    await withTenantTx(admin, clinic.tenantId, (tx) =>
      tx.tenantMembership.update({
        where: { tenantId_userId: { tenantId: clinic.tenantId, userId: clinic.userId } },
        data: { role: 'RECEPTION' },
      }),
    );
    const response = await server.inject({
      method: 'GET',
      url: '/tenant/settings',
      headers: { cookie: clinic.cookie },
    });
    expect(response.statusCode).toBe(403);
    await withTenantTx(admin, clinic.tenantId, (tx) =>
      tx.tenantMembership.update({
        where: { tenantId_userId: { tenantId: clinic.tenantId, userId: clinic.userId } },
        data: { role: 'OWNER' },
      }),
    );
  });

  it.each(['expiresAt', 'idleExpiresAt'] as const)(
    'rejects a session past %s',
    async (deadline) => {
      const clinic = clinics[0]!;
      const signedIn = await login(clinic.mobile);
      expect(signedIn.statusCode).toBe(200);
      const cookie = cookieOf(signedIn);
      const raw = cookie.slice(cookie.indexOf('=') + 1);
      await admin.session.update({
        where: { tokenHash: hashToken(raw) },
        data: { [deadline]: new Date(Date.now() - 1000) },
      });
      const response = await server.inject({
        method: 'GET',
        url: '/tenant/settings',
        headers: { cookie },
      });
      expect(response.statusCode).toBe(401);
    },
  );

  it.each(['suspended', 'blocked'] as const)(
    'revokes an existing session for a %s clinic',
    async (state) => {
      const clinic = clinics[0]!;
      const signedIn = await login(clinic.mobile);
      expect(signedIn.statusCode).toBe(200);
      const cookie = cookieOf(signedIn);
      await admin.tenant.update({
        where: { id: clinic.tenantId },
        data: state === 'suspended' ? { isSuspended: true } : { blockedAt: new Date() },
      });
      const response = await server.inject({
        method: 'GET',
        url: '/tenant/settings',
        headers: { cookie },
      });
      expect(response.statusCode).toBe(401);
      await admin.tenant.update({
        where: { id: clinic.tenantId },
        data: { isSuspended: false, blockedAt: null },
      });
      const revoked = await server.inject({ method: 'GET', url: '/auth/me', headers: { cookie } });
      expect(revoked.statusCode).toBe(401);
    },
  );

  it('accepts a new OTP only once under concurrency and never revives an older code', async () => {
    const clinic = clinics[1]!;
    await createOtp(admin, {
      identifier: clinic.mobile,
      purpose: 'LOGIN',
      codeHash: hashOtpCode('111111'),
      expiresAt: new Date(Date.now() + 60000),
    });
    await createOtp(admin, {
      identifier: clinic.mobile,
      purpose: 'LOGIN',
      codeHash: hashOtpCode('222222'),
      expiresAt: new Date(Date.now() + 60000),
    });
    const attempt = (code: string) =>
      server.inject({
        method: 'POST',
        url: '/auth/login',
        payload: { mobile: clinic.mobile, code },
      });
    const results = await Promise.all([attempt('222222'), attempt('222222')]);
    expect(results.map((result) => result.statusCode).sort()).toEqual([200, 401]);
    expect((await attempt('111111')).statusCode).toBe(401);
  });

  it('rejects sessions and login for an inactive user', async () => {
    const clinic = clinics[1]!;
    await admin.user.update({ where: { id: clinic.userId }, data: { isActive: false } });
    const settings = await server.inject({
      method: 'GET',
      url: '/tenant/settings',
      headers: { cookie: clinic.cookie },
    });
    expect(settings.statusCode).toBe(401);
    expect((await login(clinic.mobile)).statusCode).toBe(401);
    await createOtp(admin, {
      identifier: clinic.mobile,
      purpose: 'LOGIN',
      codeHash: hashOtpCode('333333'),
      expiresAt: new Date(Date.now() + 60000),
    });
    const otpLogin = await server.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { mobile: clinic.mobile, code: '333333' },
    });
    expect(otpLogin.statusCode).toBe(401);
  });
});
