import { NextRequest } from "next/server";
import { handleApiError, success, Errors } from "@/lib/api/response";
import { getAuth } from "@/lib/api/auth";
import { serializeBooking } from "@/lib/api/serialize";
import { loadBookingByUid } from "@/lib/api/booking-access";

export const dynamic = "force-dynamic";

/** Booking details are available only to the authenticated host. */
export async function GET(request: NextRequest, ctx: { params: Promise<{ uid: string }> }) {
  try {
    const { uid } = await ctx.params;
    const booking = await loadBookingByUid(uid);
    if (!booking) throw Errors.notFound("Booking");

    const auth = await getAuth(request);
    if (!auth) throw Errors.unauthorized();
    if (auth.userId !== booking.userId) throw Errors.forbidden();
    return success({ booking: serializeBooking(booking) });
  } catch (e) {
    return handleApiError(e, request);
  }
}
