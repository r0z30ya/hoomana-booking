import { z } from "zod";
import { WEBHOOK_TRIGGERS } from "./webhooks";

const timeZone = z.string().min(1).refine((value) => {
  try { new Intl.DateTimeFormat("en", { timeZone: value }); return true; }
  catch { return false; }
}, "Invalid IANA time zone.");

// ---------------- auth ----------------

export const signupSchema = z.object({
  username: z
    .string()
    .min(3)
    .max(40)
    .regex(/^[a-z0-9][a-z0-9-_.]*$/, "username must be lowercase (a-z, 0-9, -, _, .)"),
  name: z.string().min(1).max(80).optional(),
  email: z.string().email(),
  password: z.string().min(8).max(128),
  timeZone: timeZone.optional(),
});

export const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

// ---------------- user ----------------

export const meUpdateSchema = z.object({
  name: z.string().min(1).max(80).optional(),
  username: z
    .string()
    .min(3)
    .max(40)
    .regex(/^[a-z0-9][a-z0-9-_.]*$/)
    .optional(),
  timeZone: timeZone.optional(),
  weekStart: z.enum(["Sunday", "Monday"]).optional(),
  timeFormat: z.union([z.literal(12), z.literal(24)]).optional(),
  bio: z.string().max(400).optional(),
  avatarUrl: z.string().url().optional(),
});

// ---------------- event types ----------------

const periodType = z.enum(["UNLIMITED", "ROLLING", "RANGE"]);

export const eventTypeCreateSchema = z.object({
  title: z.string().min(1).max(120),
  slug: z
    .string()
    .min(1)
    .max(60)
    .regex(/^[a-z0-9][a-z0-9-]*$/)
    .optional(),
  description: z.string().max(2000).optional(),
  length: z.number().int().min(5).max(720),
  hidden: z.boolean().optional(),
  requiresConfirmation: z.boolean().optional(),
  disableGuests: z.boolean().optional(),
  minimumBookingNotice: z.number().int().min(0).max(60 * 24 * 30).optional(),
  beforeBufferTime: z.number().int().min(0).max(360).optional(),
  afterBufferTime: z.number().int().min(0).max(360).optional(),
  slotInterval: z.number().int().min(5).max(720).optional(),
  scheduleId: z.number().int().optional(),
  timeZone: timeZone.optional(),
  locations: z.array(z.string()).optional(),
  periodType: periodType.optional(),
  periodDays: z.number().int().min(1).max(365).optional(),
  periodCountCalendarDays: z.boolean().optional(),
  periodStartDate: z.coerce.date().optional(),
  periodEndDate: z.coerce.date().optional(),
  seatsPerTimeSlot: z.number().int().min(1).max(1000).optional(),
  price: z.number().int().min(0).optional(),
  currency: z.string().min(3).max(3).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export const eventTypeUpdateSchema = eventTypeCreateSchema.partial();

// ---------------- schedules ----------------

const hhMm = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/, "expected a valid HH:mm time");

export const availabilityInputSchema = z
  .object({
    days: z.array(z.number().int().min(0).max(6)).min(1),
    startTime: hhMm,
    endTime: hhMm,
    date: z.coerce.date().optional(), // date override (stored as UTC midnight)
  })
  .refine((v) => v.endTime === "00:00" || v.endTime > v.startTime, {
    message: "endTime must be after startTime ('00:00' end = midnight/24:00)",
  });

export const scheduleCreateSchema = z.object({
  name: z.string().min(1).max(120),
  timeZone: timeZone.optional(),
  isDefault: z.boolean().optional(),
  availability: z.array(availabilityInputSchema).max(50).optional(),
});

export const scheduleUpdateSchema = scheduleCreateSchema.partial();

// ---------------- bookings ----------------

export const attendeeSchema = z.object({
  name: z.string().min(1).max(80),
  email: z.string().email().optional(),
  phone: z.string().min(1).max(20).optional(),
  timeZone: timeZone.optional(),
  language: z.string().min(2).max(8).optional(),
}).refine((attendee) => Boolean(attendee.email || attendee.phone), { message: 'An email or phone number is required.' });

export const bookingCreateSchema = z
  .object({
    start: z.coerce.date(),
    eventTypeId: z.number().int().optional(),
    username: z.string().min(1).optional(),
    eventTypeSlug: z.string().min(1).optional(),
    attendee: attendeeSchema,
    guests: z.array(z.string().email()).max(10).optional(),
    location: z.string().max(200).optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
    bookingFieldsResponses: z.record(z.string(), z.unknown()).optional(),
  })
  .refine((v) => Boolean(v.eventTypeId) || Boolean(v.username && v.eventTypeSlug), {
    message: "Provide either `eventTypeId` or both `username` and `eventTypeSlug`.",
    path: ["eventTypeId"],
  });

export const bookingRescheduleSchema = z.object({
  start: z.coerce.date(),
  email: z.string().email().optional(), // retained for compatibility; never used for authorization
});

export const bookingCancelSchema = z.object({
  reason: z.string().max(500).optional(),
  cancelledBy: z.string().max(200).optional(),
  email: z.string().email().optional(), // retained for compatibility; never used for authorization
});

export const bookingListQuerySchema = z.object({
  status: z.enum(["upcoming", "past", "cancelled", "unconfirmed", "all"]).default("upcoming"),
  eventTypeId: z.coerce.number().int().optional(),
  take: z.coerce.number().int().min(1).max(100).default(25),
  skip: z.coerce.number().int().min(0).default(0),
});

// ---------------- slots ----------------

export const slotsQuerySchema = z
  .object({
    eventTypeId: z.coerce.number().int().optional(),
    username: z.string().min(1).optional(),
    eventTypeSlug: z.string().min(1).optional(),
    startTime: z.coerce.date(),
    endTime: z.coerce.date(),
    timeZone: timeZone.optional(),
  })
  .refine((v) => Boolean(v.eventTypeId) || Boolean(v.username && v.eventTypeSlug), {
    message: "Provide either `eventTypeId` or both `username` and `eventTypeSlug`.",
    path: ["eventTypeId"],
  })
  .refine((v) => v.endTime.getTime() > v.startTime.getTime(), {
    message: "endTime must be after startTime",
    path: ["endTime"],
  })
  .refine((v) => v.endTime.getTime() - v.startTime.getTime() <= 31 * 86_400_000, {
    message: "The requested range cannot exceed 31 days.", path: ["endTime"],
  });

// ---------------- api keys ----------------

export const apiKeyCreateSchema = z.object({
  name: z.string().max(80).optional(),
  expiresAt: z.coerce.date().optional(),
});

// ---------------- webhooks ----------------

export const webhookCreateSchema = z.object({
  subscriberUrl: z.string().url(),
  eventTriggers: z.array(z.enum(WEBHOOK_TRIGGERS)).min(1),
  active: z.boolean().optional(),
  secret: z.string().min(8).max(128).optional(),
});

export const webhookUpdateSchema = z.object({
  subscriberUrl: z.string().url().optional(),
  eventTriggers: z.array(z.enum(WEBHOOK_TRIGGERS)).min(1).optional(),
  active: z.boolean().optional(),
  secret: z.string().min(8).max(128).optional(),
});
