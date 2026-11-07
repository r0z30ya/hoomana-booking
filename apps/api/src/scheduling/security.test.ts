import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import { encryptSecret, type SecretEncryptionConfig } from '@hmn/shared';
import type { PrismaClient } from '@hmn/db';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { schedulingRoutes } from './routes.js';
import { SchedulingEngine } from './engine.js';

const state = vi.hoisted(() => ({ tenant: '11111111-1111-4111-8111-111111111111', role: 'OWNER', loggedIn: true, expired: false, practiceType: 'CLINIC' }));
vi.mock('../auth/session.js', () => ({ currentSession: () => Promise.resolve(state.loggedIn ? { userId: 'user', activeTenantId: state.tenant } : undefined) }));
vi.mock('@hmn/db', () => ({ withTenantTx: (client: unknown, _tenant: string, fn: (client: unknown) => unknown) => Promise.resolve(fn(client)) }));
const tenantA = '11111111-1111-4111-8111-111111111111';
const tenantB = '22222222-2222-4222-8222-222222222222';
const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const encryption: SecretEncryptionConfig = { key: Buffer.alloc(32, 4), keyVersion: 1 };
const encrypted = encryptSecret('hnb_private_value', `scheduling:${tenantA}:${id}`, encryption);
const doctor = { id, tenantId: tenantA, name: 'A', engineUserId: 1, keyCiphertext: encrypted.ciphertext, keyIv: encrypted.iv, keyAuthTag: encrypted.authTag, keyVersion: 1, createdAt: new Date() };
const client = {
  tenant: { findUnique: () => Promise.resolve({ practiceType: state.practiceType }) },
  tenantMembership: { findUnique: () => Promise.resolve({ role: state.role }) },
  tenantSubscription: { findFirst: () => Promise.resolve({ status: 'TRIALING', currentPeriodStart: new Date(Date.now() - 86400000), currentPeriodEnd: new Date(Date.now() + (state.expired ? -1000 : 86400000)) }) },
  schedulingDoctor: {
    findFirst: ({ where }: { where: { id: string; tenantId: string } }) => Promise.resolve(where.id === id && where.tenantId === tenantA ? doctor : null),
    findMany: ({ where }: { where: { tenantId: string } }) => Promise.resolve(where.tenantId === tenantA ? [{ id, name: 'A', createdAt: doctor.createdAt }] : []),
    count: () => Promise.resolve(1),
  },
} as unknown as PrismaClient;
const send = vi.fn(() => Promise.resolve(Response.json({ data: { eventTypes: [], schedules: [] } })));
const server = Fastify();
await server.register(cookie);
await server.register(schedulingRoutes, { client, engine: new SchedulingEngine('http://localhost:3002/api/v2', send as typeof fetch), encryption });
afterEach(() => { state.tenant = tenantA; state.role = 'OWNER'; state.loggedIn = true; state.expired = false; state.practiceType = 'CLINIC'; send.mockClear(); });

describe('scheduling security boundary', () => {
  it('rejects expired trials before calling the engine', async () => {
    state.expired = true;
    expect((await server.inject({ method: 'GET', url: '/tenant/scheduling/doctors' })).statusCode).toBe(403);
    expect(send).not.toHaveBeenCalled();
  });
  it('rejects a second doctor for a practice before calling the engine', async () => {
    state.practiceType = 'SOLO';
    const r = await server.inject({ method: 'POST', url: '/tenant/scheduling/doctors', headers: { host: 'clinic.localhost:3000', origin: 'http://clinic.localhost:3000' }, payload: { name: 'Second' } });
    expect(r.statusCode).toBe(403);
    expect(send).not.toHaveBeenCalled();
  });
  it('requires an authenticated session', async () => {
    state.loggedIn = false;
    expect((await server.inject({ method: 'GET', url: '/tenant/scheduling/doctors' })).statusCode).toBe(401);
    expect(send).not.toHaveBeenCalled();
  });
  it('does not disclose another clinic doctor or call the engine', async () => {
    state.tenant = tenantB;
    expect((await server.inject({ method: 'GET', url: `/tenant/scheduling/doctors/${id}` })).statusCode).toBe(404);
    expect(send).not.toHaveBeenCalled();
  });
  it('rejects a cross-origin mutation even for an owner', async () => {
    const r = await server.inject({ method: 'POST', url: '/tenant/scheduling/doctors', headers: { host: 'clinic.localhost:3000', origin: 'http://other.localhost:3000' }, payload: { name: 'Test' } });
    expect(r.statusCode).toBe(403);
    expect(send).not.toHaveBeenCalled();
  });
  it('does not allow reception to change services', async () => {
    state.role = 'RECEPTION';
    const r = await server.inject({ method: 'POST', url: `/tenant/scheduling/doctors/${id}/services`, headers: { host: 'clinic.localhost:3000', origin: 'http://clinic.localhost:3000' }, payload: { title: 'Test', duration: 30, interval: 30, capacity: 1 } });
    expect(r.statusCode).toBe(403);
    expect(send).not.toHaveBeenCalled();
  });
  it('keeps engine credentials server-side', async () => {
    const r = await server.inject({ method: 'GET', url: `/tenant/scheduling/doctors/${id}` });
    expect(r.statusCode).toBe(200);
    expect(r.body).not.toContain('hnb_private_value');
    expect(send).toHaveBeenCalledTimes(2);
  });
  it('rejects public plaintext engine endpoints and URL traversal', async () => {
    expect(() => new SchedulingEngine('http://example.com/api/v2')).toThrow();
    const engine = new SchedulingEngine('http://localhost:3002/api/v2', send);
    await expect(engine.request('../auth')).rejects.toThrow();
    expect(send).not.toHaveBeenCalled();
  });
});
