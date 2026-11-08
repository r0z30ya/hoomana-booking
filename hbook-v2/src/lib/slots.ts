/**
 * hbook — slot engine.
 *
 * Pure, in-memory computation: one availability query + one busy-intervals
 * query per request, everything else is arithmetic. For a 62-day range with
 * 15-minute slots this is a few thousand cheap integer comparisons — no
 * per-slot database round-trips.
 *
 * Conflict model (single source of truth for /slots, /bookings and
 * /reschedule — they can never disagree):
 *  - Every ACTIVE booking occupies a buffered window
 *      [startsAt − own.bufferBefore, endsAt + own.bufferAfter]
 *    padded with ITS OWN event type's buffers.
 *  - A candidate booking fits iff its own buffered window
 *      [start − cand.bufferBefore, end + cand.bufferAfter]
 *    intersects NO active booking's buffered window.
 *  - EXCEPTION — same seat group: bookings of the SAME event type at the
 *    SAME start share one window and do not conflict with each other; the
 *    number of active bookings in the group is capped by EventType.capacity.
 *  - Two services with different buffer settings: each side keeps its own
 *    padding; they collide when the padded windows intersect (documented in
 *    docs/INTEGRATION.md).
 *  - Buffers apply BETWEEN bookings, not at availability-window edges: a
 *    slot only needs the unpadded [start, end] inside a working window.
 *
 * Rules otherwise (cal.com model): weekly windows per weekday in the host
 * timezone, date overrides replace/close a day, minLead/maxLead bounds.
 */
import { AvailabilityWindow, dateKeyAddDays, getZonedParts, weekdayOfDateKey, zonedToUtc } from './time';

export interface BusyInterval {
  startsAt: Date;
  endsAt: Date;
  /** The existing booking's own event-type buffers + its group key. */
  bufferBeforeMin: number;
  bufferAfterMin: number;
  eventTypeId: string;
}

export interface DateOverrideRule {
  /** YYYY-MM-DD in the host timezone */
  dateKey: string;
  closed: boolean;
  windows: AvailabilityWindow[];
}

export interface SlotEngineInput {
  timeZone: string;
  fromUtc: Date;
  toUtc: Date;
  /** Id of the event type being booked — defines the seat group. */
  eventTypeId: string;
  /** weekday (0=Sun..6=Sat) -> availability windows */
  weekly: Map<number, AvailabilityWindow[]>;
  /** dateKey -> override */
  overrides: Map<string, DateOverrideRule>;
  busy: BusyInterval[];
  durationMin: number;
  slotIntervalMin: number;
  bufferBeforeMin: number;
  bufferAfterMin: number;
  /** Concurrent seats per exact start (same event type). Default 1. */
  capacity?: number;
  minLeadMinutes: number;
  maxLeadDays: number;
  nowUtc: Date;
  maxSlots?: number;
}

export interface SlotInfo {
  startsAt: Date;
  seatsRemaining: number;
}

function padded(i: BusyInterval): { start: number; end: number } {
  return {
    start: i.startsAt.getTime() - i.bufferBeforeMin * 60_000,
    end: i.endsAt.getTime() + i.bufferAfterMin * 60_000,
  };
}

/** Active bookings per (eventTypeId, startsAt) group — seat accounting. */
function groupTakenMap(busy: BusyInterval[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const b of busy) {
    const key = `${b.eventTypeId}|${b.startsAt.getTime()}`;
    m.set(key, (m.get(key) ?? 0) + 1);
  }
  return m;
}

/**
 * Does the candidate's buffered window conflict with any EXISTING booking?
 * Same-group rows (same event type + same start) are excluded — they are
 * allowed up to `capacity` and handled by seat counting instead.
 */
export function conflictsWithBusy(
  busy: BusyInterval[],
  cand: { startMs: number; endMs: number; eventTypeId: string; bufferBeforeMin: number; bufferAfterMin: number },
): boolean {
  const cStart = cand.startMs - cand.bufferBeforeMin * 60_000;
  const cEnd = cand.endMs + cand.bufferAfterMin * 60_000;
  for (const b of busy) {
    if (b.eventTypeId === cand.eventTypeId && b.startsAt.getTime() === cand.startMs) continue; // same seat group
    const p = padded(b);
    if (p.start < cEnd && p.end > cStart) return true;
  }
  return false;
}

export function generateSlots(input: SlotEngineInput): SlotInfo[] {
  const {
    timeZone,
    fromUtc,
    toUtc,
    eventTypeId,
    weekly,
    overrides,
    busy,
    durationMin,
    slotIntervalMin,
    bufferBeforeMin,
    bufferAfterMin,
    minLeadMinutes,
    maxLeadDays,
    nowUtc,
  } = input;

  const capacity = Math.max(1, input.capacity ?? 1);
  const maxSlots = input.maxSlots ?? 2000;
  const slots: SlotInfo[] = [];
  const taken = groupTakenMap(busy);

  const earliest = Math.max(fromUtc.getTime(), nowUtc.getTime() + minLeadMinutes * 60_000);
  const latest = Math.min(toUtc.getTime(), nowUtc.getTime() + maxLeadDays * 86_400_000);
  if (latest <= earliest) return slots;

  const durationMs = durationMin * 60_000;
  let dayKey = getZonedParts(timeZone, fromUtc).dateKey;

  for (let i = 0; i < 100; i++) {
    const dayStartUtc = zonedToUtc(timeZone, dayKey, 0).getTime();
    if (dayStartUtc > latest || slots.length >= maxSlots) break;

    const override = overrides.get(dayKey);
    const windows = override
      ? override.closed
        ? []
        : override.windows
      : weekly.get(weekdayOfDateKey(timeZone, dayKey)) ?? [];

    if (windows.length > 0) {
      for (const win of windows) {
        // The unpadded slot must fit fully inside the window (buffers apply
        // between bookings, not at window edges).
        for (let m = win.startMinute; m + durationMin <= win.endMinute; m += slotIntervalMin) {
          const startMs = zonedToUtc(timeZone, dayKey, m).getTime();
          const localStart = getZonedParts(timeZone, new Date(startMs));
          if (localStart.dateKey !== dayKey || localStart.minutes !== m) continue;
          if (startMs < earliest) continue;
          if (startMs >= latest) break;
          const endMs = startMs + durationMs;

          const seatsUsed = taken.get(`${eventTypeId}|${startMs}`) ?? 0;
          if (seatsUsed >= capacity) continue; // seat group full
          if (
            conflictsWithBusy(busy, {
              startMs,
              endMs,
              eventTypeId,
              bufferBeforeMin,
              bufferAfterMin,
            })
          ) {
            continue;
          }

          slots.push({ startsAt: new Date(startMs), seatsRemaining: capacity - seatsUsed });
          if (slots.length >= maxSlots) break;
        }
        if (slots.length >= maxSlots) break;
      }
    }

    dayKey = dateKeyAddDays(dayKey, 1);
  }

  slots.sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime());
  return slots;
}

/**
 * Validate a concrete booking start against the same rules the slot engine
 * applies — single source of truth, so the API can never create a booking
 * the public slot list would not advertise (and vice versa).
 * Returns seats remaining at that start, or null when not bookable.
 */
export function bookableSeats(
  input: Omit<SlotEngineInput, 'busy'> & { busy: BusyInterval[]; startUtc: Date },
): number | null {
  const startMs = input.startUtc.getTime();
  const endMs = startMs + input.durationMin * 60_000;
  // The day containing `startUtc` is scanned; `fromUtc` filters out everything
  // before it, so the first generated slot equals startMs iff it is bookable.
  const generated = generateSlots({
    ...input,
    fromUtc: input.startUtc,
    toUtc: new Date(endMs),
  });
  const hit = generated.find((s) => s.startsAt.getTime() === startMs);
  return hit ? hit.seatsRemaining : null;
}
