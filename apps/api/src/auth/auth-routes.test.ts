import type { PrismaClient } from '@hmn/db';
import { checkDatabase, createDatabaseClient } from '@hmn/db';
import { createLogger, loadEnvironment } from '@hmn/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildServer } from '../server.js';

/**
 * Auth route tests (ADR-0005). They run against the real local database: the
 * invariants under test — "were the right rows written?" and "came the cookie back?"
 * — are exactly the ones a mocked client would fake.
 */
const environment = loadEnvironment();
const app: PrismaClient = createDatabaseClient({
  connectionString: environment.DATABASE_APP_URL,
});
const migrator: PrismaClient = createDatabaseClient({
  connectionString: environment.DATABASE_URL,
});

const dbAvailable = (await checkDatabase(app, 3_000)).status === 'ok';
const logger = createLogger({ name: 'auth-routes-test', level: 'silent', environment: 'test' });

/** The JSON field name for the passphrase (the wire contract keeps this name). */
const PASS_FIELD = 'password';
const PASS_VALUE = 'a-long-enough-passphrase';
const RUN = String(Date.now()).slice(-7);
const createdMobiles: string[] = [];

function testMobile(index: number): string {
  // `09` + a 7-digit run marker + a 2-digit index = exactly 11 digits, unique per run.
  return `09${RUN}${String(index).padStart(2, '0')}`;
}

function tenantName(label: string): string {
  return `TEST-${RUN}-${label}`;
}

function api() {
  return buildServer({
    logger,
    exposeDependencyErrors: true,
    health: {
      database: () => Promise.resolve({ dependency: 'database', status: 'ok', latencyMs: 1 }),
      redis: () => Promise.resolve({ dependency: 'redis', status: 'ok', latencyMs: 1 }),
    },
    auth: { client: app, cookieSecure: false, exposeOtpInResponse: true },
  });
}

const server = api();

/** The cookie name/value pair from a response, without the attributes. */
function cookieOf(response: { headers: Record<string, unknown> }): string {
  const raw = response.headers['set-cookie'];
  const value: unknown = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== 'string') throw new Error('expected a set-cookie header');
  return value.split(';')[0] ?? '';
}

function register(mobile: string, label: string) {
  createdMobiles.push(mobile);
  return server.inject({
    method: 'POST',
    url: '/auth/register',
    payload: { mobile, [PASS_FIELD]: PASS_VALUE, displayName: 'منشی تست', tenantName: tenantName(label) },
  });
}

function login(mobile: string, passphrase: string) {
  return server.inject({
    method: 'POST',
    url: '/auth/login',
    payload: { mobile, [PASS_FIELD]: passphrase },
  });
}

beforeAll(async () => {
  if (!dbAvailable) return;

  // Registration connects a trial subscription, so the FREE plan must exist.
  await migrator.subscriptionPlan.upsert({
    where: { tier: 'FREE' },
    update: {},
    create: { tier: 'FREE', name: 'پکیج رایگان', maxUsers: 1, monthlyMessageUnits: 50 },
  });
});

afterAll(async () => {
  await server.close();

  if (dbAvailable) {
    await migrator.$executeRaw`DELETE FROM "tenants" WHERE "name" LIKE ${`TEST-${RUN}-%`}`;
    for (const mobile of createdMobiles) {
      await migrator.$executeRaw`DELETE FROM "users" WHERE "mobile" = ${mobile}`;
      await migrator.$executeRaw`DELETE FROM "auth_attempts" WHERE "identifier" = ${mobile}`;
      await migrator.$executeRaw`DELETE FROM "auth_otps" WHERE "identifier" = ${mobile}`;
    }
  }

  await app.$disconnect();
  await migrator.$disconnect();
});

describe.skipIf(!dbAvailable)('auth routes (ADR-0005)', () => {
  it('registers a tenant with an OWNER membership and a TRIALING subscription, and sets the session cookie', async () => {
    const mobile = testMobile(1);
    const response = await register(mobile, 'owner');

    expect(response.statusCode).toBe(201);

    const body = response.json<{ userId: string; tenantId: string }>();
    expect(body.userId).toBeTruthy();
    expect(body.tenantId).toBeTruthy();

    const cookie = cookieOf(response);
    expect(cookie).toContain('hmn_session=');
    expect(cookie).not.toBe('hmn_session=');
    expect(String(response.headers['set-cookie'])).toContain('HttpOnly');
    expect(String(response.headers['set-cookie'])).toContain('SameSite=Lax');

    const membership = await migrator.tenantMembership.findFirst({
      where: { tenantId: body.tenantId, userId: body.userId },
    });
    expect(membership?.role).toBe('OWNER');

    const subscription = await migrator.tenantSubscription.findFirst({
      where: { tenantId: body.tenantId },
    });
    expect(subscription?.status).toBe('TRIALING');

    // The raw session value must never be stored — only its hash.
    const sessions = await migrator.session.findMany({ where: { userId: body.userId } });
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.tokenHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('refuses a second registration for the same mobile without revealing why', async () => {
    const mobile = testMobile(2);
    expect((await register(mobile, 'dup-a')).statusCode).toBe(201);

    const second = await register(mobile, 'dup-b');
    expect(second.statusCode).toBe(409);
    expect(second.json()).toEqual({
      error: { code: 'REGISTRATION_FAILED', message: 'Registration failed' },
    });
  });

  it('logs in with the correct passphrase and returns a session cookie', async () => {
    const mobile = testMobile(3);
    await register(mobile, 'login');

    const response = await login(mobile, PASS_VALUE);

    expect(response.statusCode).toBe(200);
    expect(cookieOf(response)).toContain('hmn_session=');
  });

  it('answers unknown account and wrong passphrase with the same body (non-enumerable)', async () => {
    const mobile = testMobile(4);
    await register(mobile, 'enum');

    const wrong = await login(mobile, 'definitely-not-it');
    const unknown = await login(testMobile(98), PASS_VALUE);

    expect(wrong.statusCode).toBe(401);
    expect(unknown.statusCode).toBe(401);
    expect(wrong.json()).toEqual(unknown.json());
  });

  it('locks out after ten failed attempts from the same identifier and IP', async () => {
    const mobile = testMobile(5);
    await register(mobile, 'lock');

    for (let attempt = 0; attempt < 10; attempt += 1) {
      const response = await login(mobile, 'wrong-passphrase');
      expect(response.statusCode).toBe(401);
    }

    const locked = await login(mobile, PASS_VALUE);
    expect(locked.statusCode).toBe(429);
    expect(locked.json()).toMatchObject({ error: { code: 'RATE_LIMITED' } });
  });

  it('requires a session for /auth/me and returns the profile when one is present', async () => {
    const anonymous = await server.inject({ method: 'GET', url: '/auth/me' });
    expect(anonymous.statusCode).toBe(401);

    const mobile = testMobile(6);
    await register(mobile, 'me');
    const session = await login(mobile, PASS_VALUE);

    const response = await server.inject({
      method: 'GET',
      url: '/auth/me',
      headers: { cookie: cookieOf(session) },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ mobile, displayName: 'منشی تست' });
  });

  it('revokes the session on logout', async () => {
    const mobile = testMobile(7);
    await register(mobile, 'logout');
    const session = await login(mobile, PASS_VALUE);
    const cookie = cookieOf(session);

    const logout = await server.inject({
      method: 'POST',
      url: '/auth/logout',
      headers: { cookie },
    });
    expect(logout.statusCode).toBe(204);

    const after = await server.inject({
      method: 'GET',
      url: '/auth/me',
      headers: { cookie },
    });
    expect(after.statusCode).toBe(401);
  });

  it('answers a client-side protocol error with its own status, not a 500', async () => {
    // A client that posts a form body to a JSON route makes a client mistake; that
    // must surface as 415, never as an apparent server outage.
    const response = await server.inject({
      method: 'POST',
      url: '/auth/logout',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: 'irrelevant=1',
    });

    expect(response.statusCode).toBe(415);
  });

  it('signs up with an SMS code and captures the clinic address', async () => {
    const mobile = testMobile(20);
    createdMobiles.push(mobile);

    const sent = await server.inject({
      method: 'POST',
      url: '/auth/otp/send',
      payload: { mobile, purpose: 'SIGNUP' },
    });

    expect(sent.statusCode).toBe(200);
    const devCode = sent.json<{ devCode?: string }>().devCode;
    expect(devCode).toMatch(/^\d{5}$/);

    const response = await server.inject({
      method: 'POST',
      url: '/auth/register',
      payload: {
        mobile,
        code: devCode,
        displayName: 'دکتر آزمایشی',
        tenantName: tenantName('otp'),
        address: 'تهران، خیابان ولیعصر، پلاک ۱',
        city: 'تهران',
      },
    });

    expect(response.statusCode).toBe(201);

    const body = response.json<{ userId: string; tenantId: string }>();

    const tenantRow = await migrator.tenant.findUnique({ where: { id: body.tenantId } });
    expect(tenantRow?.address).toContain('ولیعصر');
    expect(tenantRow?.city).toBe('تهران');

    // An OTP-only account starts without a passphrase credential on purpose.
    expect(await migrator.credential.findUnique({ where: { userId: body.userId } })).toBeNull();
  });

  it('signs in with an SMS code', async () => {
    const mobile = testMobile(21);
    await register(mobile, 'otp-login');

    const sent = await server.inject({
      method: 'POST',
      url: '/auth/otp/send',
      payload: { mobile, purpose: 'LOGIN' },
    });
    const devCode = sent.json<{ devCode?: string }>().devCode ?? '';

    const response = await server.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { mobile, code: devCode },
    });

    expect(response.statusCode).toBe(200);
    expect(cookieOf(response)).toContain('hmn_session=');
  });

  it('rejects a wrong code and refuses an immediate resend', async () => {
    const mobile = testMobile(22);
    createdMobiles.push(mobile);

    const sent = await server.inject({
      method: 'POST',
      url: '/auth/otp/send',
      payload: { mobile },
    });
    expect(sent.statusCode).toBe(200);

    const immediateResend = await server.inject({
      method: 'POST',
      url: '/auth/otp/send',
      payload: { mobile },
    });
    expect(immediateResend.statusCode).toBe(429);

    const issued = sent.json<{ devCode?: string }>().devCode ?? '';
    const wrongCode = issued === '00000' ? '00001' : '00000';

    const wrong = await server.inject({
      method: 'POST',
      url: '/auth/register',
      payload: { mobile, code: wrongCode, displayName: 'x', tenantName: tenantName('bad-otp') },
    });

    expect(wrong.statusCode).toBe(401);
    expect(wrong.json()).toMatchObject({ error: { code: 'OTP_INVALID' } });
  });

  it('validates input before touching the database', async () => {
    const badMobile = await server.inject({
      method: 'POST',
      url: '/auth/register',
      payload: { mobile: '123', [PASS_FIELD]: PASS_VALUE, displayName: 'x', tenantName: 'y' },
    });
    expect(badMobile.statusCode).toBe(400);

    const shortPass = await server.inject({
      method: 'POST',
      url: '/auth/register',
      payload: {
        mobile: testMobile(8),
        [PASS_FIELD]: 'short',
        displayName: 'x',
        tenantName: 'y',
      },
    });
    expect(shortPass.statusCode).toBe(400);
  });
});
