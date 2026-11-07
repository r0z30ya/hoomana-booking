import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { handleApiError, success, Errors } from "@/lib/api/response";
import { requireAuth } from "@/lib/api/auth";
import { serializeBooking } from "@/lib/api/serialize";
import { dispatchWebhooks } from "@/lib/api/webhooks";
import { loadBookingByUid } from "@/lib/api/booking-access";

export const dynamic = "force-dynamic";

/** POST /api/v2/bookings/{uid}/decline — host only. PENDING -> REJECTED, fires BOOKING_REJECTED. */
export async function POST(request: NextRequest, ctx: { params: Promise<{ uid: string }> }) {
  try {
    const { uid } = await ctx.params;
    const auth = await requireAuth(request);
    const booking = await loadBookingByUid(uid);
    if (!booking) throw Errors.notFound("Booking");
    if (booking.userId !== auth.userId) throw Errors.forbidden("Only the host can decline this booking.");

    if (booking.status === "REJECTED") {
      return success({ booking: serializeBooking(booking) }); // idempotent
    }
    if (booking.status !== "PENDING") {
      throw Errors.conflict(`Only PENDING bookings can be declined (current status: ${booking.status}).`);
    }

    let rejectionReason: string | null = null;
    try {
      const body = await request.json();
      rejectionReason = typeof body?.reason === "string" ? body.reason : null;
    } catch {
      rejectionReason = null;
    }

    const updated = await db.booking.update({
      where: { id: booking.id },
      data: { status: "REJECTED", rejectionReason },
      include: {
        eventType: { select: { id: true, title: true, slug: true, length: true, requiresConfirmation: true } },
        user: { select: { id: true, username: true, name: true, email: true, timeZone: true } },
        attendees: true,
      },
    });

    const dto = serializeBooking(updated);
    await dispatchWebhooks(updated.userId ?? 0, "BOOKING_REJECTED", { booking: dto });
    return success({ booking: dto });
  } catch (e) {
    return handleApiError(e, request);
  }
}
