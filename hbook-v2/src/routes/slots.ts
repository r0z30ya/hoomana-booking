/**
 * hbook — free slot discovery (the heart of the public surface).
 * GET /v1/slots?eventTypeId=…&from=…&to=…&timezone=…
 * Each slot carries `seatsRemaining` (concurrent capacity model).
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { config } from '../config';
import { notFound, unprocessable } from '../lib/errors';
import { engineConfigFromEventType, hostTimezone, loadEngineInput } from '../lib/booking';
import { generateSlots } from '../lib/slots';
import { prisma } from '../lib/prisma';
import { assertTimeZone, dateKeyAddDays, zonedToUtc } from '../lib/time';
import { R } from '../schemas/core';
import { SlotsQuery, SlotsResponse } from '../schemas/resources';

type SlotsRequest = FastifyRequest<{
  Querystring: { eventTypeId: string; hostId?: string; from: string; to: string; timezone?: string };
}>;

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

export default async function slotRoutes(fastify: FastifyInstance): Promise<void> {
  const requireScope = fastify.requireScope.bind(fastify);

  fastify.get(
    '/slots',
    {
      preHandler: requireScope('read'),
      schema: {
        summary: 'List free slots of an event type in a date range',
        description:
          'Returns ascending UTC start instants with remaining concurrent seats. Date-only from/to are interpreted as local calendar days in the resolved timezone. Range is capped at 62 days.',
        tags: ['Slots'],
        security: [{ ApiKeyAuth: [] }],
        querystring: R('SlotsQuery'),
        response: { 200: R('SlotsResponse'), 404: R('Error'), 422: R('Error') },
      },
    },
    async (req) => {
      const q = (req as unknown as SlotsRequest).query;
      const tenant = req.tenant!;

      const eventType = await prisma.eventType.findFirst({
        where: { tenantId: tenant.id, isActive: true, OR: [{ id: q.eventTypeId }, { slug: q.eventTypeId }] },
      });
      if (!eventType) throw notFound('Event type');

      const hostId = q.hostId ?? eventType.hostId;
      if (eventType.hostId && q.hostId && eventType.hostId !== q.hostId) {
        throw unprocessable('HOST_INVALID', 'This event type belongs to a different host.');
      }
      if (!hostId) {
        throw unprocessable(
          'HOST_REQUIRED',
          'This event type has no fixed host — pass a "hostId" query parameter.',
        );
      }
      const host = await prisma.user.findFirst({
        where: { id: hostId, tenantId: tenant.id, isHost: true },
      });
      if (!host) throw unprocessable('HOST_INVALID', 'hostId must reference a host user of this tenant.');

      const timeZone = q.timezone ?? hostTimezone(host, tenant);
      assertTimeZone(timeZone);

      const fromUtc = DATE_ONLY.test(q.from) ? zonedToUtc(timeZone, q.from, 0) : new Date(q.from);
      const toUtc = DATE_ONLY.test(q.to)
        ? zonedToUtc(timeZone, dateKeyAddDays(q.to, 1), 0) // exclusive end: next local midnight
        : new Date(q.to);
      if (Number.isNaN(fromUtc.getTime()) || Number.isNaN(toUtc.getTime())) {
        throw unprocessable('INVALID_RANGE', 'from/to must be ISO date-times or YYYY-MM-DD.');
      }
      if (toUtc.getTime() <= fromUtc.getTime()) {
        throw unprocessable('INVALID_RANGE', '"to" must be after "from".');
      }
      const rangeDays = (toUtc.getTime() - fromUtc.getTime()) / 86_400_000;
      if (rangeDays > config.maxSlotRangeDays) {
        throw unprocessable('RANGE_TOO_LARGE', `Slot range is capped at ${config.maxSlotRangeDays} days.`);
      }

      const engine = await loadEngineInput({ hostId, fromUtc, toUtc });
      const slots = generateSlots({
        timeZone: hostTimezone(host, tenant),
        fromUtc,
        toUtc,
        eventTypeId: eventType.id,
        weekly: engine.weekly,
        overrides: engine.overrides,
        busy: engine.busy,
        nowUtc: new Date(),
        ...engineConfigFromEventType(eventType),
      });

      return {
        eventTypeId: eventType.id,
        hostId,
        timezone: timeZone,
        from: fromUtc.toISOString(),
        to: toUtc.toISOString(),
        durationMinutes: eventType.durationMin,
        capacity: Math.max(1, eventType.capacity ?? 1),
        slots: slots.map((s) => ({ startsAt: s.startsAt.toISOString(), seatsRemaining: s.seatsRemaining })),
      };
    },
  );
}
