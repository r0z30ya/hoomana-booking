/**
 * hbook — timezone helpers built on Intl (no heavy libraries).
 *
 * All timestamps are stored in UTC (Prisma timestamptz); availability
 * windows are "minutes from local midnight" in the host timezone and
 * are materialized to UTC instants on the fly. Intl formatters are
 * cached per timezone — creating them repeatedly is the #1 perf trap.
 */
import { unprocessable } from './errors';

export interface AvailabilityWindow {
  startMinute: number;
  endMinute: number;
}

interface ZonedParts {
  year: number;
  month: number;
  day: number;
  /** minutes from local midnight (0..1439) */
  minutes: number;
  /** 0 = Sunday … 6 = Saturday (local calendar day) */
  weekday: number;
  /** zero-padded YYYY-MM-DD in the target timezone */
  dateKey: string;
}

const WEEKDAY_INDEX: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

const formatterCache = new Map<string, Intl.DateTimeFormat>();

function getFormatter(timeZone: string): Intl.DateTimeFormat {
  let fmt = formatterCache.get(timeZone);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hour12: false,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      weekday: 'short',
    });
    formatterCache.set(timeZone, fmt);
  }
  return fmt;
}

export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export function assertTimeZone(tz: string): void {
  if (!isValidTimeZone(tz)) {
    throw unprocessable('INVALID_TIMEZONE', `Unknown IANA timezone: "${tz}"`);
  }
}

export function getZonedParts(timeZone: string, instant: Date): ZonedParts {
  const parts = getFormatter(timeZone).formatToParts(instant);
  const map: Record<string, string> = {};
  for (const p of parts) map[p.type] = p.value;
  const hour = map.hour === '24' ? 0 : Number(map.hour);
  const minute = Number(map.minute);
  return {
    year: Number(map.year),
    month: Number(map.month),
    day: Number(map.day),
    minutes: hour * 60 + minute,
    weekday: WEEKDAY_INDEX[map.weekday] ?? 0,
    dateKey: `${map.year}-${map.month}-${map.day}`,
  };
}

/** Offset (ms) of the timezone east of UTC at the given instant, minute-aligned. */
export function tzOffsetMs(timeZone: string, instant: Date): number {
  const aligned = Math.floor(instant.getTime() / 60_000) * 60_000;
  const p = getZonedParts(timeZone, new Date(aligned));
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, Math.floor(p.minutes / 60), p.minutes % 60);
  return asUtc - aligned;
}

/**
 * Convert a local wall-clock time (dateKey + minutes-from-midnight) in the
 * given timezone to a UTC instant. Callers must verify the round trip when
 * a wall time may not exist during a timezone transition.
 */
export function zonedToUtc(timeZone: string, dateKey: string, minutes: number): Date {
  const [y, m, d] = dateKey.split('-').map(Number);
  const naive = Date.UTC(y, m - 1, d, Math.floor(minutes / 60), minutes % 60);
  const off1 = tzOffsetMs(timeZone, new Date(naive));
  let utc = naive - off1;
  const off2 = tzOffsetMs(timeZone, new Date(utc));
  if (off2 !== off1) utc = naive - off2;
  return new Date(utc);
}

/** Local weekday (0=Sun..6=Sat) for a YYYY-MM-DD calendar day in the timezone. */
export function weekdayOfDateKey(timeZone: string, dateKey: string): number {
  const noon = zonedToUtc(timeZone, dateKey, 12 * 60); // noon always lands on the same local day
  return getZonedParts(timeZone, noon).weekday;
}

export function dateKeyAddDays(dateKey: string, days: number): string {
  const [y, m, d] = dateKey.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

export function dateKeyToUtcStart(dateKey: string): Date {
  return new Date(`${dateKey}T00:00:00.000Z`);
}

export function minutesToHHMM(minutes: number): string {
  const h = String(Math.floor(minutes / 60)).padStart(2, '0');
  const m = String(minutes % 60).padStart(2, '0');
  return `${h}:${m}`;
}

export function hhmmToMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}
