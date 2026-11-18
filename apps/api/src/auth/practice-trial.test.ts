import type { PrismaClient } from '@hmn/db';
import { describe, expect, it, vi } from 'vitest';
import { registerTenant } from './auth-service.js';

vi.mock('@hmn/db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@hmn/db')>()),
  withTenantTx: async (_client: unknown, _tenantId: string, callback: (tx: unknown) => Promise<unknown>) => callback({
    tenantMembership: { create: vi.fn().mockResolvedValue({}) },
    tenantSubscription: { create: subscriptionCreate },
  }),
}));
const subscriptionCreate = vi.fn().mockResolvedValue({});

describe('practice trial durations', () => {
  it.each([['SOLO', 7], ['CLINIC', 21]] as const)('uses the configured %s trial for new accounts', async (practiceType, days) => {
    const client = {
      platformSetting: { findUnique: vi.fn().mockResolvedValue({ soloTrialDays: 7, clinicTrialDays: 21 }) },
      user: { create: vi.fn().mockResolvedValue({ id: 'user' }) },
      tenant: { create: vi.fn().mockResolvedValue({ id: 'tenant' }) },
      subscriptionPlan: { findUnique: vi.fn().mockResolvedValue({ id: 'free' }) },
    } as unknown as PrismaClient;
    subscriptionCreate.mockClear();
    const now = new Date('2026-01-01T00:00:00Z');
    await registerTenant(client, { mobile: '09120000000', displayName: 'Owner', tenantName: 'Practice', practiceType, now });
    expect(subscriptionCreate).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ currentPeriodEnd: new Date(now.getTime() + days * 86400000) }) }));
  });
});
