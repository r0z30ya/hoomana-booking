import { db } from "@/lib/db";
import type { AuthContext } from "./auth";

/** Loads a booking with everything the DTO and permission checks need. */
export async function loadBookingByUid(bookingUid: string) {
  return db.booking.findUnique({
    where: { uid: bookingUid },
    include: {
      eventType: { select: { id: true, title: true, slug: true, length: true, requiresConfirmation: true } },
      user: { select: { id: true, username: true, name: true, email: true, timeZone: true } },
      attendees: true,
    },
  });
}

/**
 * Booking management is limited to the authenticated host. Patient-facing
 * access must be authorized by Hoomana before a service call is made.
 */
export function canManageBooking(
  booking: { userId: number | null },
  auth: AuthContext | null,
  _attendeeEmail?: string | null,
): boolean {
  return auth !== null && booking.userId === auth.userId;
}
