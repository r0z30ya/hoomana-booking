import type { PrismaClient } from '@hmn/db';
import { createLogger, decryptSecret } from '@hmn/shared';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildServer } from '../server.js';

const adminId = '11111111-1111-4111-8111-111111111111';
const tenantId = '22222222-2222-4222-8222-222222222222';
const key = Buffer.alloc(32, 7);
const query = vi.fn((strings: TemplateStringsArray, ..._values: unknown[]) => {
  const sql = strings.join('?');
  if (sql.includes('platform_auth_find_session')) {
    return Promise.resolve([
      {
        id: adminId,
        userId: adminId,
        displayName: 'Admin',
        mobile: '09120000000',
        expiresAt: new Date(Date.now() + 60_000),
        idleExpiresAt: new Date(Date.now() + 60_000),
        revokedAt: null,
      },
    ]);
  }
  if (sql.includes('platform_auth_touch_session')) return Promise.resolve([]);
  return Promise.resolve([{ changed: true }]);
});
const app = buildServer({
  logger: createLogger({ name: 'platform-management-test', level: 'silent', environment: 'test' }),
  exposeDependencyErrors: false,
  health: {
    database: () => Promise.resolve({ dependency: 'database', status: 'ok', latencyMs: 0 }),
    redis: () => Promise.resolve({ dependency: 'redis', status: 'ok', latencyMs: 0 }),
  },
  platform: {
    client: { $queryRaw: query } as unknown as PrismaClient,
    smsEncryption: { key, keyVersion: 1 },
  },
});
const headers = { cookie: 'hmn_admin_session=testing' };

beforeEach(() => {
  query.mockClear();
});
afterAll(async () => app.close());

describe('platform domain and SMS management', () => {
  it('requires a platform session before either operation', async () => {
    for (const path of ['domains', 'sms']) {
      const response = await app.inject({
        method: 'POST',
        url: `/platform/accounts/${tenantId}/${path}`,
        payload: {},
      });
      expect(response.statusCode).toBe(401);
    }
    expect(query).not.toHaveBeenCalled();
  });

  it('rejects invalid domains and sends a fresh token for valid domains', async () => {
    const invalid = await app.inject({
      method: 'POST',
      url: `/platform/accounts/${tenantId}/domains`,
      headers,
      payload: { hostname: 'bad..example.com' },
    });
    expect(invalid.statusCode).toBe(400);
    const response = await app.inject({
      method: 'POST',
      url: `/platform/accounts/${tenantId}/domains`,
      headers,
      payload: { hostname: 'Clinic.Example.com' },
    });
    expect(response.statusCode).toBe(200);
    const call = query.mock.calls.find(([sql]) => sql.join('?').includes('platform_save_domain'));
    expect(call?.[3]).toBe('clinic.example.com');
    expect(call?.[4]).toMatch(/^[a-f0-9]{36}$/);
  });

  it('encrypts the SMS credential and does not return it to the browser', async () => {
    const secret = 'panel-reference-123456';
    const response = await app.inject({
      method: 'POST',
      url: `/platform/accounts/${tenantId}/sms`,
      headers,
      payload: { panelRef: secret, sender: '50001234' },
    });
    expect(response.statusCode).toBe(200);
    expect(response.body).not.toContain(secret);
    const call = query.mock.calls.find(([sql]) => sql.join('?').includes('platform_save_sms'));
    expect(call).toBeDefined();
    if (!call) throw new Error('missing database call');
    const [, tenant, account, ciphertext, iv, authTag] = call;
    expect(
      decryptSecret(
        { ciphertext: ciphertext as Buffer, iv: iv as Buffer, authTag: authTag as Buffer },
        `${String(tenant)}|${String(account)}`,
        { key, keyVersion: 1 },
      ),
    ).toBe(secret);
  });
});
