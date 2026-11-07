import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { handleApiError, success, Errors } from "@/lib/api/response";
import { requireAuth } from "@/lib/api/auth";
import { serializeBooking } from "@/lib/api/serialize";
import { dispatchWebhooks } from "@/lib/api/webhooks";
import { loadBookingByUid } from "@/lib/api/booking-access";

export const dynamic = "force-dynamic";

/** POST /api/v2/bookings/{uid}/confirm — host only. PENDING -> ACCEPTED, fires BOOKING_CONFIRMED. */
export async function POST(request: NextRequest, ctx: { params: Promise<{ uid: string }> }) {
  try {
    const { uid } = await ctx.params;
    const auth = await requireAuth(request);
    const booking = await loadBookingByUid(uid);
    if (!booking) throw Errors.notFound("Booking");
    if (booking.userId !== auth.userId) throw Errors.forbidden("Only the host can confirm this booking.");

    if (booking.status === "ACCEPTED") {
      return success({ booking: serializeBooking(booking) }); // idempotent
    }
    if (booking.status !== "PENDING") {
      throw Errors.conflict(`Only PENDING bookings can be confirmed (current status: ${booking.status}).`);
    }

    const updated = await db.booking.update({
      where: { id: booking.id },
      data: { status: "ACCEPTED" },
      include: {
        eventType: { select: { id: true, title: true, slug: true, length: true, requiresConfirmation: true } },
        user: { select: { id: true, username: true, name: true, email: true, timeZone: true } },
        attendees: true,
      },
    });

    const dto = serializeBooking(updated);
    await dispatchWebhooks(updated.userId ?? 0, "BOOKING_CONFIRMED", { booking: dto });
    return success({ booking: dto });
  } catch (e) {
    return handleApiError(e, request);
  }
}
