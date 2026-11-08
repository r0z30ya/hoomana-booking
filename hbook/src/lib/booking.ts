/**
 * hbook — booking service helpers.
 * Loads everything the slot engine needs in parallel (3 queries, no N+1)
 * and maps DB rows into engine structures.
 */
import type { EventType, Tenant, User } from '@prisma/client';
import { prisma } from './prisma';
import type { BusyInterval, DateOverrideRule } from './slots';
import type { AvailabilityWindow } from './time';

export interface EngineConfig {
  durationMin: number;
  slotIntervalMin: number;
  bufferBeforeMin: number;
  bufferAfterMin: number;
  minLeadMinutes: number;
  maxLeadDays: number;
}

export interface LoadedEngineInput {
  weekly: Map<number, AvailabilityWindow[]>;
  overrides: Map<string, DateOverrideRule>;
  busy: BusyInterval[];
}

export function engineConfigFromEventType(eventType: EventType): EngineConfig {
  return {
    durationMin: eventType.durationMin,
    slotIntervalMin: eventType.slotIntervalMin,
    bufferBeforeMin: eventType.bufferBeforeMin,
    bufferAfterMin: eventType.bufferAfterMin,
    minLeadMinutes: eventType.minLeadMinutes,
    maxLeadDays: eventType.maxLeadDays,
  };
}

/** 3 parallel queries: weekly availability, date overrides, busy bookings. */
export async function loadEngineInput(opts: {
  hostId: string;
  fromUtc: Date;
  toUtc: Date;
  excludeBookingId?: string;
}): Promise<LoadedEngineInput> {
  const [availabilityRows, overrideRows, busyRows] = await Promise.all([
    prisma.availability.findMany({
      where: { userId: opts.hostId },
      select: { weekday: true, startMinute: true, endMinute: true },
      orderBy: [{ weekday: 'asc' }, { startMinute: 'asc' }],
    }),
    prisma.dateOverride.findMany({
      where: { userId: opts.hostId },
      select: { date: true, isClosed: true, startMinute: true, endMinute: true },
    }),
    prisma.booking.findMany({
      where: {
        hostId: opts.hostId,
        status: { in: ['PENDING', 'CONFIRMED'] },
        startsAt: { lt: opts.toUtc },
        endsAt: { gt: opts.fromUtc },
        ...(opts.excludeBookingId ? { id: { not: opts.excludeBookingId } } : {}),
      },
      select: { startsAt: true, endsAt: true },
    }),
  ]);

  const weekly = new Map<number, AvailabilityWindow[]>();
  for (const row of availabilityRows) {
    const list = weekly.get(row.weekday) ?? [];
    list.push({ startMinute: row.startMinute, endMinute: row.endMinute });
    weekly.set(row.weekday, list);
  }

  const overrides = new Map<string, DateOverrideRule>();
  for (const row of overrideRows) {
    const dateKey = row.date.toISOString().slice(0, 10); // @db.Date is UTC midnight
    overrides.set(dateKey, {
      dateKey,
      closed: row.isClosed,
      windows:
        !row.isClosed && row.startMinute !== null && row.endMinute !== null
          ? [{ startMinute: row.startMinute, endMinute: row.endMinute }]
          : [],
    });
  }

  const busy: BusyInterval[] = busyRows.map((b) => ({ startsAt: b.startsAt, endsAt: b.endsAt }));

  return { weekly, overrides, busy };
}

/** Resolve the timezone a host's availability lives in. */
export function hostTimezone(host: Pick<User, 'timezone'>, tenant: Pick<Tenant, 'timezone'>): string {
  return host.timezone || tenant.timezone;
}

/** Safe webhook payload for a booking (no internal ids of other tenants etc.). */
export function bookingWebhookPayload(booking: {
  uid: string;
  tenantId: string;
  eventTypeId: string;
  hostId: string;
  status: string;
  startsAt: Date;
  endsAt: Date;
  attendeeName: string;
  attendeeEmail: string;
  attendeePhone: string | null;
  attendeeTimezone: string | null;
  cancellationReason?: string | null;
}) {
  return {
    uid: booking.uid,
    tenantId: booking.tenantId,
    eventTypeId: booking.eventTypeId,
    hostId: booking.hostId,
    status: booking.status,
    startsAt: booking.startsAt.toISOString(),
    endsAt: booking.endsAt.toISOString(),
    attendee: {
      name: booking.attendeeName,
      email: booking.attendeeEmail,
      phone: booking.attendeePhone,
      timezone: booking.attendeeTimezone,
    },
    ...(booking.cancellationReason !== undefined ? { cancellationReason: booking.cancellationReason } : {}),
  };
}
