/**
 * hbook — booking service helpers.
 * Loads everything the slot engine needs in parallel (3 queries, no N+1)
 * and maps DB rows into engine structures.
 */
import type { EventType, Prisma, Tenant, User } from '@prisma/client';
import { prisma } from './prisma';
import type { BusyInterval, DateOverrideRule } from './slots';
import type { AvailabilityWindow } from './time';

export interface EngineConfig {
  durationMin: number;
  slotIntervalMin: number;
  capacity: number;
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
    capacity: Math.max(1, eventType.capacity ?? 1),
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
  tx?: Prisma.TransactionClient;
}): Promise<LoadedEngineInput> {
  const db = opts.tx ?? prisma;
  const [availabilityRows, overrideRows, busyRows] = await Promise.all([
    db.availability.findMany({
      where: { userId: opts.hostId },
      select: { weekday: true, startMinute: true, endMinute: true },
      orderBy: [{ weekday: 'asc' }, { startMinute: 'asc' }],
    }),
    db.dateOverride.findMany({
      where: { userId: opts.hostId },
      select: { date: true, isClosed: true, startMinute: true, endMinute: true },
    }),
    db.booking.findMany({
      where: {
        hostId: opts.hostId,
        status: { in: ['PENDING', 'CONFIRMED'] },
        startsAt: { lt: new Date(opts.toUtc.getTime() + 480 * 60_000) },
        endsAt: { gt: new Date(opts.fromUtc.getTime() - 480 * 60_000) },
        ...(opts.excludeBookingId ? { id: { not: opts.excludeBookingId } } : {}),
      },
      select: {
        startsAt: true,
        endsAt: true,
        eventTypeId: true,
        eventType: { select: { bufferBeforeMin: true, bufferAfterMin: true } },
      },
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

  const busy: BusyInterval[] = busyRows.map((b) => ({
    startsAt: b.startsAt,
    endsAt: b.endsAt,
    eventTypeId: b.eventTypeId,
    bufferBeforeMin: b.eventType.bufferBeforeMin,
    bufferAfterMin: b.eventType.bufferAfterMin,
  }));

  return { weekly, overrides, busy };
}

/** Resolve the timezone a host's availability lives in. */
export function hostTimezone(host: Pick<User, 'timezone'>, tenant: Pick<Tenant, 'timezone'>): string {
  return host.timezone || tenant.timezone;
}

/**
 * Minimal webhook payload — identifiers, times, status only.
 * Patient PII (name / phone / email / notes) is intentionally NOT included:
 * the platform (Homana) that created the booking already owns that data.
 */
export function bookingWebhookPayload(booking: {
  uid: string;
  tenantId: string;
  eventTypeId: string;
  hostId: string;
  status: string;
  startsAt: Date;
  endsAt: Date;
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
    ...(booking.cancellationReason !== undefined ? { cancellationReason: booking.cancellationReason } : {}),
  };
}
