import { describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '@hmn/db';
import { createCentralSmsService } from './central-sms.js';

describe('central SMS settings', () => {
  it('uses the OTP pattern saved among templates, including when it is cleared', async () => {
    let otp: number | null = 777;
    const query = vi.fn((sql: TemplateStringsArray) => Promise.resolve(sql.join('?').includes('central_sms_templates') ? [{ body_id: otp }] : []));
    const service = createCentralSmsService({ $queryRaw: query } as unknown as PrismaClient, { key: Buffer.alloc(32, 3), keyVersion: 1 }, { panelRef: 'test-panel', sender: '50001234', otpBodyId: 99 });
    expect((await service.status()).otpBodyId).toBe(777);
    otp = null;
    expect((await service.status()).otpConfigured).toBe(false);
  });
  it('stores the panel key encrypted, reports only non-secret settings, and retains the key when editing', async () => {
    let row: Record<string, unknown> | undefined;
    const query = vi.fn((sql: TemplateStringsArray, ...values: unknown[]) => {
      if (sql.join('?').includes('central_sms_templates')) return Promise.resolve([]);
      if (sql.join('?').includes('platform_save_central_sms')) {
        row = { ciphertext: values[1], iv: values[2], auth_tag: values[3], key_version: values[4], sender: values[5], otp_body_id: values[6] };
        return Promise.resolve([]);
      }
      return Promise.resolve(row ? [row] : []);
    });
    const service = createCentralSmsService({ $queryRaw: query } as unknown as PrismaClient, { key: Buffer.alloc(32, 3), keyVersion: 1 });
    const secret = 'secret-panel-reference-for-test';
    await service.save('11111111-1111-4111-8111-111111111111', { panelRef: secret, sender: '50001234', otpBodyId: 123 });
    expect(Buffer.from(row!.ciphertext as Uint8Array).toString()).not.toContain(secret);
    expect(await service.status()).toEqual({ configured: true, sender: '50001234', otpConfigured: true, otpBodyId: 123, canEdit: true });
    await service.save('11111111-1111-4111-8111-111111111111', { sender: '50001235', otpBodyId: 456 });
    expect(await service.status()).toEqual({ configured: true, sender: '50001235', otpConfigured: true, otpBodyId: 456, canEdit: true });
  });
});
