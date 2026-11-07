import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { handleApiError, success, Errors } from "@/lib/api/response";
import { getAuth } from "@/lib/api/auth";
import { bookingCancelSchema } from "@/lib/api/validate";
import { serializeBooking } from "@/lib/api/serialize";
import { dispatchWebhooks } from "@/lib/api/webhooks";
import { canManageBooking, loadBookingByUid } from "@/lib/api/booking-access";

export const dynamic = "force-dynamic";

/**
 * POST /api/v2/bookings/{uid}/cancel — authenticated host (JWT/API key).
 * Body: { reason?, cancelledBy?, email? }
 */
export async function POST(request: NextRequest, ctx: { params: Promise<{ uid: string }> }) {
  try {
    const { uid } = await ctx.params;
    const booking = await loadBookingByUid(uid);
    if (!booking) throw Errors.notFound("Booking");

    const input = bookingCancelSchema.parse(await request.json().catch(() => ({})));
    const auth = await getAuth(request);

    if (!canManageBooking(booking, auth, input.email)) {
      throw Errors.forbidden("Only the authenticated host can cancel this booking.");
    }
    if (booking.status === "CANCELLED") throw Errors.conflict("This booking is already cancelled.");

    const cancelledBy = input.cancelledBy ?? (auth ? `host:${auth.userId}` : input.email ?? "unknown");

    const updated = await db.booking.update({
      where: { id: booking.id },
      data: { status: "CANCELLED", cancelledBy, rejectionReason: input.reason ?? null },
      include: {
        eventType: { select: { id: true, title: true, slug: true, length: true, requiresConfirmation: true } },
        user: { select: { id: true, username: true, name: true, email: true, timeZone: true } },
        attendees: true,
      },
    });

    const dto = serializeBooking(updated);
    await dispatchWebhooks(updated.userId ?? booking.userId ?? 0, "BOOKING_CANCELLED", { booking: dto });
    return success({ booking: dto });
  } catch (e) {
    return handleApiError(e, request);
  }
}
