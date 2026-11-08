/**
 * hbook — event types (the bookable services, cal.com style).
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { conflict, notFound, unprocessable } from '../lib/errors';
import { cursorArg, pageResult, parsePage } from '../lib/paginate';
import { prisma } from '../lib/prisma';
import { config } from '../config';
import { R } from '../schemas/core';
import { EventTypeInput, EventTypePatch, EventTypeRef, EventTypesList, IdParam } from '../schemas/resources';

type BodyOf<T> = FastifyRequest<{ Body: T }>;

export default async function eventTypeRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.post(
    '/event-types',
    {
      schema: {
        summary: 'Create an event type',
        tags: ['Event Types'],
        security: [{ ApiKeyAuth: [] }],
        body: R('EventTypeInput'),
        response: { 201: R('EventTypeRef'), 409: R('Error'), 422: R('Error') },
      },
    },
    async (req: BodyOf<EventTypeInputShape>, reply) => {
      const b = req.body;
      const tenantId = req.tenant!.id;

      if (b.hostId) {
        const host = await prisma.user.findFirst({
          where: { id: b.hostId, tenantId, isHost: true },
          select: { id: true },
        });
        if (!host) {
          throw unprocessable('HOST_INVALID', 'hostId must reference an existing host user of this tenant.');
        }
      }

      try {
        const eventType = await prisma.eventType.create({
          data: {
            tenantId,
            slug: b.slug,
            title: b.title,
            description: b.description ?? null,
            hostId: b.hostId ?? null,
            durationMin: b.durationMin,
            slotIntervalMin: b.slotIntervalMin ?? b.durationMin,
            bufferBeforeMin: b.bufferBeforeMin ?? 0,
            bufferAfterMin: b.bufferAfterMin ?? 0,
            minLeadMinutes: b.minLeadMinutes ?? 0,
            maxLeadDays: b.maxLeadDays ?? config.defaultMaxLeadDays,
            location: b.location ?? null,
            requiresConfirmation: b.requiresConfirmation ?? false,
            isActive: b.isActive ?? true,
          },
        });
        return reply.status(201).send(eventType);
      } catch (e: unknown) {
        if ((e as { code?: string }).code === 'P2002') {
          throw conflict('SLUG_TAKEN', `Slug "${b.slug}" is already used in this tenant.`);
        }
        throw e;
      }
    },
  );

  fastify.get(
    '/event-types',
    {
      schema: {
        summary: 'List event types',
        tags: ['Event Types'],
        security: [{ ApiKeyAuth: [] }],
        querystring: {
          type: 'object',
          properties: {
            limit: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
            cursor: { type: 'string', maxLength: 128 },
            hostId: { type: 'string', maxLength: 64 },
          },
        },
        response: { 200: R('EventTypesList') },
      },
    },
    async (req) => {
      const q = req.query as { limit?: number; cursor?: string; hostId?: string };
      const page = parsePage(q);
      const rows = await prisma.eventType.findMany({
        where: { tenantId: req.tenant!.id, ...(q.hostId ? { hostId: q.hostId } : {}) },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: page.limit + 1,
        ...cursorArg(page.cursor),
      });
      return pageResult(rows, page.limit);
    },
  );

  fastify.get(
    '/event-types/:id',
    {
      schema: {
        summary: 'Get an event type by id or slug',
        tags: ['Event Types'],
        security: [{ ApiKeyAuth: [] }],
        params: R('IdParam'),
        response: { 200: R('EventTypeRef'), 404: R('Error') },
      },
    },
    async (req) => {
      const { id } = req.params as { id: string };
      const eventType = await prisma.eventType.findFirst({
        where: { tenantId: req.tenant!.id, OR: [{ id }, { slug: id }] },
      });
      if (!eventType) throw notFound('Event type');
      return eventType;
    },
  );

  fastify.patch(
    '/event-types/:id',
    {
      schema: {
        summary: 'Update an event type',
        tags: ['Event Types'],
        security: [{ ApiKeyAuth: [] }],
        params: R('IdParam'),
        body: R('EventTypePatch'),
        response: { 200: R('EventTypeRef'), 404: R('Error'), 422: R('Error') },
      },
    },
    async (req) => {
      const { id } = req.params as { id: string };
      const b = req.body as EventTypePatchShape;
      const tenantId = req.tenant!.id;

      const existing = await prisma.eventType.findFirst({
        where: { id, tenantId },
        select: { id: true },
      });
      if (!existing) throw notFound('Event type');

      if (b.hostId) {
        const host = await prisma.user.findFirst({
          where: { id: b.hostId, tenantId, isHost: true },
          select: { id: true },
        });
        if (!host) {
          throw unprocessable('HOST_INVALID', 'hostId must reference an existing host user of this tenant.');
        }
      }

      const eventType = await prisma.eventType.update({
        where: { id },
        data: {
          ...(b.title !== undefined ? { title: b.title } : {}),
          ...(b.description !== undefined ? { description: b.description } : {}),
          ...(b.hostId !== undefined ? { hostId: b.hostId } : {}),
          ...(b.durationMin !== undefined ? { durationMin: b.durationMin } : {}),
          ...(b.slotIntervalMin !== undefined ? { slotIntervalMin: b.slotIntervalMin } : {}),
          ...(b.bufferBeforeMin !== undefined ? { bufferBeforeMin: b.bufferBeforeMin } : {}),
          ...(b.bufferAfterMin !== undefined ? { bufferAfterMin: b.bufferAfterMin } : {}),
          ...(b.minLeadMinutes !== undefined ? { minLeadMinutes: b.minLeadMinutes } : {}),
          ...(b.maxLeadDays !== undefined ? { maxLeadDays: b.maxLeadDays } : {}),
          ...(b.location !== undefined ? { location: b.location } : {}),
          ...(b.requiresConfirmation !== undefined ? { requiresConfirmation: b.requiresConfirmation } : {}),
          ...(b.isActive !== undefined ? { isActive: b.isActive } : {}),
        },
      });
      return eventType;
    },
  );

  fastify.delete(
    '/event-types/:id',
    {
      schema: {
        summary: 'Delete an event type (fails while bookings reference it — deactivate instead)',
        tags: ['Event Types'],
        security: [{ ApiKeyAuth: [] }],
        params: R('IdParam'),
        response: { 200: { type: 'object', properties: { deleted: { type: 'boolean' } }, required: ['deleted'] }, 404: R('Error'), 409: R('Error') },
      },
    },
    async (req) => {
      const { id } = req.params as { id: string };
      const tenantId = req.tenant!.id;
      const existing = await prisma.eventType.findFirst({
        where: { id, tenantId },
        select: { id: true },
      });
      if (!existing) throw notFound('Event type');

      const bookings = await prisma.booking.count({ where: { eventTypeId: id } });
      if (bookings > 0) {
        throw conflict(
          'EVENT_TYPE_IN_USE',
          `This event type has ${bookings} booking(s). Set "isActive": false via PATCH instead of deleting.`,
        );
      }
      await prisma.eventType.delete({ where: { id } });
      return { deleted: true };
    },
  );
}

interface EventTypeInputShape {
  slug: string;
  title: string;
  description?: string;
  hostId?: string;
  durationMin: number;
  slotIntervalMin?: number;
  bufferBeforeMin?: number;
  bufferAfterMin?: number;
  minLeadMinutes?: number;
  maxLeadDays?: number;
  location?: string;
  requiresConfirmation?: boolean;
  isActive?: boolean;
}

interface EventTypePatchShape {
  title?: string;
  description?: string | null;
  hostId?: string | null;
  durationMin?: number;
  slotIntervalMin?: number;
  bufferBeforeMin?: number;
  bufferAfterMin?: number;
  minLeadMinutes?: number;
  maxLeadDays?: number;
  location?: string | null;
  requiresConfirmation?: boolean;
  isActive?: boolean;
}
