import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { handleApiError, success, Errors } from "@/lib/api/response";
import { getAuth } from "@/lib/api/auth";
import { bookingRescheduleSchema } from "@/lib/api/validate";
import { serializeBooking } from "@/lib/api/serialize";
import { dispatchWebhooks } from "@/lib/api/webhooks";
import { loadBookingByUid, canManageBooking } from "@/lib/api/booking-access";
import { loadSchedulableEventType, validateSlotForBooking } from "@/lib/api/slot-engine";

export const dynamic = "force-dynamic";

/**
 * POST /api/v2/bookings/{uid}/reschedule — authenticated host (JWT/API key).
 * Body: { start: ISO, email? }
 * The booking keeps its uid (cal.com updates the same booking and fires BOOKING_RESCHEDULED).
 */
export async function POST(request: NextRequest, ctx: { params: Promise<{ uid: string }> }) {
  try {
    const { uid } = await ctx.params;
    const booking = await loadBookingByUid(uid);
    if (!booking) throw Errors.notFound("Booking");

    const input = bookingRescheduleSchema.parse(await request.json());
    const auth = await getAuth(request);

    if (!canManageBooking(booking, auth, input.email)) {
      throw Errors.forbidden("Only the authenticated host can reschedule this booking.");
    }
    if (booking.status === "CANCELLED") throw Errors.conflict("Cancelled bookings cannot be rescheduled. Create a new booking.");
    if (booking.status === "REJECTED") throw Errors.conflict("Rejected bookings cannot be rescheduled.");
    if (!booking.eventTypeId) throw Errors.badRequest("This booking has no linked event type.");

    const updated = await db.$transaction(async (tx) => {
      await tx.$executeRaw`UPDATE "User" SET "id" = "id" WHERE "id" = ${booking.userId}`;
      const current = await tx.booking.findUnique({ where: { id: booking.id } });
      if (!current || current.userId !== auth?.userId) throw Errors.forbidden();
      if (current.status === "CANCELLED" || current.status === "REJECTED") throw Errors.conflict("This booking cannot be rescheduled.");
      if (!current.eventTypeId) throw Errors.badRequest("This booking has no linked event type.");
      const eventType = await loadSchedulableEventType(current.eventTypeId, tx);
      if (!eventType || eventType.userId !== current.userId) throw Errors.notFound("EventType");
      await validateSlotForBooking(eventType, input.start, tx, current.id);
      return tx.booking.update({
        where: { id: current.id },
        data: {
          startTime: input.start,
          endTime: new Date(input.start.getTime() + eventType.length * 60_000),
          status: current.status === "PENDING" ? "PENDING" : "ACCEPTED",
          rescheduledBy: `host:${auth!.userId}`,
        },
        include: {
          eventType: { select: { id: true, title: true, slug: true, length: true, requiresConfirmation: true } },
          user: { select: { id: true, username: true, name: true, email: true, timeZone: true } },
          attendees: true,
        },
      });
    }, { timeout: 15000 });

    const dto = serializeBooking(updated);
    await dispatchWebhooks(updated.userId ?? 0, "BOOKING_RESCHEDULED", {
      booking: dto,
      previousStart: booking.startTime.toISOString(),
      rescheduledBy: updated.rescheduledBy,
    });
    return success({ booking: dto });
  } catch (e) {
    return handleApiError(e, request);
  }
}
