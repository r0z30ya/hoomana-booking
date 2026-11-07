import { parseJsonSafe } from "./utils";

/**
 * Booking DTO shaped like cal.com API v2 booking responses.
 */
export function serializeBooking(booking: {
  id: number;
  uid: string;
  title: string;
  description: string | null;
  location: string | null;
  startTime: Date;
  endTime: Date;
  timeZone: string | null;
  status: string;
  metadata: string | null;
  responses: string | null;
  paid: boolean;
  rejectionReason: string | null;
  cancelledBy: string | null;
  rescheduledBy: string | null;
  rescheduled: string | null;
  fromReschedule: string | null;
  createdAt: Date;
  updatedAt: Date;
  eventType?: { id: number; title: string; slug: string; length: number; requiresConfirmation: boolean } | null;
  user?: { id: number; username: string; name: string | null; email: string; timeZone: string } | null;
  attendees?: { id: number; name: string; email: string | null; phone: string | null; timeZone: string; locale: string; noShow: boolean }[];
}) {
  return {
    id: booking.id,
    uid: booking.uid,
    title: booking.title,
    description: booking.description,
    location: booking.location,
    start: booking.startTime.toISOString(),
    end: booking.endTime.toISOString(),
    duration: Math.round((booking.endTime.getTime() - booking.startTime.getTime()) / 60_000),
    timeZone: booking.timeZone,
    status: booking.status,
    metadata: parseJsonSafe<Record<string, unknown> | null>(booking.metadata, null),
    responses: parseJsonSafe<Record<string, unknown> | null>(booking.responses, null),
    paid: booking.paid,
    rejectionReason: booking.rejectionReason,
    cancelledBy: booking.cancelledBy,
    rescheduledBy: booking.rescheduledBy,
    rescheduled: booking.rescheduled,
    fromReschedule: booking.fromReschedule,
    createdAt: booking.createdAt.toISOString(),
    updatedAt: booking.updatedAt.toISOString(),
    eventType: booking.eventType
      ? {
          id: booking.eventType.id,
          title: booking.eventType.title,
          slug: booking.eventType.slug,
          duration: booking.eventType.length,
          requiresConfirmation: booking.eventType.requiresConfirmation,
        }
      : null,
    host: booking.user
      ? {
          id: booking.user.id,
          username: booking.user.username,
          name: booking.user.name,
          email: booking.user.email,
          timeZone: booking.user.timeZone,
        }
      : null,
    attendees: (booking.attendees ?? []).map((a) => ({
      id: a.id,
      name: a.name,
      email: a.email,
      phone: a.phone,
      timeZone: a.timeZone,
      locale: a.locale,
      noShow: a.noShow,
    })),
  };
}

/** Availability DTO — cal.com returns dates/ISO strings for availability rows. */
export function serializeAvailability(rows: { id: number; days: string; startTime: Date; endTime: Date; date: Date | null }[]) {
  return rows.map((r) => ({
    id: r.id,
    days: parseJsonSafe<number[]>(r.days, []),
    startTime: r.startTime.toISOString(),
    endTime: r.endTime.toISOString(),
    date: r.date ? r.date.toISOString() : null,
  }));
}
