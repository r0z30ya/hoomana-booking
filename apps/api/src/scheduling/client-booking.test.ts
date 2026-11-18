import Fastify from 'fastify';
import { encryptSecret, type SecretEncryptionConfig } from '@hmn/shared';
import type { PrismaClient } from '@hmn/db';
import { expect, it, vi } from 'vitest';
import { schedulingRoutes } from './routes.js';
import { SchedulingEngine } from './engine.js';
const tenantId = '11111111-1111-4111-8111-111111111111'; const doctorId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
vi.mock('../auth/session.js', () => ({ currentSession: () => Promise.resolve({ userId: 'user', activeTenantId: '11111111-1111-4111-8111-111111111111' }) }));
vi.mock('@hmn/db', () => ({ withTenantTx: (client: unknown, _tenant: string, fn: (client: unknown) => unknown) => Promise.resolve(fn(client)) }));
it('creates a client and link for every new booking and does not duplicate a retry', async () => {
 const enc: SecretEncryptionConfig = { key: Buffer.alloc(32, 4), keyVersion: 1 }; const encrypted = encryptSecret('hnb_key', `scheduling:${tenantId}:${doctorId}`, enc);
 const doctor = { id: doctorId, tenantId, name: 'Doctor', engineHostId: 'host', keyCiphertext: encrypted.ciphertext, keyIv: encrypted.iv, keyAuthTag: encrypted.authTag, keyVersion: 1 };
 const clients: Array<{ id: string; mobile: string; firstName: string; lastName: string }> = []; const links: Array<{ tenantId: string; clientId: string; doctorId: string; bookingUid: string }> = [];
 const client = { tenant: { findUnique: () => Promise.resolve({ name: 'Clinic', practiceType: 'CLINIC' }) }, tenantMembership: { findUnique: () => Promise.resolve({ role: 'OWNER' }) }, tenantSubscription: { findFirst: () => Promise.resolve({ status: 'ACTIVE', currentPeriodStart: new Date(Date.now()-10000), currentPeriodEnd: new Date(Date.now()+86400000) }) }, schedulingDoctor: { findFirst: () => Promise.resolve(doctor) }, doctorServiceAssignment: { findFirst: () => Promise.resolve(null) }, $executeRaw: () => Promise.resolve(1),
 clientRecord: { findMany: ({ where }: { where: { mobile: string; firstName: string; lastName: string } }) => Promise.resolve(clients.filter((x) => x.mobile === where.mobile && x.firstName === where.firstName && x.lastName === where.lastName)), create: ({ data }: { data: typeof clients[number] }) => { clients.push(data); return Promise.resolve(data); } },
 clientBookingLink: { findUnique: () => Promise.resolve(links[0] ?? null), create: ({ data }: { data: typeof links[number] }) => { links.push(data); return Promise.resolve(data); } } } as unknown as PrismaClient;
 const send = vi.fn((url: URL) => Promise.resolve(Response.json(url.pathname.includes('/event-types/') ? { id: 'service', hostId: 'host' } : { uid: 'booking1', startsAt: '2026-11-20T10:00:00Z', status: 'CONFIRMED', host: { id: 'host' }, eventType: { id: 'service', title: 'Visit' }, attendee: { name: 'Test Person', phone: '09000001234' } })));
 const server = Fastify(); await server.register(schedulingRoutes, { client, engine: new SchedulingEngine('http://localhost:3002/api/v2', send as typeof fetch), encryption: enc });
 const request = { method: 'POST' as const, url: `/tenant/scheduling/doctors/${doctorId}/bookings`, headers: { host: 'clinic.localhost:3000', origin: 'http://clinic.localhost:3000', 'idempotency-key': 'booking-test-key' }, payload: { serviceId: 'service', name: 'Test Person', firstName: 'Test', lastName: 'Person', mobile: '09000001234', start: '2026-11-20T10:00:00Z' } };
 expect((await server.inject(request)).statusCode).toBe(201); expect((await server.inject(request)).statusCode).toBe(201); expect(clients).toHaveLength(1); expect(links).toHaveLength(1); expect(links[0]?.clientId).toBe(clients[0]?.id); await server.close();
});
