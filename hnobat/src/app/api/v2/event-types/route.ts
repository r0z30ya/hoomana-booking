import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { handleApiError, success, Errors } from "@/lib/api/response";
import { requireAuth } from "@/lib/api/auth";
import { eventTypeCreateSchema } from "@/lib/api/validate";
import { slugify } from "@/lib/api/utils";

export const dynamic = "force-dynamic";

// GET /api/v2/event-types            -> authed: own event types (full detail)
// GET /api/v2/event-types?username=x -> public: visible event types of that user (booking-page parity)
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const username = searchParams.get("username");

    if (username) {
      const user = await db.user.findUnique({ where: { username } });
      if (!user) throw Errors.notFound("User");
      const eventTypes = await db.eventType.findMany({
        where: { userId: user.id, hidden: false },
        orderBy: [{ position: "asc" }, { id: "asc" }],
        select: { id: true, title: true, slug: true, description: true, length: true, price: true, currency: true, requiresConfirmation: true, seatsPerTimeSlot: true },
      });
      return success({ eventTypes: eventTypes.map((e) => ({ ...e, duration: e.length, host: { id: user.id, username: user.username, name: user.name } })) });
    }

    const auth = await requireAuth(request);
    const [owner, eventTypes] = await Promise.all([
      db.user.findUnique({ where: { id: auth.userId }, select: { id: true, username: true, name: true } }),
      db.eventType.findMany({
        where: { userId: auth.userId },
        orderBy: [{ position: "asc" }, { id: "asc" }],
        include: { schedule: { select: { id: true, name: true, timeZone: true } } },
      }),
    ]);
    return success({
      eventTypes: eventTypes.map((e) => ({
        id: e.id,
        title: e.title,
        slug: e.slug,
        description: e.description,
        duration: e.length,
        length: e.length,
        hidden: e.hidden,
        requiresConfirmation: e.requiresConfirmation,
        disableGuests: e.disableGuests,
        minimumBookingNotice: e.minimumBookingNotice,
        beforeBufferTime: e.beforeBufferTime,
        afterBufferTime: e.afterBufferTime,
        slotInterval: e.slotInterval,
        locations: JSON.parse(e.locations || "[]"),
        periodType: e.periodType,
        periodDays: e.periodDays,
        periodCountCalendarDays: e.periodCountCalendarDays,
        periodStartDate: e.periodStartDate?.toISOString() ?? null,
        periodEndDate: e.periodEndDate?.toISOString() ?? null,
        seatsPerTimeSlot: e.seatsPerTimeSlot,
        price: e.price,
        currency: e.currency,
        metadata: e.metadata ? JSON.parse(e.metadata) : null,
        timeZone: e.timeZone,
        schedule: e.schedule,
        users: owner ? [{ id: owner.id, username: owner.username, name: owner.name }] : [],
        bookingLink: `/${e.slug}`,
      })),
    });
  } catch (e) {
    return handleApiError(e, request);
  }
}

export async function POST(request: NextRequest) {
  try {
    const auth = await requireAuth(request);
    const input = eventTypeCreateSchema.parse(await request.json());

    if (input.scheduleId) {
      const schedule = await db.schedule.findFirst({ where: { id: input.scheduleId, userId: auth.userId } });
      if (!schedule) throw Errors.notFound("Schedule");
    }

    const slug = input.slug ?? slugify(input.title);
    const clash = await db.eventType.findUnique({ where: { userId_slug: { userId: auth.userId, slug } } });
    if (clash) throw Errors.conflict(`You already have an event type with slug "${slug}".`);

    const eventType = await db.eventType.create({
      data: {
        userId: auth.userId,
        title: input.title,
        slug,
        description: input.description,
        length: input.length,
        hidden: input.hidden,
        requiresConfirmation: input.requiresConfirmation,
        disableGuests: input.disableGuests,
        minimumBookingNotice: input.minimumBookingNotice,
        beforeBufferTime: input.beforeBufferTime,
        afterBufferTime: input.afterBufferTime,
        slotInterval: input.slotInterval,
        scheduleId: input.scheduleId,
        timeZone: input.timeZone,
        locations: input.locations ? JSON.stringify(input.locations) : "[]",
        periodType: input.periodType,
        periodDays: input.periodDays,
        periodCountCalendarDays: input.periodCountCalendarDays,
        periodStartDate: input.periodStartDate,
        periodEndDate: input.periodEndDate,
        seatsPerTimeSlot: input.seatsPerTimeSlot,
        price: input.price,
        currency: input.currency,
        metadata: input.metadata ? JSON.stringify(input.metadata) : null,
      },
    });

    return success({ eventType }, 201);
  } catch (e) {
    return handleApiError(e, request);
  }
}
