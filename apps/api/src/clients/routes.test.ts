import Fastify from 'fastify';
import type { PrismaClient } from '@hmn/db';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { clientRoutes } from './routes.js';
const state = vi.hoisted(() => ({ tenant: '11111111-1111-4111-8111-111111111111', role: 'OWNER', loggedIn: true }));
vi.mock('../auth/session.js', () => ({ currentSession: () => Promise.resolve(state.loggedIn ? { userId: 'user', activeTenantId: state.tenant } : undefined) }));
vi.mock('@hmn/db', () => ({ withTenantTx: (client: unknown, _tenant: string, fn: (client: unknown) => unknown) => Promise.resolve(fn(client)) }));
const clinic = '11111111-1111-4111-8111-111111111111'; const clientId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const records = [{ id: clientId, tenantId: clinic, mobile: '09120000000' }]; const payments: Record<string, unknown>[] = [];
const client = { tenantMembership: { findUnique: () => Promise.resolve({ role: state.role }) }, clientRecord: {
 findMany: ({ where }: { where: { tenantId: string } }) => Promise.resolve(records.filter((r) => r.tenantId === where.tenantId)),
 findFirst: ({ where }: { where: { tenantId: string; id: string } }) => Promise.resolve(records.find((r) => r.tenantId === where.tenantId && r.id === where.id) ?? null),
 create: ({ data }: { data: unknown }) => Promise.resolve(data),
}, clientPayment: { findFirst: ({ where }: { where: { tenantId: string; id: string } }) => Promise.resolve(payments.find((p) => p.tenantId === where.tenantId && p.id === where.id) ?? null), create: ({ data }: { data: Record<string, unknown> }) => { payments.push(data); return Promise.resolve(data); }, findMany: () => Promise.resolve(payments) } } as unknown as PrismaClient;
const server = Fastify(); await server.register(clientRoutes, { client });
const headers = { host: 'clinic.localhost:3000', origin: 'http://clinic.localhost:3000' };
afterEach(() => { state.tenant = clinic; state.role = 'OWNER'; state.loggedIn = true; payments.length = 0; });
describe('client records', () => {
 it('enforces tenant isolation and role access', async () => { state.tenant = '22222222-2222-4222-8222-222222222222'; const list = await server.inject({ method: 'GET', url: '/tenant/clients' }); expect(list.json<{ clients: unknown[] }>().clients).toHaveLength(0); const p = await server.inject({ method: 'GET', url: '/tenant/clients/' + clientId + '/payments' }); expect(p.statusCode).toBe(404); state.role = 'DOCTOR'; expect((await server.inject({ method: 'GET', url: '/tenant/clients' })).statusCode).toBe(403); });
 it('blocks cross-origin mutations and validates mobile', async () => { const payload = { firstName: 'A', lastName: 'B', mobile: '123' }; expect((await server.inject({ method: 'POST', url: '/tenant/clients', headers: { ...headers, origin: 'http://other.localhost:3000' }, payload })).statusCode).toBe(403); expect((await server.inject({ method: 'POST', url: '/tenant/clients', headers, payload })).statusCode).toBe(400); });
 it('records a payment once on retries and rejects mismatched reuse', async () => { const h = { ...headers, 'idempotency-key': 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' }; const payload = { amountTomans: 100000, method: 'CARD', note: '' }; const url = '/tenant/clients/' + clientId + '/payments'; expect((await server.inject({ method: 'POST', url, headers: h, payload })).statusCode).toBe(201); expect((await server.inject({ method: 'POST', url, headers: h, payload })).statusCode).toBe(201); expect(payments).toHaveLength(1); expect((await server.inject({ method: 'POST', url, headers: h, payload: { ...payload, amountTomans: 200000 } })).statusCode).toBe(409); });
});
