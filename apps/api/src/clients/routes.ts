import { randomUUID } from 'node:crypto';
import { withTenantTx, type PrismaClient } from '@hmn/db';
import { ConflictError, ForbiddenError, NotFoundError, UnauthorizedError, ValidationError } from '@hmn/shared';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { currentSession } from '../auth/session.js';

type Input = Record<string, unknown>;
const persianCalendar = new Intl.DateTimeFormat('en-u-ca-persian-nu-latn', { timeZone: 'UTC', year: 'numeric', month: 'numeric', day: 'numeric' });
function isPersianDate(value: string): boolean { const [y, m, d] = value.split('/').map(Number); if (!y || !m || !d) return false; const start = Date.UTC(y + 621, 2, 18); for (let i = 0; i < 370; i++) { const parts = persianCalendar.formatToParts(new Date(start + i * 86400000)); const part = (type: string) => Number(parts.find((item) => item.type === type)?.value); if (part('year') === y && part('month') === m && part('day') === d) return true; } return false; }
const digits = (value: string) => value.replace(/[۰-۹٠-٩]/g, (d) => String('۰۱۲۳۴۵۶۷۸۹'.includes(d) ? '۰۱۲۳۴۵۶۷۸۹'.indexOf(d) : '٠١٢٣٤٥٦٧٨٩'.indexOf(d)));
function field(body: Input, key: string, max: number, required = false): string | null {
  const value = body[key]; if (value === null || value === undefined || value === '') { if (required) throw new ValidationError('Missing field'); return null; }
  if (typeof value !== 'string' || value.trim().length > max || (required && !value.trim())) throw new ValidationError('Invalid field');
  return value.trim() || null;
}
function parse(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ValidationError('Invalid request');
  const b = value as Input;
  const firstName = field(b, 'firstName', 80, true)!; const lastName = field(b, 'lastName', 80, true)!;
  const mobile = digits(field(b, 'mobile', 11, true)!); if (!/^09\d{9}$/.test(mobile)) throw new ValidationError('Invalid mobile');
  const nationalId = digits(field(b, 'nationalId', 10) ?? '') || null;
  if (nationalId && !/^\d{10}$/.test(nationalId)) throw new ValidationError('Invalid national ID');
  const birthDate = digits(field(b, 'birthDate', 10) ?? '') || null;
  if (birthDate && (!/^1[34]\d{2}\/(0[1-9]|1[0-2])\/(0[1-9]|[12]\d|3[01])$/.test(birthDate) || !isPersianDate(birthDate))) throw new ValidationError('Invalid birth date');
  return { firstName, lastName, mobile, nationalId, birthDate, fatherName: field(b, 'fatherName', 80), fileNumber: field(b, 'fileNumber', 80), address: field(b, 'address', 500), occupation: field(b, 'occupation', 120) };
}
function sameOrigin(request: FastifyRequest) { try { const url = new URL(request.headers.origin ?? ''); if (!['http:', 'https:'].includes(url.protocol) || url.host !== request.headers.host) throw Error(); } catch { throw new ForbiddenError(); } }
export function clientRoutes(app: FastifyInstance, options: { client: PrismaClient }) {
  const { client } = options;
  async function tenant(request: FastifyRequest) {
    const session = await currentSession(client, request); if (!session) throw new UnauthorizedError(); if (!session.activeTenantId) throw new ForbiddenError();
    const id = session.activeTenantId;
    const membership = await withTenantTx(client, id, (tx) => tx.tenantMembership.findUnique({ where: { tenantId_userId: { tenantId: id, userId: session.userId } }, select: { role: true } }));
    if (!membership || !['OWNER', 'RECEPTION'].includes(membership.role)) throw new ForbiddenError();
    return id;
  }
  app.get('/tenant/clients', async (request) => {
    const tenantId = await tenant(request); const q = (request.query as { q?: unknown }).q;
    if (q !== undefined && (typeof q !== 'string' || q.length > 120)) throw new ValidationError('Invalid search');
    const search = typeof q === 'string' ? digits(q.trim()) : '';
    return { clients: await withTenantTx(client, tenantId, (tx) => tx.clientRecord.findMany({ where: { tenantId, ...(search ? { AND: search.split(/\s+/).map((term) => ({ OR: [{ firstName: { contains: term, mode: 'insensitive' as const } }, { lastName: { contains: term, mode: 'insensitive' as const } }, { mobile: { contains: term } }, { nationalId: { contains: term } }, { fileNumber: { contains: term, mode: 'insensitive' as const } }] })) } : {}) }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: 100 })) };
  });
  app.post('/tenant/clients', async (request, reply) => {
    sameOrigin(request); const tenantId = await tenant(request); const data = parse(request.body);
    try { const record = await withTenantTx(client, tenantId, (tx) => tx.clientRecord.create({ data: { ...data, id: randomUUID(), tenantId } })); return reply.code(201).send({ client: record }); }
    catch (error) { if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'P2002') throw new ConflictError('Duplicate file number or national ID'); throw error; }
  });
  app.post('/tenant/clients/:id', async (request) => {
    sameOrigin(request); const tenantId = await tenant(request); const id = (request.params as { id: string }).id; if (!/^[0-9a-f-]{36}$/i.test(id)) throw new NotFoundError(); const data = parse(request.body);
    try { const updated = await withTenantTx(client, tenantId, async (tx) => { const result = await tx.clientRecord.updateMany({ where: { tenantId, id }, data }); if (!result.count) throw new NotFoundError(); return tx.clientRecord.findFirst({ where: { tenantId, id } }); }); return { client: updated }; }
    catch (error) { if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'P2002') throw new ConflictError('Duplicate file number or national ID'); throw error; }
  });
  app.get('/tenant/clients/:id/payments', async (request) => {
    const tenantId = await tenant(request); const id = (request.params as { id: string }).id; if (!/^[0-9a-f-]{36}$/i.test(id)) throw new NotFoundError();
    return withTenantTx(client, tenantId, async (tx) => { const record = await tx.clientRecord.findFirst({ where: { tenantId, id } }); if (!record) throw new NotFoundError(); return { payments: await tx.clientPayment.findMany({ where: { tenantId, clientId: id }, orderBy: { paidAt: 'desc' }, take: 100 }) }; });
  });
  app.post('/tenant/clients/:id/payments', async (request, reply) => {
    sameOrigin(request); const tenantId = await tenant(request); const clientId = (request.params as { id: string }).id;
    if (!/^[0-9a-f-]{36}$/i.test(clientId) || !request.body || typeof request.body !== 'object' || Array.isArray(request.body)) throw new ValidationError('Invalid payment');
    const b = request.body as Input; const id = request.headers['idempotency-key'];
    if (typeof id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) throw new ValidationError('Invalid idempotency key');
    if (typeof b.amountTomans !== 'number' || !Number.isInteger(b.amountTomans) || b.amountTomans < 1 || b.amountTomans > 2000000000 || !['CASH', 'CARD', 'TRANSFER', 'OTHER'].includes(String(b.method))) throw new ValidationError('Invalid payment');
    const note = field(b, 'note', 500); const amountTomans = b.amountTomans; const method = String(b.method);
    const payment = await withTenantTx(client, tenantId, async (tx) => {
      const record = await tx.clientRecord.findFirst({ where: { tenantId, id: clientId } }); if (!record) throw new NotFoundError();
      const previous = await tx.clientPayment.findFirst({ where: { tenantId, id } });
      if (previous) { if (previous.clientId !== clientId || previous.amountTomans !== amountTomans || previous.method !== method || previous.note !== note) throw new ConflictError('Idempotency key already used'); return previous; }
      return tx.clientPayment.create({ data: { id, tenantId, clientId, amountTomans, method, note, paidAt: new Date() } });
    });
    return reply.code(201).send({ payment });
  });

}
