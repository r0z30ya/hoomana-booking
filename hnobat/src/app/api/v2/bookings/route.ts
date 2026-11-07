import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { handleApiError, success, Errors } from "@/lib/api/response";
import { requireAuth } from "@/lib/api/auth";
import { bookingCreateSchema, bookingListQuerySchema } from "@/lib/api/validate";
import { uid } from "@/lib/api/utils";
import { serializeBooking } from "@/lib/api/serialize";
import { dispatchWebhooks } from "@/lib/api/webhooks";
import { loadSchedulableEventType, validateSlotForBooking } from "@/lib/api/slot-engine";

export const dynamic = "force-dynamic";

/**
 * GET /api/v2/bookings — host's bookings (auth required), cal.com v2 parity:
 *   ?status=upcoming|past|cancelled|unconfirmed|all&eventTypeId=&take=&skip=
 *
 * POST /api/v2/bookings — public booking creation (like cal.com's booking page):
 *   { start, eventTypeId | username+eventTypeSlug, attendee: { name, email, timeZone }, ... }
 */
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const input = bookingListQuerySchema.parse(Object.fromEntries(searchParams.entries()));
    const auth = await requireAuth(request);

    const now = new Date();
    const statusFilter =
      input.status === "upcoming"
        ? { startTime: { gte: now }, status: { in: ["ACCEPTED", "PENDING"] } }
        : input.status === "past"
          ? { startTime: { lt: now }, status: { in: ["ACCEPTED", "PENDING"] } }
          : input.status === "cancelled"
            ? { status: "CANCELLED" }
            : input.status === "unconfirmed"
              ? { status: "PENDING" }
              : {};

    const where = {
      userId: auth.userId,
      ...statusFilter,
      ...(input.eventTypeId ? { eventTypeId: input.eventTypeId } : {}),
    };

    const [total, bookings] = await Promise.all([
      db.booking.count({ where }),
      db.booking.findMany({
        where,
        orderBy: { startTime: input.status === "past" ? "desc" : "asc" },
        take: input.take,
        skip: input.skip,
        include: {
          eventType: { select: { id: true, title: true, slug: true, length: true, requiresConfirmation: true } },
          user: { select: { id: true, username: true, name: true, email: true, timeZone: true } },
          attendees: true,
        },
      }),
    ]);

    return success({
      bookings: bookings.map(serializeBooking),
      pagination: { total, take: input.take, skip: input.skip },
    });
  } catch (e) {
    return handleApiError(e, request);
  }
}

export async function POST(request: NextRequest) {
  try {
    const auth = await requireAuth(request);
    const input = bookingCreateSchema.parse(await request.json());

    // resolve the event type (public booking-page parity: id, or username + slug)
    let eventTypeId = input.eventTypeId;
    if (!eventTypeId && input.username && input.eventTypeSlug) {
      const host = await db.user.findUnique({ where: { username: input.username } });
      if (!host) throw Errors.notFound("User");
      const bySlug = await db.eventType.findUnique({
        where: { userId_slug: { userId: host.id, slug: input.eventTypeSlug } },
      });
      if (!bySlug) throw Errors.notFound("EventType");
      eventTypeId = bySlug.id;
    }
    if (!eventTypeId) throw Errors.badRequest("Provide either `eventTypeId` or both `username` and `eventTypeSlug`.");

    const eventType = await loadSchedulableEventType(eventTypeId);
    if (!eventType) throw Errors.notFound("EventType");

    if (eventType.userId !== auth.userId) throw Errors.forbidden();

    const start = input.start;
    const booking = await db.$transaction(async (tx) => {
      // SQLite obtains its write lock before checking availability, serializing competing writers.
      await tx.$executeRaw`UPDATE "User" SET "id" = "id" WHERE "id" = ${eventType.userId}`;
      const current = await loadSchedulableEventType(eventTypeId!, tx);
      if (!current || current.userId !== auth.userId) throw Errors.forbidden();
      await validateSlotForBooking(current, input.start, tx);
      const end = new Date(start.getTime() + current.length * 60_000);
      const status = current.requiresConfirmation ? "PENDING" : "ACCEPTED";
      return tx.booking.create({
      data: {
        uid: uid(),
        eventTypeId: current.id,
        userId: current.userId,
        title: `${input.attendee.name} & ${current.user.name ?? current.user.username}`,
        description: null,
        location: input.location,
        startTime: start,
        endTime: end,
        timeZone: input.attendee.timeZone,
        status,
        metadata: input.metadata ? JSON.stringify(input.metadata) : null,
        responses: input.bookingFieldsResponses ? JSON.stringify(input.bookingFieldsResponses) : null,
        attendees: {
          create: [
            {
              name: input.attendee.name,
              email: input.attendee.email?.toLowerCase() ?? null,
              phone: input.attendee.phone ?? null,
              timeZone: input.attendee.timeZone ?? "Etc/UTC",
              locale: input.attendee.language ?? "en",
            },
            ...(input.guests ?? []).map((g) => ({
              name: g.split("@")[0],
              email: g.toLowerCase(),
              timeZone: input.attendee.timeZone ?? "Etc/UTC",
              locale: input.attendee.language ?? "en",
            })),
          ],
        },
      },
      include: {
        eventType: { select: { id: true, title: true, slug: true, length: true, requiresConfirmation: true } },
        user: { select: { id: true, username: true, name: true, email: true, timeZone: true } },
        attendees: true,
      },
      });
    }, { timeout: 15000 });

    const dto = serializeBooking(booking);

    // cal.com webhook parity
    await dispatchWebhooks(eventType.userId, booking.status === "PENDING" ? "BOOKING_REQUESTED" : "BOOKING_CREATED", {
      booking: dto,
      booker: { userId: auth.userId },
    });

    return success({ booking: dto }, 201);
  } catch (e) {
    return handleApiError(e, request);
  }
}
