/**
 * hbook — slot engine.
 *
 * Pure, in-memory computation: one availability query + one busy-intervals
 * query per request, everything else is arithmetic. For a 62-day range with
 * 15-minute slots this is a few thousand cheap integer comparisons — no
 * per-slot database round-trips.
 *
 * Rules implemented (mirroring the cal.com model):
 *  - weekly windows are defined per weekday in the host timezone
 *  - date overrides replace or close a specific local calendar day
 *  - the slot itself must fit fully inside an availability window
 *  - buffers (before/after) apply against existing bookings, not windows
 *  - minLeadMinutes blocks last-minute bookings, maxLeadDays caps the window
 */
import { AvailabilityWindow, dateKeyAddDays, getZonedParts, weekdayOfDateKey, zonedToUtc } from './time';

export interface BusyInterval {
  startsAt: Date;
  endsAt: Date;
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
  /** weekday (0=Sun..6=Sat) -> availability windows */
  weekly: Map<number, AvailabilityWindow[]>;
  /** dateKey -> override */
  overrides: Map<string, DateOverrideRule>;
  busy: BusyInterval[];
  durationMin: number;
  slotIntervalMin: number;
  bufferBeforeMin: number;
  bufferAfterMin: number;
  minLeadMinutes: number;
  maxLeadDays: number;
  nowUtc: Date;
  maxSlots?: number;
}

export function generateSlots(input: SlotEngineInput): Date[] {
  const {
    timeZone,
    fromUtc,
    toUtc,
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

  const maxSlots = input.maxSlots ?? 2000;
  const slots: Date[] = [];

  const earliest = Math.max(fromUtc.getTime(), nowUtc.getTime() + minLeadMinutes * 60_000);
  const latest = Math.min(toUtc.getTime(), nowUtc.getTime() + maxLeadDays * 86_400_000);
  if (latest <= earliest) return slots;

  // Pre-compute buffered busy intervals in ms
  const beforeMs = bufferBeforeMin * 60_000;
  const afterMs = bufferAfterMin * 60_000;
  const busyRanges = busy
    .map((b) => ({ start: b.startsAt.getTime() - beforeMs, end: b.endsAt.getTime() + afterMs }))
    .filter((b) => b.end > earliest - beforeMs && b.start < latest + afterMs)
    .sort((a, b) => a.start - b.start);

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
        // The slot must fit fully inside the window (buffers apply vs bookings only)
        for (let m = win.startMinute; m + durationMin <= win.endMinute; m += slotIntervalMin) {
          const startMs = zonedToUtc(timeZone, dayKey, m).getTime();
          if (startMs < earliest) continue;
          if (startMs > latest) break;
          const endMs = startMs + durationMs;

          let taken = false;
          for (const b of busyRanges) {
            if (b.start < endMs && b.end > startMs) {
              taken = true;
              break;
            }
          }
          if (!taken) {
            slots.push(new Date(startMs));
            if (slots.length >= maxSlots) break;
          }
        }
        if (slots.length >= maxSlots) break;
      }
    }

    dayKey = dateKeyAddDays(dayKey, 1);
  }

  slots.sort((a, b) => a.getTime() - b.getTime());
  return slots;
}

/**
 * Validate a concrete booking start against the same rules the slot
 * engine applies — single source of truth, so the API can never create
 * a booking the public slot list would not advertise.
 */
export function isBookableStart(
  input: Omit<SlotEngineInput, 'busy'> & { busy: BusyInterval[]; startUtc: Date },
): boolean {
  const startMs = input.startUtc.getTime();
  const endMs = startMs + input.durationMin * 60_000;
  // The day containing `startUtc` is scanned; `fromUtc` filters out everything
  // before it, so the first generated slot equals startMs iff it is bookable.
  const generated = generateSlots({ ...input, fromUtc: input.startUtc, toUtc: new Date(endMs) });
  return generated.length > 0 && generated[0].getTime() === startMs;
}
