/**
 * hbook — bookings: create, list, get, confirm, cancel, reschedule.
 *
 * Concurrency safety (three layers):
 *  1. Slot validation with the same engine that serves GET /v1/slots.
 *  2. `pg_advisory_xact_lock(hostId)` inside the write transaction
 *     serializes concurrent writers for the same host (cheap row-level-ish lock).
 *  3. A PostgreSQL EXCLUDE (GiST) constraint `booking_no_host_overlap`
 *     makes overlapping active bookings physically impossible — even if a
 *     future code path bypasses (1) and (2).
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { Prisma } from '@prisma/client';
import { config } from '../config';
import { bookingWebhookPayload, engineConfigFromEventType, hostTimezone, loadEngineInput } from '../lib/booking';
import { conflict, notFound, unprocessable } from '../lib/errors';
import { generateBookingUid } from '../lib/keys';
import { cursorArg, pageResult, parsePage } from '../lib/paginate';
import { prisma } from '../lib/prisma';
import { isBookableStart } from '../lib/slots';
import { assertTimeZone } from '../lib/time';
import { dispatchWebhooks } from '../lib/webhooks';
import { R } from '../schemas/core';
import {
  BookingCancelBody,
  BookingCreateBody,
  BookingRef,
  BookingRescheduleBody,
  BookingUidParam,
  BookingsList,
  BookingsQuery,
} from '../schemas/resources';

const bookingInclude = {
  eventType: true,
  host: { select: { id: true, name: true, email: true, timezone: true } },
} satisfies Prisma.BookingInclude;

type BookingWithRefs = Prisma.BookingGetPayload<{ include: typeof bookingInclude }>;

type CreateRequest = FastifyRequest<{
  Body: {
    eventTypeId: string;
    hostId?: string;
    start: string;
    attendee: { name: string; email: string; phone?: string; timezone?: string; notes?: string };
  };
}>;

type RescheduleRequest = FastifyRequest<{ Params: { uid: string }; Body: { start: string } }>;
type CancelRequest = FastifyRequest<{ Params: { uid: string }; Body: { reason?: string } }>;

/** Serialize DB rows safely for the response serializer (Date → ISO). */
function toJSON<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/** Map the flat Prisma booking row (+ includes) to the API response shape. */
function bookingToResponse(b: BookingWithRefs) {
  return {
    uid: b.uid,
    status: b.status,
    startsAt: b.startsAt,
    endsAt: b.endsAt,
    attendee: {
      name: b.attendeeName,
      email: b.attendeeEmail,
      phone: b.attendeePhone,
      timezone: b.attendeeTimezone,
      notes: b.notes,
    },
    eventType: b.eventType,
    host: b.host,
    cancellationReason: b.cancellationReason,
    createdAt: b.createdAt,
  };
}

async function getBooking(tenantId: string, uid: string): Promise<BookingWithRefs> {
  const booking = await prisma.booking.findFirst({
    where: { tenantId, uid },
    include: bookingInclude,
  });
  if (!booking) throw notFound('Booking');
  return booking;
}

export default async function bookingRoutes(fastify: FastifyInstance): Promise<void> {
  // ───────────────────────────── create ─────────────────────────────
  fastify.post(
    '/bookings',
    {
      schema: {
        summary: 'Create a booking (attendee books a slot)',
        description:
          'Validates the requested start against availability and current bookings, then persists it inside a transaction guarded by an advisory lock and a database exclusion constraint. Emits booking.created webhooks.',
        tags: ['Bookings'],
        security: [{ ApiKeyAuth: [] }],
        body: R('BookingCreateBody'),
        response: { 201: R('BookingRef'), 409: R('Error'), 422: R('Error'), 404: R('Error') },
      },
    },
    async (req: CreateRequest, reply) => {
      const tenant = req.tenant!;
      const b = req.body;

      const eventType = await prisma.eventType.findFirst({
        where: { tenantId: tenant.id, isActive: true, OR: [{ id: b.eventTypeId }, { slug: b.eventTypeId }] },
      });
      if (!eventType) throw notFound('Event type');

      const hostId = b.hostId ?? eventType.hostId;
      if (!hostId) {
        throw unprocessable('HOST_REQUIRED', 'This event type has no fixed host — pass "hostId" in the body.');
      }
      const host = await prisma.user.findFirst({
        where: { id: hostId, tenantId: tenant.id, isHost: true },
      });
      if (!host) throw unprocessable('HOST_INVALID', 'hostId must reference a host user of this tenant.');

      if (b.attendee.timezone) assertTimeZone(b.attendee.timezone);

      const start = new Date(b.start);
      if (Number.isNaN(start.getTime())) {
        throw unprocessable('INVALID_START', 'start must be a valid ISO 8601 date-time.');
      }
      const end = new Date(start.getTime() + eventType.durationMin * 60_000);

      // Layer 1 — engine validation (availability windows, lead times, busy check)
      const engine = await loadEngineInput({
        hostId,
        fromUtc: start,
        toUtc: end,
      });
      const bookable = isBookableStart({
        timeZone: hostTimezone(host, tenant),
        fromUtc: start,
        toUtc: end,
        weekly: engine.weekly,
        overrides: engine.overrides,
        busy: engine.busy,
        nowUtc: new Date(),
        startUtc: start,
        ...engineConfigFromEventType(eventType),
      });
      if (!bookable) {
        throw unprocessable(
          'SLOT_UNAVAILABLE',
          'The requested start is not an available slot. Fetch GET /v1/slots and use an exact value.',
        );
      }

      // Layers 2 + 3 — advisory lock + overlap re-check + DB exclusion constraint
      const status: 'PENDING' | 'CONFIRMED' = eventType.requiresConfirmation ? 'PENDING' : 'CONFIRMED';
      let created: { id: string };
      for (let attempt = 0; ; attempt++) {
        try {
          created = await prisma.$transaction(async (tx) => {
            await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${hostId}, 0))`;
            const overlap = await tx.booking.count({
              where: {
                hostId,
                status: { in: ['PENDING', 'CONFIRMED'] },
                startsAt: { lt: end },
                endsAt: { gt: start },
              },
            });
            if (overlap > 0) {
              throw conflict(
                'SLOT_TAKEN',
                'This slot has just been booked. Fetch GET /v1/slots for the next available time.',
              );
            }
            return tx.booking.create({
              data: {
                uid: generateBookingUid(),
                tenantId: tenant.id,
                eventTypeId: eventType.id,
                hostId,
                startsAt: start,
                endsAt: end,
                status,
                attendeeName: b.attendee.name,
                attendeeEmail: b.attendee.email.toLowerCase(),
                attendeePhone: b.attendee.phone ?? null,
                attendeeTimezone: b.attendee.timezone ?? null,
                notes: b.attendee.notes ?? null,
              },
              select: { id: true },
            });
          });
          break;
        } catch (e: unknown) {
          if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002' && attempt < 2) {
            continue; // uid collision (astronomically rare) — retry with a new uid
          }
          if (
            e instanceof Prisma.PrismaClientUnknownRequestError &&
            String(e.message).includes('booking_no_host_overlap')
          ) {
            throw conflict('SLOT_TAKEN', 'This slot has just been booked (database conflict guard).');
          }
          throw e;
        }
      }

      const full = await prisma.booking.findUniqueOrThrow({
        where: { id: created.id },
        include: bookingInclude,
      });

      dispatchWebhooks(tenant.id, 'booking.created', bookingWebhookPayload(full));
      return reply.status(201).send(toJSON(bookingToResponse(full)));
    },
  );

  // ───────────────────────────── list ─────────────────────────────
  fastify.get(
    '/bookings',
    {
      schema: {
        summary: 'List bookings (filters + cursor pagination)',
        tags: ['Bookings'],
        security: [{ ApiKeyAuth: [] }],
        querystring: R('BookingsQuery'),
        response: { 200: R('BookingsList') },
      },
    },
    async (req) => {
      const q = req.query as {
        limit?: number;
        cursor?: string;
        status?: 'PENDING' | 'CONFIRMED' | 'CANCELLED';
        eventTypeId?: string;
        hostId?: string;
        attendeeEmail?: string;
        from?: string;
        to?: string;
      };
      const page = parsePage(q);

      let from: Date | undefined;
      let to: Date | undefined;
      if (q.from) {
        from = new Date(q.from);
        if (Number.isNaN(from.getTime())) throw unprocessable('INVALID_RANGE', 'from must be an ISO date-time.');
      }
      if (q.to) {
        to = new Date(q.to);
        if (Number.isNaN(to.getTime())) throw unprocessable('INVALID_RANGE', 'to must be an ISO date-time.');
      }

      const rows = await prisma.booking.findMany({
        where: {
          tenantId: req.tenant!.id,
          ...(q.status ? { status: q.status } : {}),
          ...(q.eventTypeId ? { eventTypeId: q.eventTypeId } : {}),
          ...(q.hostId ? { hostId: q.hostId } : {}),
          ...(q.attendeeEmail ? { attendeeEmail: q.attendeeEmail.toLowerCase() } : {}),
          ...(from || to ? { startsAt: { ...(from ? { gte: from } : {}), ...(to ? { lt: to } : {}) } } : {}),
        },
        include: bookingInclude,
        orderBy: [{ startsAt: 'desc' }, { id: 'desc' }],
        take: page.limit + 1,
        ...cursorArg(page.cursor),
      });

      const result = pageResult(rows, page.limit);
      return toJSON({ ...result, items: result.items.map(bookingToResponse) });
    },
  );

  // ───────────────────────────── get one ─────────────────────────────
  fastify.get(
    '/bookings/:uid',
    {
      schema: {
        summary: 'Get a booking by uid',
        tags: ['Bookings'],
        security: [{ ApiKeyAuth: [] }],
        params: R('BookingUidParam'),
        response: { 200: R('BookingRef'), 404: R('Error') },
      },
    },
    async (req) => {
      const booking = await getBooking(req.tenant!.id, (req.params as { uid: string }).uid);
      return toJSON(bookingToResponse(booking));
    },
  );

  // ───────────────────────────── confirm ─────────────────────────────
  fastify.post(
    '/bookings/:uid/confirm',
    {
      schema: {
        summary: 'Confirm a pending booking',
        tags: ['Bookings'],
        security: [{ ApiKeyAuth: [] }],
        params: R('BookingUidParam'),
        response: { 200: R('BookingRef'), 404: R('Error'), 409: R('Error') },
      },
    },
    async (req) => {
      const uid = (req.params as { uid: string }).uid;
      const booking = await getBooking(req.tenant!.id, uid);
      if (booking.status !== 'PENDING') {
        throw conflict('NOT_PENDING', `Only PENDING bookings can be confirmed (current: ${booking.status}).`);
      }
      const updated = await prisma.booking.update({
        where: { id: booking.id },
        data: { status: 'CONFIRMED' },
        include: bookingInclude,
      });
      dispatchWebhooks(req.tenant!.id, 'booking.confirmed', bookingWebhookPayload(updated));
      return toJSON(bookingToResponse(updated));
    },
  );

  // ───────────────────────────── cancel ─────────────────────────────
  fastify.post(
    '/bookings/:uid/cancel',
    {
      schema: {
        summary: 'Cancel a booking (frees the slot)',
        tags: ['Bookings'],
        security: [{ ApiKeyAuth: [] }],
        params: R('BookingUidParam'),
        body: R('BookingCancelBody'),
        response: { 200: R('BookingRef'), 404: R('Error'), 409: R('Error') },
      },
    },
    async (req: CancelRequest) => {
      const uid = (req.params as { uid: string }).uid;
      const booking = await getBooking(req.tenant!.id, uid);
      if (booking.status === 'CANCELLED') {
        throw conflict('ALREADY_CANCELLED', 'This booking is already cancelled.');
      }
      const updated = await prisma.booking.update({
        where: { id: booking.id },
        data: {
          status: 'CANCELLED',
          cancellationReason: req.body.reason ?? null,
          cancelledAt: new Date(),
        },
        include: bookingInclude,
      });
      dispatchWebhooks(req.tenant!.id, 'booking.cancelled', bookingWebhookPayload(updated));
      return toJSON(bookingToResponse(updated));
    },
  );

  // ─────────────────────────── reschedule ───────────────────────────
  fastify.post(
    '/bookings/:uid/reschedule',
    {
      schema: {
        summary: 'Reschedule a booking to another available slot',
        tags: ['Bookings'],
        security: [{ ApiKeyAuth: [] }],
        params: R('BookingUidParam'),
        body: R('BookingRescheduleBody'),
        response: { 200: R('BookingRef'), 404: R('Error'), 409: R('Error'), 422: R('Error') },
      },
    },
    async (req: RescheduleRequest) => {
      const uid = (req.params as { uid: string }).uid;
      const tenant = req.tenant!;
      const booking = await prisma.booking.findFirst({
        where: { tenantId: tenant.id, uid },
        include: { eventType: true, host: true },
      });
      if (!booking) throw notFound('Booking');
      if (booking.status === 'CANCELLED') {
        throw conflict('BOOKING_CANCELLED', 'Cancelled bookings cannot be rescheduled — create a new one.');
      }

      const start = new Date(req.body.start);
      if (Number.isNaN(start.getTime())) {
        throw unprocessable('INVALID_START', 'start must be a valid ISO 8601 date-time.');
      }
      const end = new Date(start.getTime() + booking.eventType.durationMin * 60_000);
      if (start.getTime() === booking.startsAt.getTime()) {
        throw unprocessable('RESCHEDULE_SAME_TIME', 'New start equals the current start.');
      }

      // validate against availability, excluding this booking's current hold
      const engine = await loadEngineInput({
        hostId: booking.hostId,
        fromUtc: start,
        toUtc: end,
        excludeBookingId: booking.id,
      });
      const bookable = isBookableStart({
        timeZone: hostTimezone(booking.host, tenant),
        fromUtc: start,
        toUtc: end,
        weekly: engine.weekly,
        overrides: engine.overrides,
        busy: engine.busy,
        nowUtc: new Date(),
        startUtc: start,
        ...engineConfigFromEventType(booking.eventType),
      });
      if (!bookable) {
        throw unprocessable('SLOT_UNAVAILABLE', 'The requested start is not an available slot.');
      }

      const previousStart = booking.startsAt;
      const updated = await prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${booking.hostId}, 0))`;
        const overlap = await tx.booking.count({
          where: {
            hostId: booking.hostId,
            status: { in: ['PENDING', 'CONFIRMED'] },
            id: { not: booking.id },
            startsAt: { lt: end },
            endsAt: { gt: start },
          },
        });
        if (overlap > 0) {
          throw conflict('SLOT_TAKEN', 'The requested slot has just been booked.');
        }
        return tx.booking.update({
          where: { id: booking.id },
          data: { startsAt: start, endsAt: end },
          include: bookingInclude,
        });
      });

      dispatchWebhooks(tenant.id, 'booking.rescheduled', {
        ...bookingWebhookPayload(updated),
        previousStart: previousStart.toISOString(),
      });
      return toJSON(bookingToResponse(updated));
    },
  );
}
