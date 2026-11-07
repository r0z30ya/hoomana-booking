import { fromZonedTime, formatInTimeZone } from "date-fns-tz";
import { db } from "@/lib/db";
import type { Prisma } from "@prisma/client";

type Database = Prisma.TransactionClient;
import { Errors } from "./response";
import { utcHhMm } from "./utils";

/**
 * hnobat slot engine — a faithful re-implementation of the core of
 * cal.com's availability math (packages/core/getSchedule.ts + getWorkingHours):
 *
 *  1. Working hours come from the event type's schedule (or the host's default
 *     schedule), interpreted wall-clock in the schedule timezone — availability
 *     times are stored on the 1970-01-01 epoch date exactly like cal.com.
 *  2. Date overrides (availability rows with `date` set) replace the weekly
 *     rows for that specific local date.
 *  3. Busy intervals = host's existing bookings with status PENDING/ACCEPTED,
 *     extended by the event type's before/after buffer times.
 *  4. Free intervals = working hours minus busy, minus
 *     minimumBookingNotice, clamped by periodType (UNLIMITED/ROLLING/RANGE).
 *  5. Slots step from the start of each working interval by
 *     `slotInterval ?? length` minutes and must fully fit the interval.
 *  6. Booking validation requires an exact match against a generated slot
 *     (same strictness as cal.com's create-booking availability check).
 */

export interface Interval {
  start: Date;
  end: Date;
}

export interface AvailabilityRow {
  days: string; // JSON array of weekdays 0(Sun)..6(Sat)
  startTime: Date;
  endTime: Date;
  date: Date | null;
}

export interface SchedulableEventType {
  id: number;
  userId: number;
  length: number;
  requiresConfirmation: boolean;
  timeZone: string | null;
  slotInterval: number | null;
  minimumBookingNotice: number;
  beforeBufferTime: number;
  afterBufferTime: number;
  periodType: string;
  periodDays: number | null;
  periodCountCalendarDays: boolean | null;
  periodStartDate: Date | null;
  periodEndDate: Date | null;
  seatsPerTimeSlot: number | null;
  schedule: { timeZone: string | null; availability: AvailabilityRow[] } | null;
  user: { defaultScheduleId: number | null; name: string | null; username: string };
}

// ---------- interval math ----------

export function subtractIntervals(working: Interval[], busy: Interval[]): Interval[] {
  const result: Interval[] = [];
  for (const w of working) {
    let pieces: Interval[] = [w];
    for (const b of busy) {
      const next: Interval[] = [];
      for (const p of pieces) {
        if (b.end <= p.start || b.start >= p.end) {
          next.push(p);
          continue;
        }
        if (b.start > p.start) next.push({ start: p.start, end: b.start });
        if (b.end < p.end) next.push({ start: b.end, end: p.end });
      }
      pieces = next;
    }
    result.push(...pieces);
  }
  return result.filter((i) => i.end.getTime() > i.start.getTime());
}

function mergeIntervals(intervals: Interval[]): Interval[] {
  const sorted = [...intervals].sort((a, b) => a.start.getTime() - b.start.getTime());
  const merged: Interval[] = [];
  for (const i of sorted) {
    const last = merged[merged.length - 1];
    if (last && i.start <= last.end) last.end = new Date(Math.max(last.end.getTime(), i.end.getTime()));
    else merged.push({ ...i });
  }
  return merged;
}

// ---------- helpers ----------

function jsonDays(days: string): number[] {
  try {
    const parsed = JSON.parse(days);
    return Array.isArray(parsed) ? parsed.map(Number).filter((n) => Number.isInteger(n) && n >= 0 && n <= 6) : [];
  } catch {
    return [];
  }
}

function weekdayOfDateStr(dateStr: string): number {
  return new Date(`${dateStr}T12:00:00Z`).getUTCDay();
}

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function wallTimeToInterval(dateStr: string, hhMm: string, tz: string, isEnd: boolean): Date {
  if (isEnd && hhMm === "00:00") {
    // "00:00" as an end time means end-of-day (24:00), like cal.com's midnight end
    const next = new Date(`${dateStr}T00:00:00Z`);
    next.setUTCDate(next.getUTCDate() + 1);
    return fromZonedTime(`${next.toISOString().slice(0, 10)}T00:00:00`, tz);
  }
  return fromZonedTime(`${dateStr}T${hhMm}:00`, tz);
}

function workingIntervalsForDate(dateStr: string, tz: string, rows: AvailabilityRow[]): Interval[] {
  const overrides = rows.filter((r) => r.date && isoDate(r.date) === dateStr);
  let applicable: AvailabilityRow[];
  if (overrides.length > 0) {
    applicable = overrides; // date override replaces the weekly rows entirely
  } else {
    const weekday = weekdayOfDateStr(dateStr);
    applicable = rows.filter((r) => !r.date && jsonDays(r.days).includes(weekday));
  }
  const intervals: Interval[] = [];
  for (const row of applicable) {
    const start = wallTimeToInterval(dateStr, utcHhMm(row.startTime), tz, false);
    const end = wallTimeToInterval(dateStr, utcHhMm(row.endTime), tz, true);
    if (end.getTime() > start.getTime()) intervals.push({ start, end });
  }
  return intervals;
}

async function getScheduleWithAvailability(eventType: SchedulableEventType, client: Database = db) {
  if (eventType.schedule) return eventType.schedule;
  // cal.com fallback: event types without an explicit schedule use the host's default schedule
  const defaultScheduleId =
    eventType.user.defaultScheduleId ??
    (await client.schedule.findFirst({ where: { userId: eventType.userId }, select: { id: true } }))?.id;
  if (!defaultScheduleId) return null;
  return client.schedule.findUnique({ where: { id: defaultScheduleId }, include: { availability: true } });
}

async function getBusyIntervals(eventType: SchedulableEventType, rangeStart: Date, rangeEnd: Date, client: Database = db, excludeBookingId?: number): Promise<Interval[]> {
  // Shared (seats) event types do not block their own slot — capacity is counted separately
  const notSameEvent = eventType.seatsPerTimeSlot ? { eventTypeId: { not: eventType.id } } : {};
  const bookings = await client.booking.findMany({
    where: {
      userId: eventType.userId,
      ...(excludeBookingId ? { id: { not: excludeBookingId } } : {}),
      status: { in: ["ACCEPTED", "PENDING"] },
      startTime: { lte: new Date(rangeEnd.getTime() + eventType.beforeBufferTime * 60_000) },
      endTime: { gte: new Date(rangeStart.getTime() - eventType.afterBufferTime * 60_000) },
      ...notSameEvent,
    },
    select: { startTime: true, endTime: true },
  });
  return bookings.map((b) => ({
    start: new Date(b.startTime.getTime() - eventType.beforeBufferTime * 60_000),
    end: new Date(b.endTime.getTime() + eventType.afterBufferTime * 60_000),
  }));
}

function clampToPeriod(eventType: SchedulableEventType, intervals: Interval[], now: Date): Interval[] {
  const periodType = eventType.periodType ?? "UNLIMITED";
  let allowedFrom = new Date(0);
  let allowedTo = new Date(8640000000000000); // max date

  if (periodType === "ROLLING" && eventType.periodDays && eventType.periodDays > 0) {
    allowedFrom = now;
    if (eventType.periodCountCalendarDays) {
      allowedTo = new Date(now.getTime() + eventType.periodDays * 86_400_000);
      allowedTo = new Date(allowedTo.setUTCHours(23, 59, 59, 999));
    } else {
      // business days: skip Saturday/Sunday (JS weekday 0/6), like cal.com
      let remaining = eventType.periodDays;
      const cursor = new Date(now.getTime());
      let lastDay: Date | null = null;
      while (remaining > 0) {
        const wd = cursor.getUTCDay();
        if (wd !== 0 && wd !== 6) {
          remaining--;
          lastDay = new Date(cursor.getTime());
        }
        cursor.setUTCDate(cursor.getUTCDate() + 1);
      }
      allowedTo = lastDay ? new Date(lastDay.setUTCHours(23, 59, 59, 999)) : now;
    }
  } else if (periodType === "RANGE") {
    allowedFrom = eventType.periodStartDate ?? allowedFrom;
    allowedTo = eventType.periodEndDate ?? allowedTo;
  }

  return intervals
    .map((i) => ({
      start: new Date(Math.max(i.start.getTime(), allowedFrom.getTime())),
      end: new Date(Math.min(i.end.getTime(), allowedTo.getTime())),
    }))
    .filter((i) => i.end.getTime() > i.start.getTime());
}

// ---------- core public API ----------

export async function getFreeIntervals(
  eventType: SchedulableEventType,
  rangeStart: Date,
  rangeEnd: Date,
  client: Database = db,
  excludeBookingId?: number,
): Promise<Interval[]> {
  const schedule = await getScheduleWithAvailability(eventType, client);
  if (!schedule || schedule.availability.length === 0) return [];

  const tz = eventType.timeZone || schedule.timeZone || "Etc/UTC";
  const now = new Date();

  // iterate over every local calendar date touched by the requested range
  const startDateStr = formatInTimeZone(rangeStart, tz, "yyyy-MM-dd");
  const endDateStr = formatInTimeZone(rangeEnd, tz, "yyyy-MM-dd");

  const working: Interval[] = [];
  let cursor = new Date(`${startDateStr}T00:00:00Z`);
  const endCursor = new Date(`${endDateStr}T00:00:00Z`);
  while (cursor.getTime() <= endCursor.getTime()) {
    const dateStr = cursor.toISOString().slice(0, 10);
    working.push(...workingIntervalsForDate(dateStr, tz, schedule.availability));
    cursor = new Date(cursor.getTime() + 86_400_000);
  }

  // clamp to requested range
  const clampedWorking = working
    .map((i) => ({
      start: new Date(Math.max(i.start.getTime(), rangeStart.getTime())),
      end: new Date(Math.min(i.end.getTime(), rangeEnd.getTime())),
    }))
    .filter((i) => i.end.getTime() > i.start.getTime());

  const busy = await getBusyIntervals(eventType, rangeStart, rangeEnd, client, excludeBookingId);
  let free = subtractIntervals(clampedWorking, mergeIntervals(busy));

  // minimumBookingNotice — cannot book sooner than N minutes from now
  const noticeStart = new Date(now.getTime() + eventType.minimumBookingNotice * 60_000);
  free = free
    .map((i) => ({ start: new Date(Math.max(i.start.getTime(), noticeStart.getTime())), end: i.end }))
    .filter((i) => i.end.getTime() > i.start.getTime());

  free = clampToPeriod(eventType, free, now);
  return mergeIntervals(free);
}

export interface SlotDto {
  time: string; // slot start in the target timezone, ISO-8601 with offset
  utc: string; // slot start in UTC
  seatsLeft?: number;
}

export async function getAvailableSlots(
  eventType: SchedulableEventType,
  rangeStart: Date,
  rangeEnd: Date,
  targetTz: string,
  client: Database = db,
  excludeBookingId?: number,
): Promise<Record<string, SlotDto[]>> {
  const free = await getFreeIntervals(eventType, rangeStart, rangeEnd, client, excludeBookingId);
  const schedule = await getScheduleWithAvailability(eventType, client);
  if (!schedule) return {};
  const scheduleTz = eventType.timeZone || schedule.timeZone || "Etc/UTC";
  const stepMin = eventType.slotInterval || eventType.length;
  const lengthMs = eventType.length * 60_000;
  const stepMs = stepMin * 60_000;

  const grouped: Record<string, SlotDto[]> = {};
  const seen = new Set<string>();
  for (const interval of free) {
    const firstDate = formatInTimeZone(interval.start, scheduleTz, "yyyy-MM-dd");
    const lastDate = formatInTimeZone(interval.end, scheduleTz, "yyyy-MM-dd");
    let day = new Date(`${firstDate}T00:00:00Z`);
    const lastDay = new Date(`${lastDate}T00:00:00Z`);
    while (day <= lastDay) {
      for (const working of workingIntervalsForDate(day.toISOString().slice(0, 10), scheduleTz, schedule.availability)) {
        const earliest = Math.max(interval.start.getTime(), working.start.getTime());
        const latest = Math.min(interval.end.getTime(), working.end.getTime());
        const offset = Math.max(0, Math.ceil((earliest - working.start.getTime()) / stepMs));
        for (let time = working.start.getTime() + offset * stepMs; time + lengthMs <= latest; time += stepMs) {
          const cursor = new Date(time);
          const utc = cursor.toISOString();
          if (seen.has(utc)) continue;
          const slot: SlotDto = { time: formatInTimeZone(cursor, targetTz, "yyyy-MM-dd'T'HH:mm:ssXXX"), utc };
          if (eventType.seatsPerTimeSlot) {
            slot.seatsLeft = await getSeatsLeft(eventType, cursor, client, excludeBookingId);
            if (slot.seatsLeft <= 0) continue;
          }
          seen.add(utc);
          const dateKey = formatInTimeZone(cursor, targetTz, "yyyy-MM-dd");
          (grouped[dateKey] ||= []).push(slot);
        }
      }
      day.setUTCDate(day.getUTCDate() + 1);
    }
  }
  for (const key of Object.keys(grouped)) {
    grouped[key].sort((a, b) => a.utc.localeCompare(b.utc));
  }
  return grouped;
}

async function getSeatsLeft(eventType: SchedulableEventType, slotStart: Date, client: Database = db, excludeBookingId?: number): Promise<number> {
  const slotEnd = new Date(slotStart.getTime() + eventType.length * 60_000);
  const taken = await client.booking.count({
    where: {
      eventTypeId: eventType.id,
      ...(excludeBookingId ? { id: { not: excludeBookingId } } : {}),
      status: { in: ["ACCEPTED", "PENDING"] },
      startTime: { lt: slotEnd },
      endTime: { gt: slotStart },
    },
  });
  return Math.max(0, (eventType.seatsPerTimeSlot ?? 0) - taken);
}

/** Full validation used when creating/rescheduling a booking (cal.com parity: exact slot match). */
export async function validateSlotForBooking(eventType: SchedulableEventType, start: Date, client: Database = db, excludeBookingId?: number): Promise<void> {
  if (start.getTime() < Date.now() + eventType.minimumBookingNotice * 60_000) {
    throw Errors.minNotice("The requested time is too soon.");
  }
  const windowStart = new Date(start.getTime() - 86_400_000);
  const windowEnd = new Date(start.getTime() + eventType.length * 60_000 + 86_400_000);
  const slots = await getAvailableSlots(eventType, windowStart, windowEnd, "Etc/UTC", client, excludeBookingId);
  if (!Object.values(slots).some((day) => day.some((slot) => slot.utc === start.toISOString()))) {
    throw Errors.slotUnavailable();
  }
}

/** Loads an event type with everything the engine needs (host + schedule + availability). */
export async function loadSchedulableEventType(eventTypeId: number, client: Database = db): Promise<SchedulableEventType | null> {
  const eventType = await client.eventType.findUnique({
    where: { id: eventTypeId },
    include: {
      user: { select: { id: true, username: true, name: true, email: true, timeZone: true, defaultScheduleId: true } },
      schedule: { include: { availability: true } },
    },
  });
  return (eventType as unknown as SchedulableEventType) ?? null;
}
