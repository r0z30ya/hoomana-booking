import { randomBytes, randomUUID } from 'node:crypto';
import { withTenantTx, type PrismaClient } from '@hmn/db';
import { decryptSecret, encryptSecret, DependencyUnavailableError, ForbiddenError, NotFoundError, UnauthorizedError, ValidationError, type SecretEncryptionConfig } from '@hmn/shared';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { currentSession } from '../auth/session.js';
import type { SchedulingEngine } from './engine.js';

export interface SchedulingOptions { client: PrismaClient; engine?: SchedulingEngine; encryption?: SecretEncryptionConfig }
type Obj = Record<string, unknown>;
function object(value: unknown): Obj {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ValidationError('Invalid request');
  return value as Obj;
}
function str(value: unknown, max = 200): string {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > max) throw new ValidationError('Invalid field');
  return value.trim();
}
function int(value: unknown, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) throw new ValidationError('Invalid numeric field');
  return value;
}
function sameOrigin(request: FastifyRequest): void {
  const origin = request.headers.origin;
  try {
    const parsed = new URL(origin ?? '');
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.host !== request.headers.host) throw new Error();
  } catch { throw new ForbiddenError('A same-origin request is required'); }
}

export function schedulingRoutes(app: FastifyInstance, options: SchedulingOptions): void {
  const { client } = options;
  async function context(request: FastifyRequest, owner = false) {
    const session = await currentSession(client, request);
    if (!session) throw new UnauthorizedError();
    if (!session.activeTenantId) throw new ForbiddenError();
    const tenantId = session.activeTenantId;
    const [membership, subscription, tenant] = await Promise.all([
      withTenantTx(client, tenantId, (tx) => tx.tenantMembership.findUnique({ where: { tenantId_userId: { tenantId, userId: session.userId } }, select: { role: true } })),
      withTenantTx(client, tenantId, (tx) => tx.tenantSubscription.findFirst({ where: { tenantId }, orderBy: { createdAt: 'desc' }, select: { status: true, currentPeriodStart: true, currentPeriodEnd: true } })),
      client.tenant.findUnique({ where: { id: tenantId }, select: { practiceType: true } }),
    ]);
    if (!membership || (owner ? membership.role !== 'OWNER' : !['OWNER', 'RECEPTION'].includes(membership.role))) throw new ForbiddenError();
    const now = Date.now();
    if (!subscription || !['TRIALING', 'ACTIVE'].includes(subscription.status) || subscription.currentPeriodStart.getTime() > now || subscription.currentPeriodEnd.getTime() <= now) throw new ForbiddenError('Subscription is inactive or expired', { code: 'SUBSCRIPTION_EXPIRED' });
    if (!tenant || !['SOLO', 'CLINIC'].includes(tenant.practiceType)) throw new ForbiddenError();
    if (!options.engine || !options.encryption) throw new DependencyUnavailableError('Scheduling is not configured');
    return { tenantId, practiceType: tenant.practiceType, engine: options.engine, encryption: options.encryption };
  }
  async function doctor(tenantId: string, id: string, encryption: SecretEncryptionConfig) {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) throw new NotFoundError();
    const row = await withTenantTx(client, tenantId, (tx) => tx.schedulingDoctor.findFirst({ where: { id, tenantId } }));
    if (!row) throw new NotFoundError();
    if (row.keyVersion !== encryption.keyVersion) throw new DependencyUnavailableError('Scheduling key version is unavailable');
    const token = decryptSecret({ ciphertext: row.keyCiphertext, iv: row.keyIv, authTag: row.keyAuthTag }, `scheduling:${tenantId}:${id}`, encryption);
    return { row, token };
  }
  function doctorId(request: FastifyRequest) { return (request.params as { doctorId: string }).doctorId; }

  app.get('/tenant/scheduling/doctors', async (request) => {
    const ctx = await context(request);
    const rows = await withTenantTx(client, ctx.tenantId, (tx) => tx.schedulingDoctor.findMany({ where: { tenantId: ctx.tenantId }, select: { id: true, name: true, createdAt: true }, orderBy: { createdAt: 'asc' } }));
    return { doctors: rows, practiceType: ctx.practiceType };
  });
  app.post('/tenant/scheduling/doctors', async (request, reply) => {
    sameOrigin(request);
    const ctx = await context(request, true);
    const name = str(object(request.body).name);
    if (ctx.practiceType === 'SOLO') {
      const count = await withTenantTx(client, ctx.tenantId, (tx) => tx.schedulingDoctor.count({ where: { tenantId: ctx.tenantId } }));
      if (count > 0) throw new ForbiddenError('A practice is limited to one doctor', { code: 'PRACTICE_DOCTOR_LIMIT' });
    }
    const id = randomUUID();
    const username = `h${id.replaceAll('-', '')}`;
    // Internal engine identity only; never used as a patient email or contact channel.
    const account = await ctx.engine.request<{ user: { id: number }; accessToken: string }>('auth/signup', { method: 'POST', body: { username, name, email: `${username}@engine.invalid`, password: randomBytes(32).toString('base64url'), timeZone: 'Asia/Tehran' } });
    const key = await ctx.engine.request<{ key: string }>('api-keys', { method: 'POST', token: account.accessToken, body: { name: 'Hoomana server' } });
    const encrypted = encryptSecret(key.key, `scheduling:${ctx.tenantId}:${id}`, ctx.encryption);
    await withTenantTx(client, ctx.tenantId, async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${ctx.tenantId}, 0))`;
      if (ctx.practiceType === 'SOLO' && await tx.schedulingDoctor.count({ where: { tenantId: ctx.tenantId } }) > 0) throw new ForbiddenError('A practice is limited to one doctor', { code: 'PRACTICE_DOCTOR_LIMIT' });
      await tx.schedulingDoctor.create({ data: { id, tenantId: ctx.tenantId, name, engineUserId: account.user.id, keyCiphertext: Uint8Array.from(encrypted.ciphertext), keyIv: Uint8Array.from(encrypted.iv), keyAuthTag: Uint8Array.from(encrypted.authTag), keyVersion: encrypted.keyVersion } });
    });
    return reply.code(201).send({ doctor: { id, name } });
  });
  app.get('/tenant/scheduling/doctors/:doctorId', async (request) => {
    const ctx = await context(request);
    const d = await doctor(ctx.tenantId, doctorId(request), ctx.encryption);
    const [schedules, services] = await Promise.all([
      ctx.engine.request<{ schedules: unknown[] }>('schedules', { token: d.token }),
      ctx.engine.request<{ eventTypes: unknown[] }>('event-types', { token: d.token }),
    ]);
    return { doctor: { id: d.row.id, name: d.row.name }, schedules: schedules.schedules, services: services.eventTypes };
  });
  app.post('/tenant/scheduling/doctors/:doctorId/schedule', async (request) => {
    sameOrigin(request);
    const ctx = await context(request, true);
    const d = await doctor(ctx.tenantId, doctorId(request), ctx.encryption);
    const body = object(request.body);
    if (!Array.isArray(body.availability) || body.availability.length > 50) throw new ValidationError('Invalid availability');
    const availability = body.availability.map((item: unknown) => {
      const row = object(item);
      if (!Array.isArray(row.days) || !row.days.length) throw new ValidationError('Invalid weekdays');
      const days = row.days.map((day: unknown) => int(day, 0, 6));
      const startTime = str(row.startTime, 5), endTime = str(row.endTime, 5);
      if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(startTime) || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(endTime) || (endTime !== '00:00' && endTime <= startTime)) throw new ValidationError('Invalid working hours');
      return { days, startTime, endTime };
    });
    const existing = await ctx.engine.request<{ schedules: { id: number; isDefault: boolean }[] }>('schedules', { token: d.token });
    const current = existing.schedules.find((s) => s.isDefault);
    const payload = { name: 'Working hours', timeZone: 'Asia/Tehran', isDefault: true, availability };
    return ctx.engine.request(current ? `schedules/${current.id}` : 'schedules', { method: current ? 'PATCH' : 'POST', token: d.token, body: payload });
  });
  app.post('/tenant/scheduling/doctors/:doctorId/services', async (request, reply) => {
    sameOrigin(request);
    const ctx = await context(request, true);
    const d = await doctor(ctx.tenantId, doctorId(request), ctx.encryption);
    const body = object(request.body);
    const title = str(body.title, 120);
    const duration = int(body.duration, 5, 720);
    const interval = int(body.interval, 5, 720);
    const capacity = int(body.capacity, 1, 100);
    const service = await ctx.engine.request('event-types', { method: 'POST', token: d.token, body: { title, slug: `service-${randomBytes(8).toString('hex')}`, length: duration, slotInterval: interval, seatsPerTimeSlot: capacity, minimumBookingNotice: 0, timeZone: 'Asia/Tehran' } });
    return reply.code(201).send(service);
  });
  app.post('/tenant/scheduling/doctors/:doctorId/services/:serviceId', async (request) => {
    sameOrigin(request);
    const ctx = await context(request, true);
    const d = await doctor(ctx.tenantId, doctorId(request), ctx.encryption);
    const serviceId = Number((request.params as { serviceId: string }).serviceId);
    if (!Number.isSafeInteger(serviceId) || serviceId < 1) throw new ValidationError('Invalid service');
    const body = object(request.body);
    return ctx.engine.request(`event-types/${serviceId}`, { method: 'PATCH', token: d.token, body: {
      title: str(body.title, 120), length: int(body.duration, 5, 720), slotInterval: int(body.interval, 5, 720), seatsPerTimeSlot: int(body.capacity, 1, 100),
    } });
  });
  app.get('/tenant/scheduling/doctors/:doctorId/slots', async (request) => {
    const ctx = await context(request);
    const d = await doctor(ctx.tenantId, doctorId(request), ctx.encryption);
    const query = object(request.query);
    const serviceId = Number(query.serviceId);
    if (!Number.isSafeInteger(serviceId) || serviceId <= 0) throw new ValidationError('Invalid service');
    const start = str(query.start, 40), end = str(query.end, 40);
    const services = await ctx.engine.request<{ eventTypes: { id: number }[] }>('event-types', { token: d.token });
    if (!services.eventTypes.some((service) => service.id === serviceId)) throw new NotFoundError();
    const params = new URLSearchParams({ eventTypeId: String(serviceId), startTime: start, endTime: end, timeZone: 'Asia/Tehran' });
    return ctx.engine.request(`slots?${params.toString()}`, { token: d.token });
  });
  app.get('/tenant/scheduling/doctors/:doctorId/bookings', async (request) => {
    const ctx = await context(request);
    const d = await doctor(ctx.tenantId, doctorId(request), ctx.encryption);
    return ctx.engine.request('bookings?status=upcoming', { token: d.token });
  });
  app.post('/tenant/scheduling/doctors/:doctorId/bookings', async (request, reply) => {
    sameOrigin(request);
    const ctx = await context(request);
    const d = await doctor(ctx.tenantId, doctorId(request), ctx.encryption);
    const body = object(request.body);
    const eventTypeId = int(body.serviceId, 1, 2_147_483_647);
    const name = str(body.name, 80), mobile = str(body.mobile, 20), start = str(body.start, 40);
    if (!/^09\d{9}$/.test(mobile)) throw new ValidationError('Invalid mobile');
    const booking = await ctx.engine.request('bookings', { method: 'POST', token: d.token, body: { eventTypeId, start, attendee: { name, phone: mobile, timeZone: 'Asia/Tehran', language: 'fa' } } });
    return reply.code(201).send(booking);
  });
  app.post('/tenant/scheduling/doctors/:doctorId/bookings/:uid/cancel', async (request) => {
    sameOrigin(request);
    const ctx = await context(request);
    const d = await doctor(ctx.tenantId, doctorId(request), ctx.encryption);
    const uid = str((request.params as { uid: string }).uid, 100);
    if (!/^[a-zA-Z0-9_-]+$/.test(uid)) throw new ValidationError('Invalid booking');
    return ctx.engine.request(`bookings/${uid}/cancel`, { method: 'POST', token: d.token, body: {} });
  });
}
