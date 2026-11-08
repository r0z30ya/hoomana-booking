# hbook × Homana — Integration Contract (API v2)

hbook is a swappable, frontend-free booking engine. Homana owns the UI,
user accounts, authentication and panels; it calls hbook **server-to-server**
with API keys. Engine keys must NEVER be embedded in the frontend.

This document is the contract an adapter needs. Everything here is stable,
machine-readable and covered by tests (`npm test`, `npm run test:multi`).

---

## 1. Identity mapping (شناسه‌ها)

| Homana concept | hbook resource | How to map |
| --- | --- | --- |
| مجموعه (clinic) | `Tenant` | One tenant per مجموعه. Store `tenant.id` + its API key (per-tenant key) in Homana's DB. |
| پزشک / منبع | `User` (isHost) | Store `user.id`. Optional `externalId` field: send Homana's own doctor id at creation and filter/lookup by it later. |
| خدمت | `EventType` | Store `eventTypeId` (or use `slug`). Optional `externalId` like doctors. |
| ساعات کاری | `Availability` + `DateOverride` | Always on the host user, minutes-from-midnight in the host timezone. |
| نوبت | `Booking` | Identified by `uid` (public, URL-safe) — use it in URLs and webhooks. Optional `externalId`. |
| بیمار | `attendee` (embedded in Booking) | Identified by normalized `phone` (`09…` / `+E.164`). No separate patient record; Homana keeps patient data. |

`externalId` is unique per tenant (`@@unique([tenantId, externalId])`) — a
second create with the same value returns `409 DUPLICATE`. This lets Homana
keep its own ids as the source of truth.

## 2. Auth & keys

```
X-API-Key: hbk_…            (or Authorization: Bearer hbk_…)
X-Setup-Token: …            (only for POST /v1/tenants — server-to-server, never in the frontend)
Idempotency-Key: <uuid>     (recommended on all booking mutations)
```

Scopes (hierarchical, `admin` ⊃ `manage` ⊃ `book` ⊃ `read`):

| Scope | Allowed |
| --- | --- |
| `read` | GET `/v1/me`, `/v1/slots`, `/v1/bookings`, `/v1/event-types`, `/v1/users` |
| `book` | + POST `/v1/bookings`, confirm / cancel / reschedule |
| `manage` | + users, event-types, availability, webhooks (create/list/delete/replay) |
| `admin` | + API key create/list/revoke/rotate |

Recommendation: Homana holds one `admin` key per tenant in its backend and,
if it ever needs a restricted integration (e.g. kiosk), issues a `book`-scoped
key via `POST /v1/api-keys {"scopes": ["book"]}`. Keys are stored hashed
(SHA-256), shown once, revocable (`DELETE /v1/api-keys/:id`) and rotatable
(`POST /v1/api-keys/:id/rotate` → new one-time secret, old key dies instantly).

## 3. Provisioning flow (ایجاد مجموعه)

```http
POST /v1/tenants
X-Setup-Token: <master token>
{
  "name": "کلینیک نمونه",
  "slug": "demo-clinic-1",
  "timezone": "Asia/Tehran",
  "owner": { "name": "دکتر سارا احمدی" }        // email OPTIONAL
}
→ 201 { tenant, owner, apiKey: { key: "hbk_…(once!)" } }
```

Then (with the tenant key): create doctors (`POST /v1/users`), set weekly
hours (`PUT /v1/users/:id/availability`), add day-off overrides
(`POST /v1/users/:id/availability/overrides`), create services
(`POST /v1/event-types`).

## 4. Services (خدمات) — capacity model

```json
{
  "slug": "checkup", "title": "ویزیت", "hostId": "…",
  "durationMin": 30, "slotIntervalMin": 30,
  "capacity": 3,                // concurrent patients per exact slot (default 1)
  "bufferBeforeMin": 5, "bufferAfterMin": 10,
  "minLeadMinutes": 120, "maxLeadDays": 60,
  "requiresConfirmation": false
}
```

**Seat semantics (documented behaviour, enforced in PostgreSQL):**

- `PENDING` and `CONFIRMED` bookings each consume one seat.
- `CANCELLED` frees its seat immediately (at the moment of cancellation).
- Reschedule frees the old window and consumes the new one **atomically**;
  status is preserved (PENDING stays PENDING, CONFIRMED stays CONFIRMED).
- Same service + same start time = one *seat group* → up to `capacity`
  active bookings. Even under concurrent requests across multiple engine
  instances the DB guarantees `active ≤ capacity` (seat counter row with
  `CHECK (taken <= capacity)` + `SELECT … FOR UPDATE` + per-host advisory
  lock + a constraint trigger as defense in depth).
- **Overlapping services with different durations/buffers:** every booking
  reserves `[startsAt − own.bufferBefore, endsAt + own.bufferAfter]`. Two
  bookings of *different* services (or different starts) collide iff their
  padded windows intersect. Buffers apply **between bookings**, not at the
  edges of working hours.
- Lowering `capacity` below already-taken seats is rejected with
  `422 CAPACITY_CONFLICT`.

## 5. Slot discovery (دریافت اسلات)

```http
GET /v1/slots?eventTypeId=<id|slug>&from=2026-01-10&to=2026-01-17&timezone=Asia/Tehran
→ 200 {
  "eventTypeId": "…", "hostId": "…", "timezone": "Asia/Tehran",
  "from": "2026-01-09T20:30:00.000Z", "to": "2026-01-16T20:30:00.000Z",
  "durationMinutes": 30, "capacity": 3,
  "slots": [ { "startsAt": "2026-01-10T05:30:00.000Z", "seatsRemaining": 3 }, … ]
}
```

- `from`/`to` accept `YYYY-MM-DD` (interpreted as local days in `timezone`)
  or full ISO-8601 instants. `to` is exclusive. Range cap: 62 days.
- Every time is **UTC ISO-8601** (`…Z`). The engine stores UTC and computes
  working hours in the host timezone; Iran's fixed +03:30 and DST zones are
  handled (unit-tested, incl. ambiguous/nonexistent wall times).
- Jalali display is Homana's concern: convert `startsAt` with any standard
  Jalali library; the API never restricts the calendar presentation.
- `seatsRemaining` lets the UI show "۲ صندلی باقی‌مانده".

## 6. Booking lifecycle (ثبت / تأیید / لغو / جابه‌جایی)

```http
POST /v1/bookings
Idempotency-Key: 7f9c…
{
  "eventTypeId": "…",
  "start": "2026-01-10T05:30:00.000Z",     // must match a slot exactly
  "attendee": {
    "name": "علی رضایی",
    "phone": "۰۹۱۲ ۳۴۵ ۶۷۸۹",               // REQUIRED — see §7
    "email": "optional@example.com",         // OPTIONAL
    "timezone": "Asia/Tehran", "notes": "…"
  }
}
→ 201 { uid, status: "CONFIRMED" | "PENDING", startsAt, endsAt, attendee{phone,email,name,…}, … }
```

- `status` is `PENDING` when the service has `requiresConfirmation: true`;
  confirm via `POST /v1/bookings/:uid/confirm`.
- Cancel: `POST /v1/bookings/:uid/cancel {"reason": "…"}` — frees the seat.
- Reschedule: `POST /v1/bookings/:uid/reschedule {"start": "…"}`.
- **Idempotency:** send a unique `Idempotency-Key` per logical operation.
  A network timeout followed by a retry returns the SAME response
  (`X-HBook-Idempotent-Replay: true`) instead of double-booking. Same key
  with a different body → `422 IDEMPOTENCY_KEY_REUSED`. Records live 24 h.
- **State machine:** `PENDING → CONFIRMED | CANCELLED`;
  `CONFIRMED → CANCELLED` (or reschedule, same status); `CANCELLED` is
  terminal. Racing confirm/cancel/reschedule are serialized per booking —
  the loser gets a stable `409`, the final state is always consistent.

## 7. Mobile numbers (شماره موبایل بیمار)

The patient's mobile is the only required contact field.

- Accepted inputs: `09123456789`, `+989123456789`, `0098…`, `98…`,
  `9123456789`, Persian digits (`۰۹۱۲…`), Arabic digits (`٠٩١٢…`), with
  spaces/dashes/parentheses anywhere.
- Normalized to `09xxxxxxxxx` (Iranian) or `+E.164` (other countries) and
  stored normalized — the same patient with different formats is the same
  phone for filters (`GET /v1/bookings?attendeePhone=…`) and webhooks.
- Invalid numbers → `422 INVALID_PHONE`.
- **No fake emails anywhere:** tenant owners, doctors and patients can all
  be created without an email.

## 8. Webhooks (رویدادها)

Subscribe: `POST /v1/webhooks {"url": "https://homana.example/hooks/hbook", "events": ["booking.created", …]}`.
The signing secret is returned **once** and stored encrypted at rest
(AES-256-GCM, key = `HBOOK_WEBHOOK_ENC_KEY`).

```
POST <your url>
content-type: application/json
x-hbook-event: booking.created
x-hbook-event-id: <stable uuid — SAME on every attempt of this event>
x-hbook-delivery-id: <one id per webhook subscription>
x-hbook-signature: t=1765432100,v1=hex

{"id":"<event-id>","event":"booking.created","createdAt":"…","data":{
  "uid":"…","tenantId":"…","eventTypeId":"…","hostId":"…",
  "status":"CONFIRMED","startsAt":"…Z","endsAt":"…Z"}}
```

Verification (consumer side):

```js
const expected = hmacSHA256(secret, `${t}.${rawBody}`);   // t from the header
timingSafeEqual(expected, v1);                            // then check |t - now| ≤ 300s
```

Delivery guarantees:

- **Transactional outbox:** the event row is committed in the same
  transaction as the booking change → a crash never loses an event.
- **At-least-once:** retries with bounded backoff (1s, 4s, 16s, 64s by
  default), then `FAILED` (visible via `GET /v1/webhooks/:id/deliveries`,
  re-sendable via `POST …/deliveries/:deliveryId/replay`). Duplicates are
  possible — consumers MUST dedupe on `x-hbook-event-id`.
- Survives restarts (rows persist; stuck in-flight rows are re-queued).
- Destinations are SSRF-guarded: public hosts only, HTTPS mandatory in
  production (plain http/private IPs only in non-production with explicit
  flags), redirects re-validated hop-by-hop.
- **No patient PII** in payloads (ids, times, status only) — Homana owns
  the patient data and can enrich events locally.

## 9. Error envelope & Persian messages (خطاها)

Every error: `{ "error": { "code": "...", "message": "...", "details": ... } }`.

| code | HTTP | فارسی (پیشنهادی برای UI) |
| --- | --- | --- |
| `UNAUTHORIZED` | 401 | کلید API ارسال نشده است. |
| `INVALID_API_KEY` | 401 | کلید API نامعتبر است. |
| `API_KEY_REVOKED` | 401 | کلید API لغو شده است. |
| `API_KEY_EXPIRED` | 401 | کلید API منقضی شده است. |
| `SCOPE_INSUFFICIENT` | 403 | این کلید اجازهٔ این عملیات را ندارد. |
| `RATE_LIMITED` | 429 | تعداد درخواست‌ها زیاد است؛ کمی بعد تلاش کنید. |
| `NOT_FOUND` | 404 | موردی یافت نشد. |
| `DUPLICATE` | 409 | این مقدار قبلاً ثبت شده است. |
| `SLUG_TAKEN` | 409 | این شناسهٔ مجموعه/خدمت قبلاً استفاده شده است. |
| `SLOT_TAKEN` | 409 | این بازه همین حالا رزرو شد؛ اسلات جدید بگیرید. |
| `ALREADY_CANCELLED` | 409 | این نوبت قبلاً لغو شده است. |
| `NOT_PENDING` | 409 | فقط نوبت‌های در انتظار تأیید قابل تأیید هستند. |
| `BOOKING_CANCELLED` | 409 | نوبت لغوشده قابل جابه‌جایی نیست. |
| `IDEMPOTENCY_KEY_REUSED` | 422 | این کلید idempotency با درخواست دیگری استفاده شده است. |
| `IDEMPOTENCY_IN_PROGRESS` | 409 | درخواست اصلی با این کلید هنوز در حال پردازش است. |
| `SLOT_UNAVAILABLE` | 422 | این بازه قابل رزرو نیست؛ از فهرست اسلات‌ها استفاده کنید. |
| `INVALID_PHONE` | 422 | شماره موبایل معتبر نیست (مثال: ۰۹۱۲۳۴۵۶۷۸۹). |
| `INVALID_START` | 422 | زمان شروع معتبر نیست. |
| `INVALID_TIMEZONE` | 422 | منطقهٔ زمانی معتبر نیست. |
| `INVALID_RANGE` | 422 | بازهٔ زمانی نامعتبر است. |
| `RANGE_TOO_LARGE` | 422 | بازهٔ درخواست اسلات بیش از حد بزرگ است. |
| `HOST_REQUIRED` / `HOST_INVALID` | 422 | پزشکِ میزبان مشخص/معتبر نیست. |
| `CAPACITY_CONFLICT` | 422 | کاهش ظرفیت زیر تعداد صندلی‌های رزروشده ممکن نیست. |
| `EVENT_TYPE_IN_USE` | 409 | این خدمت نوبت دارد؛ به‌جای حذف، غیرفعالش کنید. |
| `INSECURE_WEBHOOK_URL` | 422 | آدرس وب‌هوک باید https باشد. |
| `FORBIDDEN_WEBHOOK_TARGET` | 422 | مقصد وب‌هوک مجاز نیست (آدرس داخلی/خصوصی). |
| `VALIDATION_ERROR` | 422 | دادهٔ ارسالی معتبر نیست (جزئیات در `details`). |
| `INTERNAL` | 500 | خطای داخلی موتور؛ بعداً تلاش کنید. |

## 10. Time & calendar (زمان)

- Storage and transport: **UTC ISO-8601 with `Z`** — always.
- Working hours: minutes-from-local-midnight in the host/tenant timezone
  (`"09:00"`-`"17:00"` style in the availability API).
- `Asia/Tehran` (fixed +03:30 since 2022) fully supported; DST zones are
  unit-tested including the ambiguous/fall-back and nonexistent/spring-forward
  wall times (a wall time maps deterministically to one UTC instant).
- Jalali (شمسی) rendering: do it in Homana's frontend from the UTC instant.
  The engine never emits Jalali and never needs it as input — date-only
  parameters (`YYYY-MM-DD`) are interpreted in the resolved timezone.

## 11. Minimal adapter example (Node, Homana side)

```js
const BASE = 'https://hbook.internal';
const KEY = process.env.HBOOK_KEY_TENANT_1; // server-side only!

async function book(doctorService, slot, patient) {
  const res = await fetch(`${BASE}/v1/bookings`, {
    method: 'POST',
    headers: {
      'x-api-key': KEY,
      'content-type': 'application/json',
      'idempotency-key': crypto.randomUUID(),          // one per logical op
    },
    body: JSON.stringify({
      eventTypeId: doctorService.hbookEventTypeId,      // stored mapping
      hostId: doctorService.hbookHostId,
      start: slot.startsAt,                             // from GET /v1/slots
      attendee: { name: patient.fullName, phone: patient.mobile },
    }),
  });
  const body = await res.json();
  if (res.ok) return { uid: body.uid };
  throw new HomanaError(body.error.code, FA_MESSAGES[body.error.code] ?? body.error.message);
}
```

## 12. Swappability (قابلیت تعویض موتور)

Everything Homana needs is in this contract: provisioning, resources,
slot discovery, lifecycle, idempotency, errors with stable codes, signed
events with stable ids, UTC times. To swap engines later, implement this
same surface in the replacement and point the adapter's `BASE` at it —
Homana's data model only stores `(engineBaseUrl?, apiKey, tenantId,
userId?, eventTypeId?, bookingUid)` per object plus `externalId`.
