/**
 * hbook — bookings: create, list, get, confirm, cancel, reschedule.
 *
 * Capacity & conflict safety (layered, all DB-backed):
 *  1. Engine validation (`bookableSeats`) — the SAME code that serves
 *     GET /v1/slots: availability windows, per-booking buffers, lead times,
 *     seat-group capacity. Slots list and booking writes cannot disagree.
 *  2. `pg_advisory_xact_lock(hostId)` FIRST inside the write transaction —
 *     serializes all writers for a host (works across engine instances,
 *     advisory locks live in PostgreSQL, not in the process).
 *  3. SlotInstance seat counter: SELECT … FOR UPDATE (EPQ re-read → always
 *     the latest committed value) + DB CHECK `taken <= capacity` — the hard
 *     guarantee that active bookings never exceed capacity.
 *  4. Buffered overlap re-check inside the transaction (mirrors the engine).
 *  5. Constraint trigger `booking_fit_guard` — re-validates capacity and
 *     buffered overlap for ANY writer (even raw SQL) as defense in depth.
 *
 * Seat semantics (documented in docs/INTEGRATION.md):
 *   PENDING + CONFIRMED consume one seat each · CANCELLED frees the seat ·
 *   reschedule frees the old window and consumes the new one atomically.
 *
 * All mutating endpoints accept `Idempotency-Key` (retries are safe) and
 * emit webhook events through the transactional outbox.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { Prisma } from '@prisma/client';
import { bookingWebhookPayload, engineConfigFromEventType, hostTimezone, loadEngineInput } from '../lib/booking';
import { conflict, notFound, unprocessable } from '../lib/errors';
import { withIdempotency } from '../lib/idempotency';
import { generateBookingUid } from '../lib/keys';
import { normalizePhone } from '../lib/phone';
import { cursorArg, pageResult, parsePage } from '../lib/paginate';
import { prisma } from '../lib/prisma';
import { bookableSeats } from '../lib/slots';
import { assertTimeZone } from '../lib/time';
import { enqueueWebhookEvent } from '../lib/webhooks';
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
    attendee: { name: string; phone: string; email?: string; timezone?: string; notes?: string };
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
      phone: b.attendeePhone,
      email: b.attendeeEmail,
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

/** Buffered-overlap count for a candidate booking inside a transaction. */
function bufferedOverlapCount(
  tx: Prisma.TransactionClient,
  cand: {
    hostId: string;
    eventTypeId: string;
    startsAt: Date;
    endsAt: Date;
    bufferBeforeMin: number;
    bufferAfterMin: number;
    excludeBookingId?: string;
  },
): Promise<number> {
  return tx.$queryRaw<Array<{ n: bigint }>>`
    SELECT count(*) AS n
    FROM "Booking" b
    JOIN "EventType" e ON e."id" = b."eventTypeId"
    WHERE b."hostId" = ${cand.hostId}::text
      AND b."status" IN ('PENDING', 'CONFIRMED')
      AND (b."eventTypeId" <> ${cand.eventTypeId}::text OR b."startsAt" <> ${cand.startsAt}::timestamptz)
      ${cand.excludeBookingId ? Prisma.sql`AND b."id" <> ${cand.excludeBookingId}::text` : Prisma.empty}
      AND tstzrange(b."startsAt" - make_interval(mins => e."bufferBeforeMin"::int),
                    b."endsAt" + make_interval(mins => e."bufferAfterMin"::int), '[)')
          &&
          tstzrange(${cand.startsAt}::timestamptz - make_interval(mins => ${cand.bufferBeforeMin}::int),
                    ${cand.endsAt}::timestamptz + make_interval(mins => ${cand.bufferAfterMin}::int), '[)')
  `.then((rows) => Number(rows[0]?.n ?? 0));
}

/** Upsert + lock the seat counter row; returns true when a seat is free. */
async function acquireSeat(
  tx: Prisma.TransactionClient,
  p: { tenantId: string; hostId: string; eventType: { id: string; durationMin: number; capacity: number }; start: Date; end: Date },
): Promise<void> {
  await tx.$executeRaw`
    INSERT INTO "SlotInstance" ("id", "tenantId", "hostId", "eventTypeId", "startsAt", "endsAt", "capacity", "taken", "createdAt", "updatedAt")
    VALUES (gen_random_uuid()::text, ${p.tenantId}::text, ${p.hostId}::text, ${p.eventType.id}::text,
            ${p.start}::timestamptz, ${p.end}::timestamptz, ${p.eventType.capacity}, 0, now(), now())
    ON CONFLICT ("hostId", "eventTypeId", "startsAt") DO NOTHING`;
  const rows = await tx.$queryRaw<Array<{ taken: number; capacity: number }>>`
    SELECT "taken", "capacity" FROM "SlotInstance"
    WHERE "hostId" = ${p.hostId}::text AND "eventTypeId" = ${p.eventType.id}::text
      AND "startsAt" = ${p.start}::timestamptz
    FOR UPDATE`;
  const inst = rows[0];
  const capacity = p.eventType.capacity;
  if (!inst || inst.taken >= capacity) {
    throw conflict(
      'SLOT_TAKEN',
      'This slot has just been booked — no seats remain. Fetch GET /v1/slots for the next available time.',
    );
  }
  await tx.$executeRaw`
    UPDATE "SlotInstance" SET "taken" = "taken" + 1, "capacity" = ${capacity}, "updatedAt" = now()
    WHERE "hostId" = ${p.hostId}::text AND "eventTypeId" = ${p.eventType.id}::text
      AND "startsAt" = ${p.start}::timestamptz`;
}

/** Release one seat (cancel / reschedule-away). Missing row → nothing to free. */
async function releaseSeat(
  tx: Prisma.TransactionClient,
  p: { hostId: string; eventTypeId: string; start: Date },
): Promise<void> {
  await tx.$executeRaw`
    UPDATE "SlotInstance" SET "taken" = GREATEST("taken" - 1, 0), "updatedAt" = now()
    WHERE "hostId" = ${p.hostId}::text AND "eventTypeId" = ${p.eventTypeId}::text
      AND "startsAt" = ${p.start}::timestamptz`;
}

/** Map the low-level guard errors to stable API codes. */
function mapGuardError(e: unknown): never | undefined {
  const msg = String((e as Error)?.message ?? '');
  if (msg.includes('HBOOK_CAPACITY_EXCEEDED') || msg.includes('HBOOK_OVERLAP')) {
    throw conflict('SLOT_TAKEN', 'This slot has just been booked (database conflict guard).');
  }
  return undefined;
}

export default async function bookingRoutes(fastify: FastifyInstance): Promise<void> {
  const requireScope = fastify.requireScope.bind(fastify);

  // ───────────────────────────── create ─────────────────────────────
  fastify.post(
    '/bookings',
    {
      preHandler: requireScope('book'),
      schema: {
        summary: 'Create a booking (patient books a slot by mobile)',
        description:
          'Validates the requested start against availability, buffers and seat capacity inside a transaction guarded by an advisory lock, a seat counter (CHECK taken<=capacity) and a constraint trigger. Emits booking.created via the transactional outbox. Send an Idempotency-Key header to make retries safe.',
        tags: ['Bookings'],
        security: [{ ApiKeyAuth: [] }],
        headers: {
          type: 'object',
          properties: { 'idempotency-key': { type: 'string', maxLength: 200 } },
        },
        body: R('BookingCreateBody'),
        response: { 201: R('BookingRef'), 409: R('Error'), 422: R('Error'), 404: R('Error') },
      },
    },
    async (req: CreateRequest, reply) => {
      return withIdempotency(req, reply, 'POST /v1/bookings', async (tx) => {
        const tenant = req.tenant!;
        const b = req.body;

        const eventType = await tx.eventType.findFirst({
          where: { tenantId: tenant.id, isActive: true, OR: [{ id: b.eventTypeId }, { slug: b.eventTypeId }] },
        });
        if (!eventType) throw notFound('Event type');

        const hostId = b.hostId ?? eventType.hostId;
        if (eventType.hostId && b.hostId && eventType.hostId !== b.hostId) {
          throw unprocessable('HOST_INVALID', 'This event type belongs to a different host.');
        }
        if (!hostId) {
          throw unprocessable('HOST_REQUIRED', 'This event type has no fixed host — pass "hostId" in the body.');
        }
        const host = await tx.user.findFirst({
          where: { id: hostId, tenantId: tenant.id, isHost: true },
        });
        if (!host) throw unprocessable('HOST_INVALID', 'hostId must reference a host user of this tenant.');

        if (b.attendee.timezone) assertTimeZone(b.attendee.timezone);

        const phone = normalizePhone(b.attendee.phone);
        if (!phone) {
          throw unprocessable(
            'INVALID_PHONE',
            'attendee.phone must be a mobile number — e.g. 09123456789, +989123456789 or ۰۹۱۲۳۴۵۶۷۸۹.',
          );
        }
        const email = b.attendee.email ? b.attendee.email.trim().toLowerCase() : null;

        const start = new Date(b.start);
        if (Number.isNaN(start.getTime())) {
          throw unprocessable('INVALID_START', 'start must be a valid ISO 8601 date-time.');
        }
        const end = new Date(start.getTime() + eventType.durationMin * 60_000);

        // Layer 1 — engine validation (windows, buffers, lead times, seats)
        const engine = await loadEngineInput({ hostId, fromUtc: start, toUtc: end, tx });
        const seats = bookableSeats({
          timeZone: hostTimezone(host, tenant),
          fromUtc: start,
          toUtc: end,
          eventTypeId: eventType.id,
          weekly: engine.weekly,
          overrides: engine.overrides,
          busy: engine.busy,
          nowUtc: new Date(),
          startUtc: start,
          ...engineConfigFromEventType(eventType),
        });
        if (seats === null) {
          throw unprocessable(
            'SLOT_UNAVAILABLE',
            'The requested start is not an available slot. Fetch GET /v1/slots and use an exact value.',
          );
        }

        // Layers 2–5 — lock → seats → overlap → trigger
        const status: 'PENDING' | 'CONFIRMED' = eventType.requiresConfirmation ? 'PENDING' : 'CONFIRMED';
        const bookingUid = generateBookingUid();
        let created: { id: string };
        try {
          created = await (async () => {
            await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${hostId}, 0))`;
            await acquireSeat(tx, {
              tenantId: tenant.id,
              hostId,
              eventType: { id: eventType.id, durationMin: eventType.durationMin, capacity: eventType.capacity },
              start,
              end,
            });
            const overlap = await bufferedOverlapCount(tx, {
              hostId,
              eventTypeId: eventType.id,
              startsAt: start,
              endsAt: end,
              bufferBeforeMin: eventType.bufferBeforeMin,
              bufferAfterMin: eventType.bufferAfterMin,
            });
            if (overlap > 0) {
              throw conflict(
                'SLOT_TAKEN',
                'This slot has just been booked. Fetch GET /v1/slots for the next available time.',
              );
            }
            const row = await tx.booking.create({
              data: {
                uid: bookingUid,
                tenantId: tenant.id,
                eventTypeId: eventType.id,
                hostId,
                startsAt: start,
                endsAt: end,
                status,
                attendeeName: b.attendee.name,
                attendeePhone: phone,
                attendeeEmail: email,
                attendeeTimezone: b.attendee.timezone ?? null,
                notes: b.attendee.notes ?? null,
              },
              select: { id: true },
            });
            await enqueueWebhookEvent(tx, tenant.id, 'booking.created', bookingWebhookPayload({
              uid: bookingUid,
              tenantId: tenant.id,
              eventTypeId: eventType.id,
              hostId,
              status,
              startsAt: start,
              endsAt: end,
            }));
            return row;
          })();
        } catch (e) {
          mapGuardError(e);
          if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
            throw conflict('SLOT_TAKEN', 'This slot has just been booked (database conflict guard).');
          }
          throw e;
        }

        const full = await tx.booking.findUniqueOrThrow({
          where: { id: created.id },
          include: bookingInclude,
        });
        return { status: 201, body: toJSON(bookingToResponse(full)) };
      });
    },
  );

  // ───────────────────────────── list ─────────────────────────────
  fastify.get(
    '/bookings',
    {
      preHandler: requireScope('read'),
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
        attendeePhone?: string;
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

      const normalizedPhone = q.attendeePhone ? normalizePhone(q.attendeePhone) : undefined;
      if (q.attendeePhone && !normalizedPhone) {
        throw unprocessable('INVALID_PHONE', 'attendeePhone filter must be a valid mobile number.');
      }

      const rows = await prisma.booking.findMany({
        where: {
          tenantId: req.tenant!.id,
          ...(q.status ? { status: q.status } : {}),
          ...(q.eventTypeId ? { eventTypeId: q.eventTypeId } : {}),
          ...(q.hostId ? { hostId: q.hostId } : {}),
          ...(normalizedPhone ? { attendeePhone: normalizedPhone } : {}),
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
      preHandler: requireScope('read'),
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
      preHandler: requireScope('book'),
      schema: {
        summary: 'Confirm a pending booking',
        tags: ['Bookings'],
        security: [{ ApiKeyAuth: [] }],
        params: R('BookingUidParam'),
        response: { 200: R('BookingRef'), 404: R('Error'), 409: R('Error') },
      },
    },
    async (req, reply) => {
      const uid = (req.params as { uid: string }).uid;
      return withIdempotency(req, reply, 'POST /v1/bookings/:uid/confirm', async (tx) => {
        const tenant = req.tenant!;
        // atomic state transition: only PENDING → CONFIRMED can win; a racing
        // cancel/confirm gets count=0 and a stable 409 instead of double-write
        const updated = await (async () => {
          const existing = await tx.booking.findFirst({
            where: { tenantId: tenant.id, uid },
            select: { id: true, status: true },
          });
          if (!existing) throw notFound('Booking');
          const claimed = await tx.booking.updateMany({
            where: { id: existing.id, tenantId: tenant.id, status: 'PENDING' },
            data: { status: 'CONFIRMED' },
          });
          if (claimed.count === 0) {
            throw conflict('NOT_PENDING', `Only PENDING bookings can be confirmed (current: ${existing.status}).`);
          }
          const row = await tx.booking.findUniqueOrThrow({ where: { id: existing.id }, include: bookingInclude });
          await enqueueWebhookEvent(tx, tenant.id, 'booking.confirmed', bookingWebhookPayload({
            uid: row.uid,
            tenantId: tenant.id,
            eventTypeId: row.eventTypeId,
            hostId: row.hostId,
            status: row.status,
            startsAt: row.startsAt,
            endsAt: row.endsAt,
          }));
          return row;
        })();
        return { status: 200, body: toJSON(bookingToResponse(updated)) };
      });
    },
  );

  // ───────────────────────────── cancel ─────────────────────────────
  fastify.post(
    '/bookings/:uid/cancel',
    {
      preHandler: requireScope('book'),
      schema: {
        summary: 'Cancel a booking (frees its seat)',
        tags: ['Bookings'],
        security: [{ ApiKeyAuth: [] }],
        params: R('BookingUidParam'),
        body: R('BookingCancelBody'),
        response: { 200: R('BookingRef'), 404: R('Error'), 409: R('Error') },
      },
    },
    async (req: CancelRequest, reply) => {
      const uid = (req.params as { uid: string }).uid;
      return withIdempotency(req, reply, 'POST /v1/bookings/:uid/cancel', async (tx) => {
        const tenant = req.tenant!;
        const updated = await (async () => {
          const booking = await tx.booking.findFirst({
            where: { tenantId: tenant.id, uid },
            select: { id: true, status: true, hostId: true, eventTypeId: true, startsAt: true },
          });
          if (!booking) throw notFound('Booking');
          // atomic transition: only an ACTIVE booking can be cancelled — a
          // racing cancel/confirm/reschedule re-checks inside this WHERE
          const claimed = await tx.booking.updateMany({
            where: {
              id: booking.id,
              tenantId: tenant.id,
              status: { in: ['PENDING', 'CONFIRMED'] },
              startsAt: booking.startsAt,
            },
            data: {
              status: 'CANCELLED',
              cancellationReason: req.body.reason ?? null,
              cancelledAt: new Date(),
            },
          });
          if (claimed.count === 0) {
            if (booking.status === 'CANCELLED') {
              throw conflict('ALREADY_CANCELLED', 'This booking is already cancelled.');
            }
            throw conflict('BOOKING_CHANGED', 'This booking was changed or cancelled. Fetch it and try again.');
          }
          const row = await tx.booking.findUniqueOrThrow({ where: { id: booking.id }, include: bookingInclude });
          await releaseSeat(tx, {
            hostId: booking.hostId,
            eventTypeId: booking.eventTypeId,
            start: booking.startsAt,
          });
          await enqueueWebhookEvent(tx, tenant.id, 'booking.cancelled', bookingWebhookPayload({
            uid: row.uid,
            tenantId: tenant.id,
            eventTypeId: row.eventTypeId,
            hostId: row.hostId,
            status: row.status,
            startsAt: row.startsAt,
            endsAt: row.endsAt,
            cancellationReason: row.cancellationReason,
          }));
          return row;
        })();
        return { status: 200, body: toJSON(bookingToResponse(updated)) };
      });
    },
  );

  // ─────────────────────────── reschedule ───────────────────────────
  fastify.post(
    '/bookings/:uid/reschedule',
    {
      preHandler: requireScope('book'),
      schema: {
        summary: 'Reschedule a booking to another available slot',
        tags: ['Bookings'],
        security: [{ ApiKeyAuth: [] }],
        params: R('BookingUidParam'),
        body: R('BookingRescheduleBody'),
        response: { 200: R('BookingRef'), 404: R('Error'), 409: R('Error'), 422: R('Error') },
      },
    },
    async (req: RescheduleRequest, reply) => {
      const uid = (req.params as { uid: string }).uid;
      return withIdempotency(req, reply, 'POST /v1/bookings/:uid/reschedule', async (tx) => {
        const tenant = req.tenant!;
        const booking = await tx.booking.findFirst({
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
          tx,
        });
        const seats = bookableSeats({
          timeZone: hostTimezone(booking.host, tenant),
          fromUtc: start,
          toUtc: end,
          eventTypeId: booking.eventType.id,
          weekly: engine.weekly,
          overrides: engine.overrides,
          busy: engine.busy,
          nowUtc: new Date(),
          startUtc: start,
          ...engineConfigFromEventType(booking.eventType),
        });
        if (seats === null) {
          throw unprocessable('SLOT_UNAVAILABLE', 'The requested start is not an available slot.');
        }

        const previousStart = booking.startsAt;
        const updated = await (async () => {
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${booking.hostId}, 0))`;
          // atomic guard: only an ACTIVE booking can be rescheduled — a racing
          // cancel re-checks here and turns the move into a stable 409
          const claimed = await tx.booking.updateMany({
            where: {
              id: booking.id,
              tenantId: tenant.id,
              status: { in: ['PENDING', 'CONFIRMED'] },
              startsAt: previousStart,
            },
            data: { startsAt: start, endsAt: end },
          });
          if (claimed.count === 0) {
            throw conflict('BOOKING_CHANGED', 'This booking was changed or cancelled. Fetch it and try again.');
          }
          await acquireSeat(tx, {
            tenantId: tenant.id,
            hostId: booking.hostId,
            eventType: {
              id: booking.eventType.id,
              durationMin: booking.eventType.durationMin,
              capacity: booking.eventType.capacity,
            },
            start,
            end,
          });
          const overlap = await bufferedOverlapCount(tx, {
            hostId: booking.hostId,
            eventTypeId: booking.eventType.id,
            startsAt: start,
            endsAt: end,
            bufferBeforeMin: booking.eventType.bufferBeforeMin,
            bufferAfterMin: booking.eventType.bufferAfterMin,
            excludeBookingId: booking.id,
          });
          if (overlap > 0) {
            throw conflict('SLOT_TAKEN', 'The requested slot has just been booked.');
          }
          const row = await tx.booking.findUniqueOrThrow({
            where: { id: booking.id },
            include: bookingInclude,
          });
          if (previousStart.getTime() !== start.getTime()) {
            await releaseSeat(tx, {
              hostId: booking.hostId,
              eventTypeId: booking.eventType.id,
              start: previousStart,
            });
          }
          await enqueueWebhookEvent(tx, tenant.id, 'booking.rescheduled', {
            ...bookingWebhookPayload({
              uid: row.uid,
              tenantId: tenant.id,
              eventTypeId: row.eventTypeId,
              hostId: row.hostId,
              status: row.status,
              startsAt: row.startsAt,
              endsAt: row.endsAt,
            }),
            previousStart: previousStart.toISOString(),
          });
          return row;
        })();

        return { status: 200, body: toJSON(bookingToResponse(updated)) };
      });
    },
  );
}
