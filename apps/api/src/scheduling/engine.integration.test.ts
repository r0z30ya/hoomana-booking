import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import type { PrismaClient } from '@hmn/db';
import { describe, expect, it, vi } from 'vitest';
import { SchedulingEngine } from './engine.js';
import { schedulingRoutes } from './routes.js';

const tenant = '11111111-1111-4111-8111-111111111111';
vi.mock('../auth/session.js', () => ({ currentSession: () => Promise.resolve({ userId: 'user', activeTenantId: '11111111-1111-4111-8111-111111111111' }) }));
vi.mock('@hmn/db', () => ({ withTenantTx: (client: unknown, _tenant: string, fn: (client: unknown) => unknown) => Promise.resolve(fn(client)) }));

// Explicit opt-in: this test creates users and bookings in the engine database.
describe.skipIf(process.env.HNOBAT_ISOLATED_INTEGRATION !== 'yes')('Hoomana to isolated hnobat engine', () => {
  it('creates a doctor, schedule, service, slot, booking and cancellation', async () => {
    let stored: Record<string, unknown> | null = null;
    const client = {
      tenant: { findUnique: () => Promise.resolve({ practiceType: 'CLINIC' }) },
      tenantMembership: { findUnique: () => Promise.resolve({ role: 'OWNER' }) },
      tenantSubscription: { findFirst: () => Promise.resolve({ status: 'TRIALING', currentPeriodStart: new Date(Date.now() - 1000), currentPeriodEnd: new Date(Date.now() + 86400000) }) },
      $executeRaw: () => Promise.resolve(1),
      schedulingDoctor: {
        create: ({ data }: { data: Record<string, unknown> }) => { stored = { ...data, createdAt: new Date() }; return Promise.resolve(stored); },
        findFirst: ({ where }: { where: { id: string; tenantId: string } }) => Promise.resolve(stored && stored.id === where.id && where.tenantId === tenant ? stored : null),
      },
    } as unknown as PrismaClient;
    const server = Fastify();
    await server.register(cookie);
    await server.register(schedulingRoutes, { client, engine: new SchedulingEngine('http://127.0.0.1:33971/api/v2'), encryption: { key: Buffer.alloc(32, 7), keyVersion: 1 } });
    const headers = { origin: 'http://localhost:3000', host: 'localhost:3000' };
    const doctor = await server.inject({ method: 'POST', url: '/tenant/scheduling/doctors', headers, payload: { name: 'Test doctor' } });
    expect(doctor.statusCode, doctor.body).toBe(201);
    const id = doctor.json<{ doctor: { id: string } }>().doctor.id;
    const schedule = await server.inject({ method: 'POST', url: `/tenant/scheduling/doctors/${id}/schedule`, headers, payload: { availability: [{ days: [0, 1, 2, 3, 4, 5, 6], startTime: '09:00', endTime: '17:00' }] } });
    expect(schedule.statusCode, schedule.body).toBe(200);
    const service = await server.inject({ method: 'POST', url: `/tenant/scheduling/doctors/${id}/services`, headers, payload: { title: 'Consultation', duration: 30, interval: 30, capacity: 2 } });
    expect(service.statusCode, service.body).toBe(201);
    const serviceId = service.json<{ eventType: { id: number } }>().eventType.id;
    const date = new Date(); date.setUTCDate(date.getUTCDate() + 3); date.setUTCHours(0, 0, 0, 0);
    const params = new URLSearchParams({ serviceId: String(serviceId), start: date.toISOString(), end: new Date(date.getTime() + 86_400_000).toISOString() });
    const slots = await server.inject({ method: 'GET', url: `/tenant/scheduling/doctors/${id}/slots?${params.toString()}` });
    expect(slots.statusCode, slots.body).toBe(200);
    const all = Object.values(slots.json<{ slots: Record<string, { utc: string }[]> }>().slots).flat();
    expect(all.length).toBeGreaterThan(0);
    const booking = await server.inject({ method: 'POST', url: `/tenant/scheduling/doctors/${id}/bookings`, headers, payload: { serviceId, start: all[0]?.utc, name: 'Test patient', mobile: '09120000000' } });
    expect(booking.statusCode, booking.body).toBe(201);
    expect(booking.json<{ booking: { attendees: { email: string | null; phone: string }[] } }>().booking.attendees[0]).toMatchObject({ email: null, phone: '09120000000' });
    const uid = booking.json<{ booking: { uid: string } }>().booking.uid;
    const cancel = await server.inject({ method: 'POST', url: `/tenant/scheduling/doctors/${id}/bookings/${uid}/cancel`, headers, payload: {} });
    expect(cancel.statusCode, cancel.body).toBe(200);
    expect(cancel.json<{ booking: { status: string } }>().booking.status).toBe('CANCELLED');
    await server.close();
  });
});
