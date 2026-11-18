import { randomBytes, randomUUID } from 'node:crypto';
import { withTenantTx, type PrismaClient } from '@hmn/db';
import { decryptSecret, encryptSecret, ConflictError, DependencyUnavailableError, ForbiddenError, NotFoundError, UnauthorizedError, ValidationError, type SecretEncryptionConfig } from '@hmn/shared';
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
      client.tenant.findUnique({ where: { id: tenantId }, select: { name: true, practiceType: true } }),
    ]);
    if (!membership || (owner ? membership.role !== 'OWNER' : !['OWNER', 'RECEPTION'].includes(membership.role))) throw new ForbiddenError();
    const now = Date.now();
    if (!subscription || !['TRIALING', 'ACTIVE'].includes(subscription.status) || subscription.currentPeriodStart.getTime() > now || subscription.currentPeriodEnd.getTime() <= now) throw new ForbiddenError('Subscription is inactive or expired', { code: 'SUBSCRIPTION_EXPIRED' });
    if (!tenant || !['SOLO', 'CLINIC'].includes(tenant.practiceType)) throw new ForbiddenError();
    if (!options.engine || !options.encryption) throw new DependencyUnavailableError('Scheduling is not configured');
    return { tenantId, tenantName: tenant.name, practiceType: tenant.practiceType, engine: options.engine, encryption: options.encryption };
  }
  async function doctor(tenantId: string, id: string, encryption: SecretEncryptionConfig) {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) throw new NotFoundError();
    const row = await withTenantTx(client, tenantId, (tx) => tx.schedulingDoctor.findFirst({ where: { id, tenantId } }));
    if (!row) throw new NotFoundError();
    if (!row.engineHostId) throw new DependencyUnavailableError('Legacy scheduling data needs migration');
    if (row.keyVersion !== encryption.keyVersion) throw new DependencyUnavailableError('Scheduling key version is unavailable');
    const token = decryptSecret({ ciphertext: row.keyCiphertext, iv: row.keyIv, authTag: row.keyAuthTag }, `scheduling:${tenantId}:${id}`, encryption);
    return { row, token, hostId: row.engineHostId };
  }
  function doctorId(request: FastifyRequest) { return (request.params as { doctorId: string }).doctorId; }
  type Service = { id: string; hostId: string | null; title: string; durationMin: number; slotIntervalMin: number; capacity: number };
  type Booking = { uid: string; status: string; startsAt: string; host: { id: string }; eventType: { id: string; title: string }; attendee?: { name: string; phone: string } };
  async function services(engine: SchedulingEngine, token: string, hostId: string): Promise<Service[]> {
    const items: Service[] = [];
    let cursor: string | null = null;
    do {
      const params = new URLSearchParams({ hostId, limit: '100', ...(cursor ? { cursor } : {}) });
      const page: { items: Service[]; nextCursor: string | null } = await engine.request(`event-types?${params.toString()}`, { token });
      items.push(...page.items);
      cursor = page.nextCursor;
    } while (cursor);
    return items;
  }
  async function ownService(engine: SchedulingEngine, token: string, hostId: string, id: string): Promise<Service> {
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(id)) throw new ValidationError('Invalid service');
    const service = await engine.request<Service>(`event-types/${id}`, { token });
    if (service.hostId !== hostId) throw new NotFoundError();
    return service;
  }
  async function assignedService(tenantId: string, doctorId: string, engineServiceId: string) {
    return withTenantTx(client, tenantId, (tx) => tx.doctorServiceAssignment.findFirst({ where: { tenantId, doctorId, engineServiceId } }));
  }
  async function requireActiveService(tenantId: string, doctorId: string, engineServiceId: string) {
    const assignment = await assignedService(tenantId, doctorId, engineServiceId);
    if (assignment && !assignment.active) throw new NotFoundError();
  }
  function serviceView(service: Service) { return { id: service.id, title: service.title, length: service.durationMin, slotInterval: service.slotIntervalMin, seatsPerTimeSlot: service.capacity }; }
  function bookingView(booking: Booking) { return { uid: booking.uid, serviceId: booking.eventType.id, title: booking.eventType.title, start: booking.startsAt, status: booking.status, patientName: booking.attendee?.name ?? '', mobile: booking.attendee?.phone ?? '' }; }
  function operationKey(request: FastifyRequest) {
    const key = request.headers['idempotency-key'];
    if (key === undefined) return randomUUID();
    if (typeof key !== 'string' || !/^[a-zA-Z0-9_-]{8,128}$/.test(key)) throw new ValidationError('Invalid idempotency key');
    return key;
  }

  function catalogInput(value: unknown) {
    const body = object(value);
    const totalTomans = int(body.totalTomans, 0, 2_000_000_000);
    const depositTomans = body.depositTomans === null || body.depositTomans === undefined ? null : int(body.depositTomans, 0, totalTomans);
    return { title: str(body.title, 120), duration: int(body.duration, 5, 480), interval: int(body.interval, 5, 480), capacity: int(body.capacity, 1, 100), totalTomans, depositTomans };
  }
  app.get('/tenant/scheduling/catalog', async (request) => {
    const ctx = await context(request);
    return { services: await withTenantTx(client, ctx.tenantId, (tx) => tx.clinicService.findMany({ where: { tenantId: ctx.tenantId }, orderBy: { createdAt: 'asc' } })) };
  });
  app.post('/tenant/scheduling/catalog', async (request, reply) => {
    sameOrigin(request); const ctx = await context(request, true); const data = catalogInput(request.body);
    const service = await withTenantTx(client, ctx.tenantId, (tx) => tx.clinicService.create({ data: { ...data, id: randomUUID(), tenantId: ctx.tenantId } }));
    return reply.code(201).send({ service });
  });
  app.post('/tenant/scheduling/catalog/:serviceId', async (request) => {
    sameOrigin(request); const ctx = await context(request, true); const id = (request.params as { serviceId: string }).serviceId; const data = catalogInput(request.body);
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw new NotFoundError();
    const found = await withTenantTx(client, ctx.tenantId, (tx) => tx.clinicService.findFirst({ where: { id, tenantId: ctx.tenantId } }));
    if (!found) throw new NotFoundError();
    const assignments = await withTenantTx(client, ctx.tenantId, (tx) => tx.doctorServiceAssignment.findMany({ where: { tenantId: ctx.tenantId, clinicServiceId: id } }));
    for (const assignment of assignments) {
      const d = await doctor(ctx.tenantId, assignment.doctorId, ctx.encryption);
      await ownService(ctx.engine, d.token, d.hostId, assignment.engineServiceId);
      await ctx.engine.request('event-types/' + assignment.engineServiceId, { method: 'PATCH', token: d.token, body: { title: data.title, durationMin: data.duration, slotIntervalMin: data.interval, capacity: data.capacity } });
    }
    const service = await withTenantTx(client, ctx.tenantId, (tx) => tx.clinicService.update({ where: { id }, data }));
    return { service };
  });
  app.get('/tenant/scheduling/doctors/:doctorId/catalog', async (request) => {
    const ctx = await context(request); const id = doctorId(request); await doctor(ctx.tenantId, id, ctx.encryption);
    return { assignments: await withTenantTx(client, ctx.tenantId, (tx) => tx.doctorServiceAssignment.findMany({ where: { tenantId: ctx.tenantId, doctorId: id } })) };
  });
  app.post('/tenant/scheduling/doctors/:doctorId/catalog/:serviceId', async (request) => {
    sameOrigin(request); const ctx = await context(request, true); const doctorKey = doctorId(request); const d = await doctor(ctx.tenantId, doctorKey, ctx.encryption);
    const id = (request.params as { serviceId: string }).serviceId; if (!/^[0-9a-f-]{36}$/i.test(id)) throw new NotFoundError();
    const active = object(request.body).active; if (typeof active !== 'boolean') throw new ValidationError('Invalid assignment');
    return withTenantTx(client, ctx.tenantId, async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${ctx.tenantId + doctorKey + id}, 0))`;
      const service = await tx.clinicService.findFirst({ where: { id, tenantId: ctx.tenantId } }); if (!service) throw new NotFoundError();
      const existing = await tx.doctorServiceAssignment.findUnique({ where: { doctorId_clinicServiceId: { doctorId: doctorKey, clinicServiceId: id } } });
      if (existing) return { assignment: await tx.doctorServiceAssignment.update({ where: { doctorId_clinicServiceId: { doctorId: doctorKey, clinicServiceId: id } }, data: { active } }) };
      if (!active) return { assignment: null };
      const event = await ctx.engine.request<Service>('event-types', { method: 'POST', token: d.token, body: { title: service.title, slug: 'service-' + randomBytes(8).toString('hex'), hostId: d.hostId, durationMin: service.duration, slotIntervalMin: service.interval, capacity: service.capacity } });
      return { assignment: await tx.doctorServiceAssignment.create({ data: { tenantId: ctx.tenantId, doctorId: doctorKey, clinicServiceId: id, engineServiceId: event.id, active: true } }) };
    }, { timeout: 20_000, maxWait: 10_000 });
  });

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
    await withTenantTx(client, ctx.tenantId, async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${ctx.tenantId}, 0))`;
      if (ctx.practiceType === 'SOLO' && await tx.schedulingDoctor.count({ where: { tenantId: ctx.tenantId } }) > 0) throw new ForbiddenError('A practice is limited to one doctor', { code: 'PRACTICE_DOCTOR_LIMIT' });
      const previous = await tx.schedulingDoctor.findFirst({ where: { tenantId: ctx.tenantId }, orderBy: { createdAt: 'asc' } });
      let token: string;
      let hostId: string;
      if (previous) {
        if (!previous.engineHostId || previous.keyVersion !== ctx.encryption.keyVersion) throw new DependencyUnavailableError('Legacy scheduling data needs migration');
        token = decryptSecret({ ciphertext: previous.keyCiphertext, iv: previous.keyIv, authTag: previous.keyAuthTag }, `scheduling:${ctx.tenantId}:${previous.id}`, ctx.encryption);
        const host = await ctx.engine.request<{ id: string }>('users', { method: 'POST', token, body: { name, timezone: 'Asia/Tehran', externalId: id } });
        hostId = host.id;
      } else {
        const created = await ctx.engine.request<{ owner: { id: string }; apiKey: { key: string } }>('tenants', { method: 'POST', setup: true, body: { name: ctx.tenantName, slug: `hmn-${randomBytes(16).toString('hex')}`, timezone: 'Asia/Tehran', owner: { name } } });
        token = created.apiKey.key;
        hostId = created.owner.id;
      }
      const encrypted = encryptSecret(token, `scheduling:${ctx.tenantId}:${id}`, ctx.encryption);
      await tx.schedulingDoctor.create({ data: { id, tenantId: ctx.tenantId, name, engineUserId: 0, engineHostId: hostId, keyCiphertext: Uint8Array.from(encrypted.ciphertext), keyIv: Uint8Array.from(encrypted.iv), keyAuthTag: Uint8Array.from(encrypted.authTag), keyVersion: encrypted.keyVersion } });
    }, { timeout: 20_000, maxWait: 10_000 });
    return reply.code(201).send({ doctor: { id, name } });
  });
  app.get('/tenant/scheduling/doctors/:doctorId', async (request) => {
    const ctx = await context(request);
    const d = await doctor(ctx.tenantId, doctorId(request), ctx.encryption);
    const [availability, eventTypes] = await Promise.all([
      ctx.engine.request<{ weekly: { weekday: number; windows: { start: string; end: string }[] }[] }>(`users/${d.hostId}/availability`, { token: d.token }),
      services(ctx.engine, d.token, d.hostId),
    ]);
    const windows = new Map<string, { days: number[]; startTime: string; endTime: string }>();
    for (const day of availability.weekly) for (const window of day.windows) {
      const key = `${window.start}-${window.end}`;
      const item = windows.get(key) ?? { days: [], startTime: `1970-01-01T${window.start}:00.000Z`, endTime: `1970-01-01T${window.end}:00.000Z` };
      item.days.push(day.weekday); windows.set(key, item);
    }
    const assignments = await withTenantTx(client, ctx.tenantId, (tx) => tx.doctorServiceAssignment.findMany({ where: { tenantId: ctx.tenantId, doctorId: d.row.id } }));
    const inactive = new Set(assignments.filter((assignment) => !assignment.active).map((assignment) => assignment.engineServiceId));
    return { doctor: { id: d.row.id, name: d.row.name }, schedules: [{ isDefault: true, availability: [...windows.values()] }], services: eventTypes.filter((event) => !inactive.has(event.id)).map(serviceView) };
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
      if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(startTime) || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(endTime) || endTime <= startTime) throw new ValidationError('Invalid working hours');
      return { days, startTime, endTime };
    });
    const weekly = Array.from({ length: 7 }, (_, weekday) => ({ weekday, windows: availability.filter((row) => row.days.includes(weekday)).map((row) => ({ start: row.startTime, end: row.endTime })) })).filter((day) => day.windows.length);
    return ctx.engine.request(`users/${d.hostId}/availability`, { method: 'PUT', token: d.token, body: { weekly } });
  });
  app.post('/tenant/scheduling/doctors/:doctorId/services', async (request, reply) => {
    sameOrigin(request);
    const ctx = await context(request, true);
    const d = await doctor(ctx.tenantId, doctorId(request), ctx.encryption);
    const body = object(request.body);
    const title = str(body.title, 120);
    const duration = int(body.duration, 5, 480);
    const interval = int(body.interval, 5, 480);
    const capacity = int(body.capacity, 1, 100);
    const service = await ctx.engine.request<Service>('event-types', { method: 'POST', token: d.token, body: { title, slug: `service-${randomBytes(8).toString('hex')}`, hostId: d.hostId, durationMin: duration, slotIntervalMin: interval, capacity } });
    return reply.code(201).send({ eventType: serviceView(service) });
  });
  app.post('/tenant/scheduling/doctors/:doctorId/services/:serviceId', async (request) => {
    sameOrigin(request);
    const ctx = await context(request, true);
    const d = await doctor(ctx.tenantId, doctorId(request), ctx.encryption);
    const serviceId = (request.params as { serviceId: string }).serviceId;
    if (await assignedService(ctx.tenantId, d.row.id, serviceId)) throw new ValidationError('Edit shared services in the catalog');
    await ownService(ctx.engine, d.token, d.hostId, serviceId);
    const body = object(request.body);
    const updated = await ctx.engine.request<Service>(`event-types/${serviceId}`, { method: 'PATCH', token: d.token, body: {
      title: str(body.title, 120), durationMin: int(body.duration, 5, 480), slotIntervalMin: int(body.interval, 5, 480), capacity: int(body.capacity, 1, 100),
    } });
    return { eventType: serviceView(updated) };
  });
  app.get('/tenant/scheduling/doctors/:doctorId/slots', async (request) => {
    const ctx = await context(request);
    const d = await doctor(ctx.tenantId, doctorId(request), ctx.encryption);
    const query = object(request.query);
    const serviceId = str(query.serviceId, 64);
    const start = str(query.start, 40), end = str(query.end, 40);
    await requireActiveService(ctx.tenantId, d.row.id, serviceId);
    await ownService(ctx.engine, d.token, d.hostId, serviceId);
    const params = new URLSearchParams({ eventTypeId: serviceId, from: start, to: end, timezone: 'Asia/Tehran' });
    const result = await ctx.engine.request<{ slots: { startsAt: string; seatsRemaining: number }[] }>(`slots?${params.toString()}`, { token: d.token });
    return { slots: { available: result.slots.map((slot) => ({ utc: slot.startsAt, time: new Date(slot.startsAt).toLocaleTimeString('en-GB', { timeZone: 'Asia/Tehran', hour: '2-digit', minute: '2-digit' }), seatsLeft: slot.seatsRemaining })) } };
  });
  app.get('/tenant/scheduling/doctors/:doctorId/bookings', async (request) => {
    const ctx = await context(request);
    const d = await doctor(ctx.tenantId, doctorId(request), ctx.encryption);
    const query = object(request.query);
    let from = new Date().toISOString();
    let to: string | undefined;
    if (query.start !== undefined || query.end !== undefined) {
      const start = new Date(str(query.start, 40));
      const end = new Date(str(query.end, 40));
      if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime()) || end <= start || end.getTime() - start.getTime() > 31 * 86400000) throw new ValidationError('Invalid booking date range');
      from = start.toISOString();
      to = end.toISOString();
    }
    const bookings: Booking[] = [];
    let cursor: string | null = null;
    do {
      const params = new URLSearchParams({ hostId: d.hostId, from, ...(to ? { to } : {}), limit: '100', ...(cursor ? { cursor } : {}) });
      const page: { items: Booking[]; nextCursor: string | null } = await ctx.engine.request(`bookings?${params.toString()}`, { token: d.token });
      bookings.push(...page.items);
      cursor = page.nextCursor;
    } while (cursor);
    return { bookings: bookings.map(bookingView) };
  });
  app.get('/tenant/scheduling/clients/:clientId/bookings', async (request) => {
    const ctx = await context(request); const clientId = (request.params as { clientId: string }).clientId;
    if (!/^[0-9a-f-]{36}$/i.test(clientId)) throw new NotFoundError();
    const clientRecord = await withTenantTx(client, ctx.tenantId, (tx) => tx.clientRecord.findFirst({ where: { id: clientId, tenantId: ctx.tenantId } }));
    if (!clientRecord) throw new NotFoundError();
    const links = await withTenantTx(client, ctx.tenantId, (tx) => tx.clientBookingLink.findMany({ where: { tenantId: ctx.tenantId, clientId } }));
    const records = await Promise.all(links.map(async (link) => { const d = await doctor(ctx.tenantId, link.doctorId, ctx.encryption); const booking = await ctx.engine.request<Booking>(`bookings/${link.bookingUid}`, { token: d.token }); if (booking.host.id !== d.hostId) throw new NotFoundError(); return { ...bookingView(booking), doctorName: d.row.name }; }));
    return { bookings: records.sort((a, b) => b.start.localeCompare(a.start)) };
  });
  app.post('/tenant/scheduling/doctors/:doctorId/bookings', async (request, reply) => {
    sameOrigin(request);
    const ctx = await context(request);
    const d = await doctor(ctx.tenantId, doctorId(request), ctx.encryption);
    const body = object(request.body);
    const eventTypeId = str(body.serviceId, 64);
    const name = str(body.name, 80), mobile = str(body.mobile, 20), start = str(body.start, 40);
    if (!/^09\d{9}$/.test(mobile)) throw new ValidationError('Invalid mobile');
    const words = name.split(/\s+/); const fallbackFirst = words.shift() ?? name; const fallbackLast = words.join(' ');
    const firstName = body.firstName === undefined ? fallbackFirst : str(body.firstName, 80);
    const lastName = body.lastName === undefined ? fallbackLast : str(body.lastName, 80);
    let clientId: string | undefined;
    if (body.clientId !== undefined) {
      const selectedClientId = str(body.clientId, 36); clientId = selectedClientId; if (!/^[0-9a-f-]{36}$/i.test(selectedClientId)) throw new ValidationError('Invalid client');
      const patient = await withTenantTx(client, ctx.tenantId, (tx) => tx.clientRecord.findFirst({ where: { id: selectedClientId, tenantId: ctx.tenantId, mobile } }));
      if (!patient) throw new NotFoundError();
    } else {
      const candidates = await withTenantTx(client, ctx.tenantId, (tx) => tx.clientRecord.findMany({ where: { tenantId: ctx.tenantId, mobile, firstName, lastName }, take: 2 }));
      if (candidates.length > 1) throw new ConflictError('Multiple matching client records; select a client', { code: 'CLIENT_AMBIGUOUS' });
    }
    await requireActiveService(ctx.tenantId, d.row.id, eventTypeId);
    await ownService(ctx.engine, d.token, d.hostId, eventTypeId);
    const booking = await ctx.engine.request<Booking>('bookings', { method: 'POST', token: d.token, idempotencyKey: operationKey(request), body: { eventTypeId, start, attendee: { name, phone: mobile, timezone: 'Asia/Tehran' } } });
    await withTenantTx(client, ctx.tenantId, async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${ctx.tenantId + ':' + mobile}, 0))`;
      const prior = await tx.clientBookingLink.findUnique({ where: { tenantId_bookingUid: { tenantId: ctx.tenantId, bookingUid: booking.uid } } });
      if (prior) { if ((clientId && prior.clientId !== clientId) || prior.doctorId !== d.row.id) throw new ConflictError('Booking is linked to a different client'); return; }
      let selectedClient = clientId;
      if (!selectedClient) {
        const matches = await tx.clientRecord.findMany({ where: { tenantId: ctx.tenantId, mobile, firstName, lastName }, take: 2 });
        if (matches.length > 1) throw new ConflictError('Multiple matching client records; select a client', { code: 'CLIENT_AMBIGUOUS' });
        selectedClient = matches[0]?.id ?? (await tx.clientRecord.create({ data: { id: randomUUID(), tenantId: ctx.tenantId, firstName, lastName, mobile } })).id;
      }
      await tx.clientBookingLink.create({ data: { tenantId: ctx.tenantId, clientId: selectedClient, doctorId: d.row.id, bookingUid: booking.uid } });
    });
    return reply.code(201).send({ booking: bookingView(booking) });
  });
  app.post('/tenant/scheduling/doctors/:doctorId/bookings/:uid/cancel', async (request) => {
    sameOrigin(request);
    const ctx = await context(request);
    const d = await doctor(ctx.tenantId, doctorId(request), ctx.encryption);
    const uid = str((request.params as { uid: string }).uid, 100);
    if (!/^[a-zA-Z0-9_-]+$/.test(uid)) throw new ValidationError('Invalid booking');
    const existing = await ctx.engine.request<Booking>(`bookings/${uid}`, { token: d.token });
    if (existing.host.id !== d.hostId) throw new NotFoundError();
    const booking = await ctx.engine.request<Booking>(`bookings/${uid}/cancel`, { method: 'POST', token: d.token, idempotencyKey: operationKey(request), body: {} });
    return { booking: bookingView(booking) };
  });
}
