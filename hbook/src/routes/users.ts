/**
 * hbook — hosts/users of the authenticated tenant.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { conflict, notFound } from '../lib/errors';
import { cursorArg, pageResult, parsePage } from '../lib/paginate';
import { prisma } from '../lib/prisma';
import { assertTimeZone } from '../lib/time';
import { R } from '../schemas/core';
import { IdParam, UserInput, UserPatch, UserRef, UsersList } from '../schemas/resources';

type BodyOf<T> = FastifyRequest<{ Body: T }>;

export default async function userRoutes(fastify: FastifyInstance): Promise<void> {
  const tenantIdOf = (req: FastifyRequest): string => req.tenant!.id;

  fastify.post(
    '/users',
    {
      schema: {
        summary: 'Create a user (host)',
        tags: ['Users'],
        security: [{ ApiKeyAuth: [] }],
        body: R('UserInput'),
        response: { 201: R('UserRef'), 409: R('Error') },
      },
    },
    async (req: BodyOf<{ name: string; email: string; timezone?: string; role?: 'OWNER' | 'ADMIN' | 'MEMBER'; isHost?: boolean }>, reply) => {
      const b = req.body;
      const timezone = b.timezone ?? req.tenant!.timezone;
      assertTimeZone(timezone);
      try {
        const user = await prisma.user.create({
          data: {
            tenantId: tenantIdOf(req),
            name: b.name,
            email: b.email.toLowerCase(),
            timezone,
            role: b.role ?? 'MEMBER',
            isHost: b.isHost ?? true,
          },
        });
        return reply.status(201).send(user);
      } catch (e: unknown) {
        if ((e as { code?: string }).code === 'P2002') {
          throw conflict('EMAIL_TAKEN', 'A user with this email already exists in the tenant.');
        }
        throw e;
      }
    },
  );

  fastify.get(
    '/users',
    {
      schema: {
        summary: 'List users',
        tags: ['Users'],
        security: [{ ApiKeyAuth: [] }],
        querystring: R('ListQuery'),
        response: { 200: R('UsersList') },
      },
    },
    async (req) => {
      const page = parsePage(req.query as { limit?: number; cursor?: string });
      const rows = await prisma.user.findMany({
        where: { tenantId: tenantIdOf(req) },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: page.limit + 1,
        ...cursorArg(page.cursor),
      });
      return pageResult(rows, page.limit);
    },
  );

  fastify.get(
    '/users/:id',
    {
      schema: {
        summary: 'Get a user',
        tags: ['Users'],
        security: [{ ApiKeyAuth: [] }],
        params: R('IdParam'),
        response: { 200: R('UserRef'), 404: R('Error') },
      },
    },
    async (req) => {
      const user = await prisma.user.findFirst({
        where: { id: (req.params as { id: string }).id, tenantId: tenantIdOf(req) },
      });
      if (!user) throw notFound('User');
      return user;
    },
  );

  fastify.patch(
    '/users/:id',
    {
      schema: {
        summary: 'Update a user',
        tags: ['Users'],
        security: [{ ApiKeyAuth: [] }],
        params: R('IdParam'),
        body: R('UserPatch'),
        response: { 200: R('UserRef'), 404: R('Error'), 409: R('Error') },
      },
    },
    async (req) => {
      const { id } = req.params as { id: string };
      const b = req.body as { name?: string; email?: string; timezone?: string; role?: 'OWNER' | 'ADMIN' | 'MEMBER'; isHost?: boolean };
      if (b.timezone) assertTimeZone(b.timezone);

      // Verify tenant ownership BEFORE any write (no cross-tenant mutation).
      const existing = await prisma.user.findFirst({
        where: { id, tenantId: tenantIdOf(req) },
        select: { id: true },
      });
      if (!existing) throw notFound('User');

      try {
        const user = await prisma.user.update({
          where: { id },
          data: {
            ...(b.name !== undefined ? { name: b.name } : {}),
            ...(b.email !== undefined ? { email: b.email.toLowerCase() } : {}),
            ...(b.timezone !== undefined ? { timezone: b.timezone } : {}),
            ...(b.role !== undefined ? { role: b.role } : {}),
            ...(b.isHost !== undefined ? { isHost: b.isHost } : {}),
          },
        });
        return user;
      } catch (e: unknown) {
        if ((e as { code?: string }).code === 'P2002') {
          throw conflict('EMAIL_TAKEN', 'A user with this email already exists in the tenant.');
        }
        throw e;
      }
    },
  );

  fastify.delete(
    '/users/:id',
    {
      schema: {
        summary: 'Delete a user (fails while future bookings exist)',
        tags: ['Users'],
        security: [{ ApiKeyAuth: [] }],
        params: R('IdParam'),
        response: { 200: { type: 'object', properties: { deleted: { type: 'boolean' } }, required: ['deleted'] }, 404: R('Error'), 409: R('Error') },
      },
    },
    async (req) => {
      const { id } = req.params as { id: string };
      const user = await prisma.user.findFirst({ where: { id, tenantId: tenantIdOf(req) } });
      if (!user) throw notFound('User');

      const futureBookings = await prisma.booking.count({
        where: { hostId: id, status: { in: ['PENDING', 'CONFIRMED'] }, endsAt: { gt: new Date() } },
      });
      if (futureBookings > 0) {
        throw conflict(
          'USER_HAS_BOOKINGS',
          `This host still has ${futureBookings} upcoming booking(s). Cancel or reassign them first.`,
        );
      }

      await prisma.user.delete({ where: { id } }); // cascades availability + overrides
      return { deleted: true };
    },
  );
}
