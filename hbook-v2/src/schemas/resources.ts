/**
 * hbook — resource JSON Schemas.
 * Field types intentionally mirror Prisma models; nullable DB columns use
 * ["string", "null"] so serialization never throws on real data.
 * v2: capacity, phone-first attendee, slot objects with seatsRemaining,
 * persistent delivery queue rows, API key scopes.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

const isoDate = { type: 'string', format: 'date-time' } as const;
const nullableString = { type: ['string', 'null'] } as const;
const slugPattern = '^[a-z0-9]+(-[a-z0-9]+)*$';
const hhmmPattern = '^([01][0-9]|2[0-3]):[0-5][0-9]$';
const datePattern = '^[0-9]{4}-[0-9]{2}-[0-9]{2}$';

// ─────────────────────────────── Tenants ───────────────────────────────

export const TenantRef: any = {
  $id: 'TenantRef',
  type: 'object',
  properties: {
    id: { type: 'string' },
    name: { type: 'string' },
    slug: { type: 'string' },
    timezone: { type: 'string' },
    createdAt: isoDate,
  },
  required: ['id', 'name', 'slug', 'timezone', 'createdAt'],
};

export const TenantCreateBody: any = {
  $id: 'TenantCreateBody',
  type: 'object',
  additionalProperties: false,
  required: ['name', 'slug', 'owner'],
  properties: {
    name: { type: 'string', minLength: 2, maxLength: 120 },
    slug: { type: 'string', pattern: slugPattern, minLength: 2, maxLength: 60 },
    timezone: { type: 'string', minLength: 2, maxLength: 64, default: 'Asia/Tehran' },
    owner: {
      type: 'object',
      additionalProperties: false,
      properties: {
        name: { type: 'string', minLength: 1, maxLength: 120, default: 'Owner' },
        email: { type: 'string', format: 'email', maxLength: 254 },
        timezone: { type: 'string', minLength: 2, maxLength: 64 },
      },
    },
  },
};

export const TenantCreated: any = {
  $id: 'TenantCreated',
  type: 'object',
  properties: {
    tenant: { $ref: 'TenantRef#' },
    owner: { $ref: 'UserRef#' },
    apiKey: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        name: { type: 'string' },
        prefix: { type: 'string' },
        scopes: { type: 'array', items: { type: 'string' } },
        key: { type: 'string', description: 'Full API key — shown ONLY here, never again.' },
      },
      required: ['id', 'name', 'prefix', 'key'],
    },
  },
  required: ['tenant', 'owner', 'apiKey'],
};

export const SetupTokenHeader: any = {
  $id: 'SetupTokenHeader',
  type: 'object',
  required: ['x-setup-token'],
  properties: {
    'x-setup-token': { type: 'string', minLength: 8, maxLength: 256 },
  },
};

// ─────────────────────────────── Me ───────────────────────────────

export const MeResponse: any = {
  $id: 'MeResponse',
  type: 'object',
  properties: {
    tenant: { $ref: 'TenantRef#' },
    apiKey: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        name: { type: 'string' },
        prefix: { type: 'string' },
        scopes: { type: 'array', items: { type: 'string' } },
        expiresAt: { type: ['string', 'null'] },
      },
      required: ['id', 'name', 'prefix', 'scopes'],
    },
  },
  required: ['tenant', 'apiKey'],
};

// ─────────────────────────────── Users ───────────────────────────────

export const UserRef: any = {
  $id: 'UserRef',
  type: 'object',
  properties: {
    id: { type: 'string' },
    name: { type: 'string' },
    email: nullableString,
    timezone: { type: 'string' },
    role: { type: 'string', enum: ['OWNER', 'ADMIN', 'MEMBER'] },
    isHost: { type: 'boolean' },
    externalId: nullableString,
    createdAt: isoDate,
  },
  required: ['id', 'name', 'email', 'timezone', 'role', 'isHost', 'createdAt'],
};

export const UserInput: any = {
  $id: 'UserInput',
  type: 'object',
  additionalProperties: false,
  required: ['name'],
  properties: {
    name: { type: 'string', minLength: 1, maxLength: 120 },
    email: { type: 'string', format: 'email', maxLength: 254 },
    timezone: { type: 'string', minLength: 2, maxLength: 64 },
    role: { type: 'string', enum: ['OWNER', 'ADMIN', 'MEMBER'], default: 'MEMBER' },
    isHost: { type: 'boolean', default: true },
    externalId: { type: 'string', maxLength: 128 },
  },
};

export const UserPatch: any = {
  $id: 'UserPatch',
  type: 'object',
  additionalProperties: false,
  minProperties: 1,
  properties: {
    name: { type: 'string', minLength: 1, maxLength: 120 },
    email: { type: ['string', 'null'], format: 'email', maxLength: 254 },
    timezone: { type: 'string', minLength: 2, maxLength: 64 },
    role: { type: 'string', enum: ['OWNER', 'ADMIN', 'MEMBER'] },
    isHost: { type: 'boolean' },
    externalId: { type: ['string', 'null'], maxLength: 128 },
  },
};

export const UsersList: any = {
  $id: 'UsersList',
  type: 'object',
  properties: {
    items: { type: 'array', items: { $ref: 'UserRef#' } },
    nextCursor: { type: ['string', 'null'] },
  },
  required: ['items', 'nextCursor'],
};

export const IdParam: any = {
  $id: 'IdParam',
  type: 'object',
  required: ['id'],
  properties: { id: { type: 'string', minLength: 1, maxLength: 64 } },
};

// ──────────────────────────── Event types ────────────────────────────

export const EventTypeRef: any = {
  $id: 'EventTypeRef',
  type: 'object',
  properties: {
    id: { type: 'string' },
    slug: { type: 'string' },
    title: { type: 'string' },
    description: nullableString,
    hostId: nullableString,
    durationMin: { type: 'integer' },
    slotIntervalMin: { type: 'integer' },
    capacity: { type: 'integer', minimum: 1, maximum: 100 },
    bufferBeforeMin: { type: 'integer' },
    bufferAfterMin: { type: 'integer' },
    minLeadMinutes: { type: 'integer' },
    maxLeadDays: { type: 'integer' },
    location: nullableString,
    requiresConfirmation: { type: 'boolean' },
    isActive: { type: 'boolean' },
    externalId: nullableString,
    createdAt: isoDate,
  },
  required: ['id', 'slug', 'title', 'durationMin', 'slotIntervalMin', 'capacity', 'bufferBeforeMin', 'bufferAfterMin', 'minLeadMinutes', 'maxLeadDays', 'requiresConfirmation', 'isActive', 'createdAt'],
};

export const EventTypeInput: any = {
  $id: 'EventTypeInput',
  type: 'object',
  additionalProperties: false,
  required: ['slug', 'title', 'durationMin'],
  properties: {
    slug: { type: 'string', pattern: slugPattern, minLength: 2, maxLength: 60 },
    title: { type: 'string', minLength: 1, maxLength: 120 },
    description: { type: 'string', maxLength: 1000 },
    hostId: { type: 'string', maxLength: 64 },
    durationMin: { type: 'integer', minimum: 5, maximum: 480 },
    slotIntervalMin: { type: 'integer', minimum: 5, maximum: 480 },
    capacity: { type: 'integer', minimum: 1, maximum: 100, default: 1 },
    bufferBeforeMin: { type: 'integer', minimum: 0, maximum: 240 },
    bufferAfterMin: { type: 'integer', minimum: 0, maximum: 240 },
    minLeadMinutes: { type: 'integer', minimum: 0, maximum: 10080 },
    maxLeadDays: { type: 'integer', minimum: 1, maximum: 365 },
    location: { type: 'string', maxLength: 200 },
    requiresConfirmation: { type: 'boolean', default: false },
    isActive: { type: 'boolean', default: true },
    externalId: { type: 'string', maxLength: 128 },
  },
};

export const EventTypePatch: any = {
  $id: 'EventTypePatch',
  type: 'object',
  additionalProperties: false,
  minProperties: 1,
  properties: {
    title: { type: 'string', minLength: 1, maxLength: 120 },
    description: { type: ['string', 'null'], maxLength: 1000 },
    hostId: { type: ['string', 'null'], maxLength: 64 },
    durationMin: { type: 'integer', minimum: 5, maximum: 480 },
    slotIntervalMin: { type: 'integer', minimum: 5, maximum: 480 },
    capacity: { type: 'integer', minimum: 1, maximum: 100 },
    bufferBeforeMin: { type: 'integer', minimum: 0, maximum: 240 },
    bufferAfterMin: { type: 'integer', minimum: 0, maximum: 240 },
    minLeadMinutes: { type: 'integer', minimum: 0, maximum: 10080 },
    maxLeadDays: { type: 'integer', minimum: 1, maximum: 365 },
    location: { type: ['string', 'null'], maxLength: 200 },
    requiresConfirmation: { type: 'boolean' },
    isActive: { type: 'boolean' },
    externalId: { type: ['string', 'null'], maxLength: 128 },
  },
};

export const EventTypesList: any = {
  $id: 'EventTypesList',
  type: 'object',
  properties: {
    items: { type: 'array', items: { $ref: 'EventTypeRef#' } },
    nextCursor: { type: ['string', 'null'] },
  },
  required: ['items', 'nextCursor'],
};

// ──────────────────────────── Availability ────────────────────────────

export const AvailabilityWindow: any = {
  $id: 'AvailabilityWindow',
  type: 'object',
  additionalProperties: false,
  required: ['start', 'end'],
  properties: {
    start: { type: 'string', pattern: hhmmPattern, description: 'Local time HH:MM' },
    end: { type: 'string', pattern: hhmmPattern },
  },
};

export const AvailabilityWeeklyItem: any = {
  $id: 'AvailabilityWeeklyItem',
  type: 'object',
  additionalProperties: false,
  required: ['weekday', 'windows'],
  properties: {
    weekday: { type: 'integer', minimum: 0, maximum: 6, description: '0=Sunday … 6=Saturday' },
    windows: {
      type: 'array',
      minItems: 1,
      maxItems: 8,
      items: { $ref: 'AvailabilityWindow#' },
    },
  },
};

export const AvailabilityPutBody: any = {
  $id: 'AvailabilityPutBody',
  type: 'object',
  additionalProperties: false,
  required: ['weekly'],
  properties: {
    weekly: {
      type: 'array',
      maxItems: 7,
      items: { $ref: 'AvailabilityWeeklyItem#' },
    },
  },
};

export const DateOverrideInput: any = {
  $id: 'DateOverrideInput',
  type: 'object',
  additionalProperties: false,
  required: ['date'],
  properties: {
    date: { type: 'string', pattern: datePattern, description: 'YYYY-MM-DD in the host timezone' },
    closed: { type: 'boolean', default: true, description: 'true = day off; false = custom window below' },
    start: { type: 'string', pattern: hhmmPattern },
    end: { type: 'string', pattern: hhmmPattern },
  },
};

export const AvailabilityResponse: any = {
  $id: 'AvailabilityResponse',
  type: 'object',
  properties: {
    userId: { type: 'string' },
    timezone: { type: 'string' },
    weekly: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          weekday: { type: 'integer', minimum: 0, maximum: 6 },
          windows: { type: 'array', items: { $ref: 'AvailabilityWindow#' } },
        },
        required: ['weekday', 'windows'],
      },
    },
    overrides: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          date: { type: 'string', pattern: datePattern },
          closed: { type: 'boolean' },
          windows: { type: 'array', items: { $ref: 'AvailabilityWindow#' } },
        },
        required: ['date', 'closed', 'windows'],
      },
    },
  },
  required: ['userId', 'timezone', 'weekly', 'overrides'],
};

export const OverrideDateParam: any = {
  $id: 'OverrideDateParam',
  type: 'object',
  required: ['id', 'date'],
  properties: {
    id: { type: 'string', minLength: 1, maxLength: 64 },
    date: { type: 'string', pattern: datePattern },
  },
};

// ─────────────────────────────── Slots ───────────────────────────────

export const SlotsQuery: any = {
  $id: 'SlotsQuery',
  type: 'object',
  required: ['eventTypeId', 'from', 'to'],
  properties: {
    eventTypeId: { type: 'string', minLength: 2, maxLength: 64, description: 'Event type id or slug' },
    hostId: { type: 'string', maxLength: 64, description: 'Only when the event type has no fixed host' },
    from: { type: 'string', minLength: 10, maxLength: 40, description: 'ISO date-time or YYYY-MM-DD (in timezone)' },
    to: { type: 'string', minLength: 10, maxLength: 40, description: 'ISO date-time or YYYY-MM-DD (exclusive)' },
    timezone: { type: 'string', maxLength: 64, description: 'IANA timezone for day boundaries. Default: host timezone' },
  },
};

export const SlotsResponse: any = {
  $id: 'SlotsResponse',
  type: 'object',
  properties: {
    eventTypeId: { type: 'string' },
    hostId: { type: 'string' },
    timezone: { type: 'string' },
    from: { type: 'string' },
    to: { type: 'string' },
    durationMinutes: { type: 'integer' },
    capacity: { type: 'integer', minimum: 1 },
    slots: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          startsAt: { type: 'string', format: 'date-time', description: 'UTC ISO-8601 start instant' },
          seatsRemaining: { type: 'integer', minimum: 0, description: 'Concurrent seats still open at this start' },
        },
        required: ['startsAt', 'seatsRemaining'],
      },
    },
  },
  required: ['eventTypeId', 'hostId', 'timezone', 'from', 'to', 'durationMinutes', 'capacity', 'slots'],
};

// ─────────────────────────────── Bookings ───────────────────────────────

export const BookingRef: any = {
  $id: 'BookingRef',
  type: 'object',
  properties: {
    uid: { type: 'string' },
    status: { type: 'string', enum: ['PENDING', 'CONFIRMED', 'CANCELLED'] },
    startsAt: isoDate,
    endsAt: isoDate,
    attendee: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        phone: nullableString,
        email: nullableString,
        timezone: nullableString,
        notes: nullableString,
      },
      required: ['name', 'phone', 'email'],
    },
    eventType: { $ref: 'EventTypeRef#' },
    host: { $ref: 'HostRef#' },
    cancellationReason: nullableString,
    createdAt: isoDate,
  },
  required: ['uid', 'status', 'startsAt', 'endsAt', 'attendee', 'eventType', 'host', 'createdAt'],
};

export const HostRef: any = {
  $id: 'HostRef',
  type: 'object',
  properties: {
    id: { type: 'string' },
    name: { type: 'string' },
    email: nullableString,
    timezone: { type: 'string' },
  },
  required: ['id', 'name', 'email', 'timezone'],
};

export const BookingCreateBody: any = {
  $id: 'BookingCreateBody',
  type: 'object',
  additionalProperties: false,
  required: ['eventTypeId', 'start', 'attendee'],
  properties: {
    eventTypeId: { type: 'string', minLength: 2, maxLength: 64, description: 'Event type id or slug' },
    hostId: { type: 'string', maxLength: 64, description: 'Required when the event type has no fixed host' },
    start: { type: 'string', format: 'date-time', description: 'Exact UTC start instant — must match a slot from GET /v1/slots' },
    attendee: {
      type: 'object',
      additionalProperties: false,
      required: ['name', 'phone'],
      properties: {
        name: { type: 'string', minLength: 1, maxLength: 120 },
        phone: {
          type: 'string',
          minLength: 6,
          maxLength: 40,
          description: 'Mobile number. Iranian forms: 09123456789 · +989123456789 · ۰۹۱۲۳۴۵۶۷۸۹. Normalized to 09… / +E.164.',
        },
        email: { type: 'string', format: 'email', maxLength: 254 },
        timezone: { type: 'string', maxLength: 64 },
        notes: { type: 'string', maxLength: 2000 },
      },
    },
  },
};

export const BookingsQuery: any = {
  $id: 'BookingsQuery',
  type: 'object',
  properties: {
    limit: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
    cursor: { type: 'string', maxLength: 128 },
    status: { type: 'string', enum: ['PENDING', 'CONFIRMED', 'CANCELLED'] },
    eventTypeId: { type: 'string', maxLength: 64 },
    hostId: { type: 'string', maxLength: 64 },
    attendeePhone: { type: 'string', maxLength: 40, description: 'Any accepted format — normalized before matching' },
    attendeeEmail: { type: 'string', maxLength: 254 },
    from: { type: 'string', format: 'date-time', description: 'Bookings starting at or after' },
    to: { type: 'string', format: 'date-time', description: 'Bookings starting before' },
  },
};

export const BookingsList: any = {
  $id: 'BookingsList',
  type: 'object',
  properties: {
    items: { type: 'array', items: { $ref: 'BookingRef#' } },
    nextCursor: { type: ['string', 'null'] },
  },
  required: ['items', 'nextCursor'],
};

export const BookingCancelBody: any = {
  $id: 'BookingCancelBody',
  type: 'object',
  additionalProperties: false,
  properties: {
    reason: { type: 'string', maxLength: 500 },
  },
};

export const BookingRescheduleBody: any = {
  $id: 'BookingRescheduleBody',
  type: 'object',
  additionalProperties: false,
  required: ['start'],
  properties: {
    start: { type: 'string', format: 'date-time', description: 'New UTC start instant — must be an available slot' },
  },
};

export const BookingUidParam: any = {
  $id: 'BookingUidParam',
  type: 'object',
  required: ['uid'],
  properties: { uid: { type: 'string', minLength: 6, maxLength: 64 } },
};

// ─────────────────────────────── Webhooks ───────────────────────────────

export const WebhookEventsEnum: any = {
  $id: 'WebhookEventsEnum',
  type: 'string',
  enum: ['booking.created', 'booking.confirmed', 'booking.cancelled', 'booking.rescheduled', 'ping'],
};

export const WebhookCreateBody: any = {
  $id: 'WebhookCreateBody',
  type: 'object',
  additionalProperties: false,
  required: ['url', 'events'],
  properties: {
    url: {
      type: 'string',
      format: 'uri',
      maxLength: 500,
      description: 'Public https:// URL (plain http only in dev with HBOOK_WEBHOOK_ALLOW_INSECURE_HTTP=1). Private/loopback targets are rejected.',
    },
    events: {
      type: 'array',
      minItems: 1,
      maxItems: 5,
      uniqueItems: true,
      items: { $ref: 'WebhookEventsEnum#' },
    },
    secret: { type: 'string', minLength: 16, maxLength: 255, description: 'Optional — generated when omitted' },
  },
};

export const WebhookRef: any = {
  $id: 'WebhookRef',
  type: 'object',
  properties: {
    id: { type: 'string' },
    url: { type: 'string' },
    events: { type: 'array', items: { type: 'string' } },
    isActive: { type: 'boolean' },
    createdAt: isoDate,
  },
  required: ['id', 'url', 'events', 'isActive', 'createdAt'],
};

export const WebhookCreated: any = {
  $id: 'WebhookCreated',
  type: 'object',
  properties: {
    id: { type: 'string' },
    url: { type: 'string' },
    events: { type: 'array', items: { type: 'string' } },
    isActive: { type: 'boolean' },
    createdAt: isoDate,
    secret: { type: 'string', description: 'Signing secret — shown ONLY here, never again (stored encrypted).' },
  },
  required: ['id', 'url', 'events', 'isActive', 'createdAt', 'secret'],
};

export const WebhooksList: any = {
  $id: 'WebhooksList',
  type: 'object',
  properties: {
    items: { type: 'array', items: { $ref: 'WebhookRef#' } },
    nextCursor: { type: ['string', 'null'] },
  },
  required: ['items', 'nextCursor'],
};

export const WebhookDeliveryRef: any = {
  $id: 'WebhookDeliveryRef',
  type: 'object',
  properties: {
    id: { type: 'string' },
    event: { type: 'string' },
    eventId: { type: 'string', description: 'Stable outbox event id — same across all attempts' },
    status: { type: 'string', enum: ['PENDING', 'PROCESSING', 'DELIVERED', 'FAILED'] },
    attempts: { type: 'integer' },
    nextAttemptAt: { type: ['string', 'null'] },
    lastAttemptAt: { type: ['string', 'null'] },
    statusCode: { type: ['integer', 'null'] },
    error: nullableString,
    payload: { type: 'object', description: 'Envelope that is (or will be) delivered' },
    createdAt: isoDate,
  },
  required: ['id', 'event', 'eventId', 'status', 'attempts', 'createdAt'],
};

export const DeliveriesList: any = {
  $id: 'DeliveriesList',
  type: 'object',
  properties: {
    items: { type: 'array', items: { $ref: 'WebhookDeliveryRef#' } },
    nextCursor: { type: ['string', 'null'] },
  },
  required: ['items', 'nextCursor'],
};

// ─────────────────────────────── API keys ───────────────────────────────

const scopesArray = { type: 'array', items: { type: 'string', enum: ['admin', 'manage', 'book', 'read'] } } as const;

export const ApiKeyRef: any = {
  $id: 'ApiKeyRef',
  type: 'object',
  properties: {
    id: { type: 'string' },
    name: { type: 'string' },
    prefix: { type: 'string' },
    scopes: scopesArray,
    expiresAt: nullableString,
    revokedAt: nullableString,
    lastUsedAt: nullableString,
    createdAt: isoDate,
  },
  required: ['id', 'name', 'prefix', 'createdAt'],
};

export const ApiKeyCreated: any = {
  $id: 'ApiKeyCreated',
  type: 'object',
  properties: {
    id: { type: 'string' },
    name: { type: 'string' },
    prefix: { type: 'string' },
    scopes: scopesArray,
    key: { type: 'string', description: 'Full API key — shown ONLY here, never again.' },
    expiresAt: nullableString,
    createdAt: isoDate,
  },
  required: ['id', 'name', 'prefix', 'key', 'createdAt'],
};

export const ApiKeyCreateBody: any = {
  $id: 'ApiKeyCreateBody',
  type: 'object',
  additionalProperties: false,
  properties: {
    name: { type: 'string', minLength: 1, maxLength: 80, default: 'default' },
    expiresAt: { type: 'string', format: 'date-time', description: 'Optional expiry' },
    scopes: {
      type: 'array',
      maxItems: 4,
      uniqueItems: true,
      items: { type: 'string', enum: ['admin', 'manage', 'book', 'read'] },
      description: 'Default: [admin]. Must be a subset of the calling key\'s scopes.',
    },
  },
};

export const ApiKeysList: any = {
  $id: 'ApiKeysList',
  type: 'object',
  properties: {
    items: { type: 'array', items: { $ref: 'ApiKeyRef#' } },
    nextCursor: { type: ['string', 'null'] },
  },
  required: ['items', 'nextCursor'],
};
