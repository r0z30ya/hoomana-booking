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
    client: { $queryRaw: query, $transaction: (fn: (tx: { $queryRaw: typeof query }) => Promise<unknown>) => fn({ $queryRaw: query }) } as unknown as PrismaClient,
    smsEncryption: { key, keyVersion: 1 },
  },
});
const headers = { cookie: 'hmn_admin_session=testing' };

const centralCredit = vi.fn().mockResolvedValue({ amount: 12345 });
const saveCentral = vi.fn().mockResolvedValue(undefined);
const centralStatus = vi.fn().mockResolvedValue({ configured: true, sender: '500012345', otpConfigured: true, otpBodyId: 123, canEdit: true });
const centralApp = buildServer({
  logger: createLogger({ name: 'central-sms-test', level: 'silent', environment: 'test' }),
  exposeDependencyErrors: false,
  health: { database: () => Promise.resolve({ dependency: 'database', status: 'ok', latencyMs: 0 }), redis: () => Promise.resolve({ dependency: 'redis', status: 'ok', latencyMs: 0 }) },
  platform: { client: { $queryRaw: query } as unknown as PrismaClient, centralSms: { sender: '500012345', otpConfigured: true, fetchCredit: centralCredit } },
});
const centralSettingsApp = buildServer({
  logger: createLogger({ name: 'central-sms-settings-test', level: 'silent', environment: 'test' }),
  exposeDependencyErrors: false,
  health: { database: () => Promise.resolve({ dependency: 'database', status: 'ok', latencyMs: 0 }), redis: () => Promise.resolve({ dependency: 'redis', status: 'ok', latencyMs: 0 }) },
  platform: { client: { $queryRaw: query } as unknown as PrismaClient, centralSmsSettings: { status: centralStatus, save: saveCentral, fetchCredit: centralCredit } },
});

beforeEach(() => {
  query.mockClear();
});
afterAll(async () => { await app.close(); await centralApp.close(); await centralSettingsApp.close(); });

describe('platform domain and SMS management', () => {
  it('validates and saves all SMS templates as one operation', async () => {
    const sameOrigin = { ...headers, host: 'admin.localhost:3000', origin: 'http://admin.localhost:3000' };
    const templates = ['OTP', 'BOOKING', 'RESCHEDULE', 'CANCELLATION', 'REMINDER', 'DOCTOR_BOOKING'].map((event) => ({ event, bodyId: event === 'OTP' ? 123 : null }));
    expect((await app.inject({ method: 'POST', url: '/platform/sms/templates/batch', headers: sameOrigin, payload: { templates: templates.slice(1) } })).statusCode).toBe(400);
    expect(query.mock.calls.some(([sql]) => sql.join('?').includes('platform_save_sms_templates'))).toBe(false);
    expect((await app.inject({ method: 'POST', url: '/platform/sms/templates/batch', headers: sameOrigin, payload: { templates } })).statusCode).toBe(200);
    expect(query.mock.calls.filter(([sql]) => sql.join('?').includes('platform_save_sms_templates'))).toHaveLength(1);
  });
  it('restricts SMS templates to authenticated administrators and validates template mappings', async () => {
    const payload = { event: 'BOOKING', bodyId: 123 };
    expect((await app.inject({ method: 'POST', url: '/platform/sms/templates', payload })).statusCode).toBe(401);
    const sameOrigin = { ...headers, host: 'admin.localhost:3000', origin: 'http://admin.localhost:3000' };
    expect((await app.inject({ method: 'POST', url: '/platform/sms/templates', headers: { ...sameOrigin, origin: 'http://other.localhost:3000' }, payload })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: '/platform/sms/templates', headers: sameOrigin, payload: { ...payload, event: 'OTHER' } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: '/platform/sms/templates', headers: sameOrigin, payload })).statusCode).toBe(200);
    expect(query.mock.calls.some(([sql]) => sql.join('?').includes('platform_save_central_sms_template'))).toBe(true);
  });
  it('only accepts authenticated same-origin, valid central settings without returning the key', async () => {
    saveCentral.mockClear();
    const payload = { sender: '50001234', otpBodyId: 123, panelRef: 'panel-reference-secret-123' };
    expect((await centralSettingsApp.inject({ method: 'POST', url: '/platform/sms/central', payload })).statusCode).toBe(401);
    expect((await centralSettingsApp.inject({ method: 'POST', url: '/platform/sms/central', headers: { ...headers, host: 'admin.localhost:3000', origin: 'http://evil.example' }, payload })).statusCode).toBe(400);
    const sameOrigin = { ...headers, host: 'admin.localhost:3000', origin: 'http://admin.localhost:3000' };
    expect((await centralSettingsApp.inject({ method: 'POST', url: '/platform/sms/central', headers: sameOrigin, payload: { ...payload, otpBodyId: 0 } })).statusCode).toBe(400);
    const saved = await centralSettingsApp.inject({ method: 'POST', url: '/platform/sms/central', headers: sameOrigin, payload });
    expect(saved.statusCode).toBe(200);
    expect(saved.body).not.toContain(payload.panelRef);
    expect(saveCentral).toHaveBeenCalledTimes(1);
  });
  it('restricts central SMS connection checks and returns the provider balance', async () => {
    centralCredit.mockClear();
    expect((await centralApp.inject({ method: 'GET', url: '/platform/sms/central' })).statusCode).toBe(401);
    const status = await centralApp.inject({ method: 'GET', url: '/platform/sms/central', headers });
    expect(status.json()).toEqual({ configured: true, sender: '500012345', otpConfigured: true, otpBodyId: null, canEdit: false });
    const denied = await centralApp.inject({ method: 'POST', url: '/platform/sms/central/check', headers: { ...headers, host: 'admin.localhost:3000', origin: 'http://other.localhost:3000' } });
    expect(denied.statusCode).toBe(400);
    expect(centralCredit).not.toHaveBeenCalled();
    const checked = await centralApp.inject({ method: 'POST', url: '/platform/sms/central/check', headers: { ...headers, host: 'admin.localhost:3000', origin: 'http://admin.localhost:3000' } });
    expect(checked.json()).toEqual({ connected: true, credit: 12345 });
  });
  it('validates all package prices before saving them together', async () => {
    const requestHeaders = { ...headers, host: 'admin.localhost:3000', origin: 'http://admin.localhost:3000' };
    const invalid = await app.inject({ method: 'POST', url: '/platform/settings/prices/batch', headers: requestHeaders, payload: { practiceType: 'SOLO', prices: [{ durationMonths: 3, priceTomans: 100 }, { durationMonths: 6, priceTomans: -1 }] } });
    expect(invalid.statusCode).toBe(400);
    expect(query.mock.calls.filter(([sql]) => sql.join('?').includes('platform_set_practice_price'))).toHaveLength(0);
    const valid = await app.inject({ method: 'POST', url: '/platform/settings/prices/batch', headers: requestHeaders, payload: { practiceType: 'SOLO', prices: [{ durationMonths: 3, priceTomans: 100 }, { durationMonths: 6, priceTomans: 200 }] } });
    expect(valid.statusCode).toBe(200);
    expect(query.mock.calls.filter(([sql]) => sql.join('?').includes('platform_set_practice_price'))).toHaveLength(2);
  });
  it('protects annual price updates and validates their values', async () => {
    const noSession = await app.inject({ method: 'POST', url: '/platform/settings/prices', payload: { practiceType: 'SOLO', priceTomans: 100 } });
    expect(noSession.statusCode).toBe(401);
    const crossOrigin = await app.inject({ method: 'POST', url: '/platform/settings/prices', headers: { ...headers, host: 'admin.localhost:3000', origin: 'http://other.localhost:3000' }, payload: { practiceType: 'SOLO', priceTomans: 100 } });
    expect(crossOrigin.statusCode).toBe(400);
    const invalid = await app.inject({ method: 'POST', url: '/platform/settings/prices', headers: { ...headers, host: 'admin.localhost:3000', origin: 'http://admin.localhost:3000' }, payload: { practiceType: 'SOLO', priceTomans: -1 } });
    expect(invalid.statusCode).toBe(400);
    const invalidDuration = await app.inject({ method: 'POST', url: '/platform/settings/prices', headers: { ...headers, host: 'admin.localhost:3000', origin: 'http://admin.localhost:3000' }, payload: { practiceType: 'SOLO', durationMonths: 4, priceTomans: 100 } });
    expect(invalidDuration.statusCode).toBe(400);
    const valid = await app.inject({ method: 'POST', url: '/platform/settings/prices', headers: { ...headers, host: 'admin.localhost:3000', origin: 'http://admin.localhost:3000' }, payload: { practiceType: 'SOLO', durationMonths: 3, priceTomans: 25000000 } });
    expect(valid.statusCode).toBe(200);
    expect(query.mock.calls.some(([sql]) => sql.join('?').includes('platform_set_practice_price'))).toBe(true);
  });
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
