#!/usr/bin/env node
/**
 * hbook — end-to-end test suite v2 (zero dependencies, Node ≥ 20).
 *
 * Prerequisites:
 *   - a running hbook server   (BASE_URL, default http://127.0.0.1:3100)
 *                              started with HBOOK_WEBHOOK_ALLOW_INSECURE_HTTP=1
 *                              and HBOOK_WEBHOOK_ALLOW_PRIVATE_IPS=1 (test
 *                              escape hatch for the local receiver)
 *   - the master setup token   (HBOOK_SETUP_TOKEN env)
 *
 * Covers: health/docs, auth guards, tenant provisioning (no owner email),
 * users/availability/event types (capacity), slots with seatsRemaining,
 * mobile-only booking (Persian/Arabic digits, +98/0098 dedupe), buffer
 * regression (slots == booking == reschedule), concurrent booking races for
 * capacity 1 and 3, cross-tenant isolation matrix, webhook HMAC + minimal
 * (no-PII) payloads + retry with stable event id + redirect following +
 * replay + duplicate detection, confirm/cancel/reschedule races,
 * idempotency (retry-after-timeout), API key scopes + rotation,
 * rate limiting incl. invalid-key rotation and XFF spoofing.
 *
 * Usage:
 *   BASE_URL=http://127.0.0.1:3100 HBOOK_SETUP_TOKEN=… node scripts/e2e.mjs
 */
import { spawn } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const BASE = process.env.BASE_URL ?? 'http://127.0.0.1:3100';
const SETUP_TOKEN = process.env.HBOOK_SETUP_TOKEN ?? '';
const HOOK_PORT = Number(process.env.HOOK_PORT ?? 4919);
const WEBHOOK_SECRET = 'e2e-whsec-0123456789abcdef0123456789abcdef';

let passed = 0;
let failed = 0;
const failures = [];

function ok(name, cond, extra = '') {
  if (cond) {
    passed++;
    console.log(`  ✔ ${name}`);
  } else {
    failed++;
    failures.push(name);
    console.log(`  ✘ ${name} ${extra ? `— ${extra}` : ''}`);
  }
}

function section(title) {
  console.log(`\n▸ ${title}`);
}

async function api(method, path, { key, body, headers = {} } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(key ? { 'x-api-key': key } : {}),
      ...headers,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* non-JSON */
  }
  return { status: res.status, json, text, headers: res.headers };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(predicate, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await fetch(`http://127.0.0.1:${HOOK_PORT}/received`);
    const events = await res.json();
    const hit = events.find(predicate);
    if (hit) return hit;
    await sleep(200);
  }
  return null;
}

async function receiverCount() {
  const res = await fetch(`http://127.0.0.1:${HOOK_PORT}/received`);
  return (await res.json()).length;
}

// ─────────────────────────────────────────────────────────────────────
async function main() {
  if (!SETUP_TOKEN) {
    console.error('HBOOK_SETUP_TOKEN env is required');
    process.exit(2);
  }

  const receiver = spawn(process.execPath, [fileURLToPath(new URL('./webhook-receiver.js', import.meta.url))], {
    env: { ...process.env, PORT: String(HOOK_PORT), WEBHOOK_SECRET, RECEIVER_FAIL_FIRST: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await sleep(600);

  try {
    await run();
  } finally {
    receiver.kill('SIGTERM');
  }

  console.log(`\n${'═'.repeat(60)}`);
  console.log(`RESULT: ${passed} passed, ${failed} failed`);
  if (failed > 0) {
    console.log('Failed:', failures.join(' | '));
    process.exit(1);
  }
}

async function run() {
  const TAG = Date.now().toString(36);

  // ── 1. system ────────────────────────────────────────────────────
  section('System');
  {
    const h = await api('GET', '/health');
    ok('GET /health → 200 + db up', h.status === 200 && h.json?.db === 'up', JSON.stringify(h.json));
    const root = await api('GET', '/');
    ok('GET / → banner', root.status === 200 && root.json?.name === 'hbook');
    const docs = await api('GET', '/docs');
    ok('GET /docs → Swagger UI', docs.status === 200 && docs.text.includes('swagger'));
    const spec = await api('GET', '/docs/json');
    ok('OpenAPI JSON exposes paths', spec.status === 200 && Object.keys(spec.json?.paths ?? {}).length >= 20);
  }

  // ── 2. auth & provisioning guards ────────────────────────────────
  section('Auth guards');
  {
    const noKey = await api('GET', '/v1/me');
    ok('no API key → 401 UNAUTHORIZED', noKey.status === 401 && noKey.json?.error?.code === 'UNAUTHORIZED');
    const badKey = await api('GET', '/v1/me', { key: 'hbk_totally-invalid-key' });
    ok('invalid key → 401 INVALID_API_KEY', badKey.status === 401 && badKey.json?.error?.code === 'INVALID_API_KEY');
    const badToken = await api('POST', '/v1/tenants', {
      headers: { 'x-setup-token': 'wrong-token-123456' },
      body: { name: 'xx', slug: 'xx', owner: {} },
    });
    ok('tenant create with wrong token → 401', badToken.status === 401 && badToken.json?.error?.code === 'SETUP_TOKEN_INVALID', `status ${badToken.status}`);
  }

  // ── 3. tenant A provisioning (owner WITHOUT email) ───────────────
  section('Tenant provisioning (email-free owner)');
  let KEY_A, TENANT_A;
  {
    const res = await api('POST', '/v1/tenants', {
      headers: { 'x-setup-token': SETUP_TOKEN },
      body: {
        name: 'E2E Clinic A',
        slug: `e2e-clinic-a-${TAG}`,
        timezone: 'Asia/Tehran',
        owner: { name: 'Dr. E2E' },
      },
    });
    ok('tenant create without owner email → 201 + one-time key', res.status === 201 && /^hbk_[A-Za-z0-9_-]{32}$/.test(res.json?.apiKey?.key ?? ''), JSON.stringify(res.json).slice(0, 160));
    KEY_A = res.json.apiKey.key;
    TENANT_A = res.json.tenant;
    ok('owner has null email', res.json.owner?.email === null || res.json.owner?.email === undefined, JSON.stringify(res.json.owner));

    const me = await api('GET', '/v1/me', { key: KEY_A });
    ok('GET /v1/me → tenant + scopes + masked key', me.status === 200 && Array.isArray(me.json?.apiKey?.scopes) && !JSON.stringify(me.json).includes(KEY_A));
  }

  // ── 4. users, availability, event types ──────────────────────────
  section('Users / Availability / Event types');
  let USER_ID, EVENT_TYPE_ID, EVENT_TYPE_C3_ID, EVENT_TYPE_BUF_ID;
  {
    const u1 = await api('POST', '/v1/users', {
      key: KEY_A,
      body: { name: 'Dr. Host', timezone: 'Asia/Tehran', externalId: `homana-doc-${TAG}` },
    });
    ok('create host user WITHOUT email → 201', u1.status === 201 && (u1.json?.email === null || u1.json?.email === undefined), JSON.stringify(u1.json).slice(0, 120));
    USER_ID = u1.json.id;

    const u2 = await api('POST', '/v1/users', {
      key: KEY_A,
      body: { name: 'Dr. Second', email: `host2-${TAG}@e2e.test`, timezone: 'Asia/Tehran' },
    });
    ok('create user WITH email still works → 201', u2.status === 201 && u2.json?.email === `host2-${TAG}@e2e.test`);

    const av = await api('PUT', `/v1/users/${USER_ID}/availability`, {
      key: KEY_A,
      body: {
        weekly: [
          { weekday: 6, windows: [{ start: '09:00', end: '12:00' }] },
          { weekday: 0, windows: [{ start: '09:00', end: '12:00' }, { start: '13:00', end: '17:00' }] },
          { weekday: 1, windows: [{ start: '09:00', end: '17:00' }] },
          { weekday: 2, windows: [{ start: '09:00', end: '17:00' }] },
          { weekday: 3, windows: [{ start: '09:00', end: '17:00' }] },
          { weekday: 4, windows: [{ start: '09:00', end: '17:00' }] },
          { weekday: 5, windows: [{ start: '09:00', end: '17:00' }] },
        ],
      },
    });
    ok('PUT availability → 7 weekdays', av.status === 200 && av.json?.weekly?.length === 7);

    const et = await api('POST', '/v1/event-types', {
      key: KEY_A,
      body: { slug: 'e2e-visit', title: 'E2E visit', hostId: USER_ID, durationMin: 30, slotIntervalMin: 30, minLeadMinutes: 0, maxLeadDays: 30, externalId: `homana-svc-${TAG}` },
    });
    ok('create event type (capacity default 1) → 201', et.status === 201 && et.json?.capacity === 1);
    EVENT_TYPE_ID = et.json.id;

    const et3 = await api('POST', '/v1/event-types', {
      key: KEY_A,
      body: { slug: 'e2e-group', title: 'E2E group visit', hostId: USER_ID, durationMin: 30, slotIntervalMin: 30, capacity: 3, minLeadMinutes: 0, maxLeadDays: 30 },
    });
    ok('create event type capacity=3 → 201', et3.status === 201 && et3.json?.capacity === 3);
    EVENT_TYPE_C3_ID = et3.json.id;

    // buffer regression subject: 15 min duration, 30 min AFTER buffer
    const etb = await api('POST', '/v1/event-types', {
      key: KEY_A,
      body: { slug: 'e2e-buffered', title: 'E2E buffered', hostId: USER_ID, durationMin: 15, slotIntervalMin: 15, bufferAfterMin: 30, minLeadMinutes: 0, maxLeadDays: 30 },
    });
    ok('create buffered event type (after=30) → 201', etb.status === 201 && etb.json?.bufferAfterMin === 30);
    EVENT_TYPE_BUF_ID = etb.json.id;

    const badCap = await api('POST', '/v1/event-types', {
      key: KEY_A,
      body: { slug: 'e2e-bad-cap', title: 'bad', durationMin: 15, capacity: 0 },
    });
    ok('capacity=0 → 422 validation', badCap.status === 422);
  }

  // ── 5. slots ─────────────────────────────────────────────────────
  section('Slot discovery (seatsRemaining)');
  let SLOT_1, SLOT_2, SLOT_3;
  let RANGE_FROM, RANGE_TO;
  {
    RANGE_FROM = new Date().toISOString().slice(0, 10);
    RANGE_TO = new Date(Date.now() + 9 * 86_400_000).toISOString().slice(0, 10);
    const s = await api('GET', `/v1/slots?eventTypeId=${EVENT_TYPE_ID}&from=${RANGE_FROM}&to=${RANGE_TO}&timezone=Asia/Tehran`, { key: KEY_A });
    ok('GET /v1/slots → ascending objects', s.status === 200 && Array.isArray(s.json?.slots) && s.json.slots.length >= 5, `got ${s.json?.slots?.length ?? 0}`);
    ok('slot objects carry seatsRemaining', s.json.slots.every((x) => typeof x.seatsRemaining === 'number'));
    const slots = s.json.slots.map((x) => x.startsAt);
    ok('slots are 30-min apart and aligned', slots.length >= 2 && (new Date(slots[1]) - new Date(slots[0])) === 1_800_000);
    SLOT_1 = slots[0];
    SLOT_2 = slots[1];
    SLOT_3 = slots[2];

    const s2 = await api('GET', `/v1/slots?eventTypeId=nonexistent&from=${RANGE_FROM}&to=${RANGE_TO}`, { key: KEY_A });
    ok('unknown event type → 404', s2.status === 404);

    // date override: close the day of SLOT_1 and verify it disappears
    const slot1DayTehran = new Date(SLOT_1).toLocaleDateString('en-CA', { timeZone: 'Asia/Tehran' });
    const ov = await api('POST', `/v1/users/${USER_ID}/availability/overrides`, {
      key: KEY_A,
      body: { date: slot1DayTehran, closed: true },
    });
    ok('date override (day off) → 201', ov.status === 201);
    const s3 = await api('GET', `/v1/slots?eventTypeId=${EVENT_TYPE_ID}&from=${RANGE_FROM}&to=${RANGE_TO}&timezone=Asia/Tehran`, { key: KEY_A });
    ok('closed day produces no slots', s3.status === 200 && !s3.json.slots.some((x) => new Date(x.startsAt).toLocaleDateString('en-CA', { timeZone: 'Asia/Tehran' }) === slot1DayTehran));
    await api('DELETE', `/v1/users/${USER_ID}/availability/overrides/${slot1DayTehran}`, { key: KEY_A });
  }

  // ── 6. booking lifecycle (mobile, no email) ──────────────────────
  section('Booking lifecycle (mobile-first)');
  let BOOKING_UID;
  {
    const b = await api('POST', '/v1/bookings', {
      key: KEY_A,
      body: {
        eventTypeId: EVENT_TYPE_ID,
        start: SLOT_1,
        attendee: { name: 'علی تست', phone: '۰۹۱۲۳۴۵۶۷۸۹', timezone: 'Asia/Tehran', notes: 'first visit' },
      },
    });
    ok('book with PERSIAN-digit phone, no email → 201 CONFIRMED', b.status === 201 && b.json?.status === 'CONFIRMED', JSON.stringify(b.json).slice(0, 160));
    ok('phone normalized to 09123456789', b.json?.attendee?.phone === '09123456789', `got ${b.json?.attendee?.phone}`);
    BOOKING_UID = b.json?.uid;

    const again = await api('POST', '/v1/bookings', {
      key: KEY_A,
      body: { eventTypeId: EVENT_TYPE_ID, start: SLOT_1, attendee: { name: 'Second', phone: '+989123456789' } },
    });
    const againRejected = again.status === 409 || (again.status === 422 && again.json?.error?.code === 'SLOT_UNAVAILABLE');
    ok('same slot again (capacity 1) → 409/422 rejected', againRejected, `status ${again.status} ${again.json?.error?.code}`);

    const misaligned = await api('POST', '/v1/bookings', {
      key: KEY_A,
      body: { eventTypeId: EVENT_TYPE_ID, start: new Date(new Date(SLOT_2).getTime() + 7 * 60_000).toISOString(), attendee: { name: 'Off', phone: '09120000000' } },
    });
    ok('off-grid time → 422 SLOT_UNAVAILABLE', misaligned.status === 422 && misaligned.json?.error?.code === 'SLOT_UNAVAILABLE');

    const badPhone = await api('POST', '/v1/bookings', {
      key: KEY_A,
      body: { eventTypeId: EVENT_TYPE_ID, start: SLOT_3, attendee: { name: 'No Phone', phone: '12345678' } },
    });
    ok('invalid phone → 422 INVALID_PHONE', badPhone.status === 422 && badPhone.json?.error?.code === 'INVALID_PHONE');

    const getOne = await api('GET', `/v1/bookings/${BOOKING_UID}`, { key: KEY_A });
    ok('GET booking by uid (phone present, email null)', getOne.status === 200 && getOne.json?.attendee?.phone === '09123456789' && (getOne.json?.attendee?.email === null || getOne.json?.attendee?.email === undefined));

    // same patient, different formats → same normalized phone (filter dedupe)
    const b2 = await api('POST', '/v1/bookings', {
      key: KEY_A,
      body: { eventTypeId: EVENT_TYPE_ID, start: SLOT_3, attendee: { name: 'علی تست', phone: '0098 912 345 6789' } },
    });
    ok('second booking same patient (+0098 format) → 201', b2.status === 201, JSON.stringify(b2.json?.error ?? '').slice(0, 140));
    ok('phone format normalized identically', b2.json?.attendee?.phone === '09123456789');

    const byPhone = await api('GET', `/v1/bookings?attendeePhone=${encodeURIComponent('۰۹۱۲-۳۴۵-۶۷۸۹')}`, { key: KEY_A });
    ok('filter by phone (yet another format) finds both bookings', byPhone.status === 200 && byPhone.json?.items?.length === 2, `got ${byPhone.json?.items?.length}`);

    const list = await api('GET', `/v1/bookings?limit=1`, { key: KEY_A });
    ok('list bookings + cursor', list.status === 200 && list.json?.items?.length === 1 && typeof list.json?.nextCursor === 'string');
    const page2 = await api('GET', `/v1/bookings?limit=1&cursor=${list.json.nextCursor}`, { key: KEY_A });
    ok('cursor pagination page 2', page2.status === 200 && page2.json?.items?.length === 1 && page2.json?.items?.[0]?.uid !== list.json.items[0].uid);
  }

  // ── 7. buffer regression (THE reported bug) ──────────────────────
  section('Buffer regression (slots == booking == reschedule)');
  {
    const s = await api('GET', `/v1/slots?eventTypeId=${EVENT_TYPE_BUF_ID}&from=${RANGE_FROM}&to=${RANGE_TO}&timezone=Asia/Tehran`, { key: KEY_A });
    const bufSlots = s.json.slots.map((x) => x.startsAt);
    ok('buffered event type has slots', bufSlots.length >= 3, `got ${bufSlots.length}`);
    const first = bufSlots[0];
    const second = bufSlots[1];

    const b = await api('POST', '/v1/bookings', {
      key: KEY_A,
      body: { eventTypeId: EVENT_TYPE_BUF_ID, start: first, attendee: { name: 'Buf One', phone: '09350000001' } },
    });
    ok('book first buffered slot → 201', b.status === 201, JSON.stringify(b.json?.error ?? '').slice(0, 140));

    const s2 = await api('GET', `/v1/slots?eventTypeId=${EVENT_TYPE_BUF_ID}&from=${RANGE_FROM}&to=${RANGE_TO}&timezone=Asia/Tehran`, { key: KEY_A });
    const afterList = s2.json.slots.map((x) => x.startsAt);
    const hiddenByBuffer = afterList.filter((x) => new Date(x) < new Date(new Date(first).getTime() + 45 * 60_000));
    ok('list HIDES the next intervals inside the 30-min after-buffer', hiddenByBuffer.length === 0, `visible too early: ${hiddenByBuffer.join(',')}`);

    const direct = await api('POST', '/v1/bookings', {
      key: KEY_A,
      body: { eventTypeId: EVENT_TYPE_BUF_ID, start: second, attendee: { name: 'Buf Sneak', phone: '09350000002' } },
    });
    ok('REGRESSION: direct booking of the hidden interval → 422 (was accepted before)', direct.status === 422 && direct.json?.error?.code === 'SLOT_UNAVAILABLE', `status ${direct.status} ${direct.json?.error?.code}`);

    // the interval 45+ min later IS bookable (buffer expired)
    const third = afterList.find((x) => new Date(x) >= new Date(new Date(first).getTime() + 45 * 60_000));
    const okBooking = await api('POST', '/v1/bookings', {
      key: KEY_A,
      body: { eventTypeId: EVENT_TYPE_BUF_ID, start: third, attendee: { name: 'Buf Two', phone: '09350000003' } },
    });
    ok('interval after buffer window → 201', okBooking.status === 201, JSON.stringify(okBooking.json?.error ?? '').slice(0, 140));

    // reschedule agreement: moving ANOTHER booking onto the buffered-out interval fails
    const rs = await api('POST', `/v1/bookings/${okBooking.json.uid}/reschedule`, { key: KEY_A, body: { start: second } });
    ok('reschedule onto buffered-out interval → 422 (same rule as create)', rs.status === 422 && rs.json?.error?.code === 'SLOT_UNAVAILABLE', `status ${rs.status} ${rs.json?.error?.code}`);

    // cross-service buffers: 30-min consult (5/5 buffers) vs 15-min buffered
    const sc = await api('GET', `/v1/slots?eventTypeId=${EVENT_TYPE_ID}&from=${RANGE_FROM}&to=${RANGE_TO}&timezone=Asia/Tehran`, { key: KEY_A });
    const consultSlot = sc.json.slots.map((x) => x.startsAt).find((x) => Math.abs(new Date(x) - new Date(third)) < 40 * 60_000);
    if (consultSlot) {
      const cb = await api('POST', '/v1/bookings', {
        key: KEY_A,
        body: { eventTypeId: EVENT_TYPE_ID, start: consultSlot, attendee: { name: 'Cross', phone: '09350000004' } },
      });
      const conflictOrOk = cb.status === 201 || cb.status === 409;
      ok('cross-service buffered overlap is consistently judged (409 or 201, never silent)', conflictOrOk, `status ${cb.status}`);
    }
  }

  // ── 8. capacity 1 race ───────────────────────────────────────────
  section('Concurrency race (capacity = 1)');
  {
    const attempts = await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        api('POST', '/v1/bookings', {
          key: KEY_A,
          body: { eventTypeId: EVENT_TYPE_ID, start: SLOT_2, attendee: { name: `Racer ${i}`, phone: `0936${String(1000000 + i).slice(-7)}` } },
        }),
      ),
    );
    const wins = attempts.filter((a) => a.status === 201);
    const rejects = attempts.filter((a) => a.status >= 400);
    ok('exactly 1 of 6 concurrent bookings wins', wins.length === 1 && rejects.length === 5, `wins=${wins.length} rejects=${rejects.map((r) => r.status).join(',')}`);
  }

  // ── 9. capacity 3 race ───────────────────────────────────────────
  section('Concurrency race (capacity = 3)');
  {
    const s = await api('GET', `/v1/slots?eventTypeId=${EVENT_TYPE_C3_ID}&from=${RANGE_FROM}&to=${RANGE_TO}&timezone=Asia/Tehran`, { key: KEY_A });
    const gslot = s.json.slots[0]?.startsAt;
    ok('group event type has a slot', !!gslot);

    const attempts = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        api('POST', '/v1/bookings', {
          key: KEY_A,
          body: { eventTypeId: EVENT_TYPE_C3_ID, start: gslot, attendee: { name: `Group ${i}`, phone: `0937${String(2000000 + i).slice(-7)}` } },
        }),
      ),
    );
    const wins = attempts.filter((a) => a.status === 201);
    ok('capacity 3 → exactly 3 of 8 win', wins.length === 3, `wins=${wins.length} statuses=${attempts.map((a) => a.status).join(',')}`);

    const s2 = await api('GET', `/v1/slots?eventTypeId=${EVENT_TYPE_C3_ID}&from=${RANGE_FROM}&to=${RANGE_TO}&timezone=Asia/Tehran`, { key: KEY_A });
    const now = s2.json.slots.find((x) => x.startsAt === gslot);
    ok('full slot disappears from the list (seatsRemaining 0 → hidden)', !now, JSON.stringify(now ?? ''));

    const cn = await api('POST', `/v1/bookings/${wins[0].json.uid}/cancel`, { key: KEY_A, body: { reason: 'free a seat' } });
    ok('cancel one group booking → 200', cn.status === 200);
    const s3 = await api('GET', `/v1/slots?eventTypeId=${EVENT_TYPE_C3_ID}&from=${RANGE_FROM}&to=${RANGE_TO}&timezone=Asia/Tehran`, { key: KEY_A });
    const again = s3.json.slots.find((x) => x.startsAt === gslot);
    ok('cancelled seat frees capacity → slot visible again with 1 seat', again && again.seatsRemaining === 1, JSON.stringify(again ?? ''));

    // capacity shrink below taken seats must fail
    const patch = await api('PATCH', `/v1/event-types/${EVENT_TYPE_C3_ID}`, { key: KEY_A, body: { capacity: 2 } });
    ok('lower capacity to 2 (taken 2 ≤ 2) → 200', patch.status === 200 && patch.json?.capacity === 2, JSON.stringify(patch.json?.error ?? '').slice(0, 140));
  }

  // ── 10. webhooks: HMAC, minimal payload, retries, replay, redirect ──
  section('Webhooks (HMAC · outbox · SSRF-safe)');
  let WEBHOOK_ID;
  {
    const w = await api('POST', '/v1/webhooks', {
      key: KEY_A,
      body: {
        url: `http://127.0.0.1:${HOOK_PORT}/hooks/hbook`,
        events: ['booking.created', 'booking.cancelled', 'booking.rescheduled', 'booking.confirmed', 'ping'],
        secret: WEBHOOK_SECRET,
      },
    });
    ok('create webhook → 201 (secret echoed once)', w.status === 201 && w.json?.secret === WEBHOOK_SECRET);
    WEBHOOK_ID = w.json.id;

    const ping = await api('POST', `/v1/webhooks/${WEBHOOK_ID}/ping`, { key: KEY_A });
    ok('ping → 202 queued', ping.status === 202);
    const got = await waitFor((e) => e.event === 'ping');
    ok('ping received with VALID HMAC signature', got && got.verified === true, got ? got.reason : 'not received');
    ok('envelope carries stable event id header', !!got?.eventId);

    // minimal payload: no patient PII
    const s = await api('GET', `/v1/slots?eventTypeId=${EVENT_TYPE_ID}&from=${RANGE_FROM}&to=${RANGE_TO}&timezone=Asia/Tehran`, { key: KEY_A });
    const free = s.json.slots.map((x) => x.startsAt).find((x) => x !== SLOT_1 && x !== SLOT_2 && x !== SLOT_3);
    const wb = await api('POST', '/v1/bookings', {
      key: KEY_A,
      body: { eventTypeId: EVENT_TYPE_ID, start: free, attendee: { name: 'Webhook Patient', phone: '09380000001' } },
    });
    ok('booking for webhook → 201', wb.status === 201);
    const wEvent = await waitFor((e) => e.event === 'booking.created' && e.body?.data?.uid === wb.json.uid);
    ok('booking.created webhook received & signed', wEvent && wEvent.verified === true, wEvent ? wEvent.reason : 'not received');
    const dataStr = JSON.stringify(wEvent?.body ?? {});
    ok('webhook payload contains NO patient PII', !dataStr.includes('Webhook Patient') && !dataStr.includes('09380000001') && !dataStr.includes('attendee'), dataStr.slice(0, 200));
    ok('webhook payload carries uid/status/times', wEvent?.body?.data?.uid === wb.json.uid && !!wEvent?.body?.data?.startsAt && !!wEvent?.body?.data?.status);

    // delivery queue state + attempts
    const dl = await api('GET', `/v1/webhooks/${WEBHOOK_ID}/deliveries?limit=5`, { key: KEY_A });
    ok('delivery rows listed with status/attempts/eventId', dl.status === 200 && dl.json?.items?.length >= 2 && dl.json.items.every((x) => x.status === 'DELIVERED' && typeof x.attempts === 'number' && !!x.eventId));

    // retry with stable event id: flaky receiver fails twice, then accepts
    await fetch(`http://127.0.0.1:${HOOK_PORT}/reset`, { method: 'POST' });
    const flaky = spawn(process.execPath, [fileURLToPath(new URL('./webhook-receiver.js', import.meta.url))], {
      env: { ...process.env, PORT: String(HOOK_PORT + 1), WEBHOOK_SECRET, RECEIVER_FAIL_FIRST: '2' },
      stdio: 'ignore',
    });
    await sleep(500);
    const w3 = await api('POST', '/v1/webhooks', {
      key: KEY_A,
      body: { url: `http://127.0.0.1:${HOOK_PORT + 1}/hooks/flaky`, events: ['ping'], secret: WEBHOOK_SECRET },
    });
    ok('flaky webhook created → 201', w3.status === 201);
    const ping2 = await api('POST', `/v1/webhooks/${w3.json.id}/ping`, { key: KEY_A });
    ok('ping to fail-twice receiver → 202', ping2.status === 202);
    await sleep(9000); // backoff 1s + 4s → 3rd attempt succeeds
    const recv2 = await fetch(`http://127.0.0.1:${HOOK_PORT + 1}/received`).then((r) => r.json());
    ok('delivery retried after failures and succeeded', recv2.length === 1, `received ${recv2.length}`);
    const dlFlaky = await api('GET', `/v1/webhooks/${w3.json.id}/deliveries`, { key: KEY_A });
    const row = dlFlaky.json?.items?.[0];
    ok('delivery row shows attempts ≥ 3 and DELIVERED', row?.status === 'DELIVERED' && row?.attempts >= 3, JSON.stringify(row ?? {}));
    flaky.kill('SIGTERM');

    // redirect following: 307 → final target receives the signed event
    const wr = await api('POST', '/v1/webhooks', {
      key: KEY_A,
      body: { url: `http://127.0.0.1:${HOOK_PORT}/redirect`, events: ['ping'], secret: WEBHOOK_SECRET },
    });
    const ping3 = await api('POST', `/v1/webhooks/${wr.json.id}/ping`, { key: KEY_A });
    const rEvent = await waitFor((e) => e.event === 'ping' && e.body?.data?.webhookId === wr.json.id);
    ok('307 redirect followed → signed event lands on final target', ping3.status === 202 && rEvent && rEvent.verified === true, rEvent ? rEvent.reason : 'not received');

    // https enforcement (no escape flag for https? http allowed here via flag —
    // verify the flag DOES NOT leak into webhook secret handling instead)
    const dl2 = await api('GET', `/v1/webhooks/${WEBHOOK_ID}/deliveries?status=DELIVERED`, { key: KEY_A });
    ok('deliveries filter by status works', dl2.status === 200 && dl2.json?.items?.every((x) => x.status === 'DELIVERED'));

    // replay a delivery
    const targetDelivery = dl2.json.items[0];
    const replay = await api('POST', `/v1/webhooks/${WEBHOOK_ID}/deliveries/${targetDelivery.id}/replay`, { key: KEY_A });
    ok('replay → 202 queued', replay.status === 202);
    let replayedRow = null;
    for (let i = 0; i < 30; i++) {
      await sleep(400);
      const chk = await api('GET', `/v1/webhooks/${WEBHOOK_ID}/deliveries?limit=50`, { key: KEY_A });
      replayedRow = chk.json?.items?.find((x) => x.id === targetDelivery.id);
      if (replayedRow && replayedRow.status === 'DELIVERED' && replayedRow.attempts >= 1) break;
    }
    ok('replayed delivery re-sent (fresh attempt, DELIVERED again)', replayedRow && replayedRow.status === 'DELIVERED' && replayedRow.attempts >= 1, JSON.stringify(replayedRow ?? {}));
    const replayHit = await waitFor((e) => e.deliveryId === targetDelivery.id, 6000);
    ok('replayed delivery arrived at receiver with same delivery id', !!replayHit);
  }

  // ── 11. confirm / cancel / reschedule races ──────────────────────
  section('Confirm / Cancel / Reschedule (incl. races)');
  {
    const et2 = await api('POST', '/v1/event-types', {
      key: KEY_A,
      body: { slug: 'e2e-followup', title: 'E2E follow-up', hostId: USER_ID, durationMin: 45, slotIntervalMin: 45, requiresConfirmation: true, minLeadMinutes: 0, maxLeadDays: 30 },
    });
    const s = await api('GET', `/v1/slots?eventTypeId=${et2.json.id}&from=${RANGE_FROM}&to=${RANGE_TO}&timezone=Asia/Tehran`, { key: KEY_A });
    const fslot = s.json.slots[0].startsAt;
    const fb = await api('POST', '/v1/bookings', {
      key: KEY_A,
      body: { eventTypeId: et2.json.id, start: fslot, attendee: { name: 'Pending Pet', phone: '09390000001' } },
    });
    ok('requiresConfirmation → PENDING', fb.status === 201 && fb.json?.status === 'PENDING');

    // concurrent confirm + cancel → exactly one wins
    const [cf, cn] = await Promise.all([
      api('POST', `/v1/bookings/${fb.json.uid}/confirm`, { key: KEY_A, body: {} }),
      api('POST', `/v1/bookings/${fb.json.uid}/cancel`, { key: KEY_A, body: {} }),
    ]);
    const final = await api('GET', `/v1/bookings/${fb.json.uid}`, { key: KEY_A });
    const finalStatus = final.json?.status;
    ok('concurrent confirm+cancel → no 5xx, no illegal state', [cf.status, cn.status].every((x) => x >= 200 && x < 500), `${cf.status}/${cn.status}`);
    ok(
      'final state consistent with the winners (confirm-only or confirm-then-cancel chain)',
      (finalStatus === 'CONFIRMED' && cf.status === 200 && cn.status === 409) ||
        (finalStatus === 'CANCELLED' && cn.status === 200),
      `status=${finalStatus} confirm=${cf.status} cancel=${cn.status}`,
    );

    const cf2 = await api('POST', `/v1/bookings/${fb.json.uid}/confirm`, { key: KEY_A, body: {} });
    ok('double confirm → 409 NOT_PENDING', cf2.status === 409);

    // reschedule vs cancel race
    const sR = await api('GET', `/v1/slots?eventTypeId=${EVENT_TYPE_ID}&from=${RANGE_FROM}&to=${RANGE_TO}&timezone=Asia/Tehran`, { key: KEY_A });
    const taken = new Set([SLOT_1, SLOT_2, SLOT_3]);
    const mv = sR.json.slots.map((x) => x.startsAt).find((x) => !taken.has(x));
    const b2 = await api('POST', '/v1/bookings', {
      key: KEY_A,
      body: { eventTypeId: EVENT_TYPE_ID, start: mv, attendee: { name: 'Move Me', phone: '09390000002' } },
    });
    ok('book another slot for reschedule', b2.status === 201, JSON.stringify(b2.json).slice(0, 300));
    const freeAfter = await api('GET', `/v1/slots?eventTypeId=${EVENT_TYPE_ID}&from=${RANGE_FROM}&to=${RANGE_TO}&timezone=Asia/Tehran`, { key: KEY_A });
    const target = freeAfter.json.slots.map((x) => x.startsAt).find((x) => !taken.has(x) && x !== mv);
    const [rs, cn2] = await Promise.all([
      api('POST', `/v1/bookings/${b2.json.uid}/reschedule`, { key: KEY_A, body: { start: target } }),
      api('POST', `/v1/bookings/${b2.json.uid}/cancel`, { key: KEY_A, body: {} }),
    ]);
    const afterRace = await api('GET', `/v1/bookings/${b2.json.uid}`, { key: KEY_A });
    ok('concurrent reschedule+cancel → no 5xx', [rs.status, cn2.status].every((x) => x >= 200 && x < 500), `${rs.status}/${cn2.status}`);
    const consistent =
      (afterRace.json?.status === 'CANCELLED' && cn2.status === 200) ||
      (afterRace.json?.status !== 'CANCELLED' && rs.status === 200 && afterRace.json?.startsAt === target);
    ok('final booking state consistent (no half-applied reschedule+cancel)', consistent, `status=${afterRace.json?.status} rs=${rs.status} cn=${cn2.status}`);

    // capacity freed correctly after cancel at old window
    const sFinal = await api('GET', `/v1/slots?eventTypeId=${EVENT_TYPE_ID}&from=${RANGE_FROM}&to=${RANGE_TO}&timezone=Asia/Tehran`, { key: KEY_A });
    const oldVisible = sFinal.json.slots.some((x) => x.startsAt === mv) || rs.status !== 200;
    const newVisible = sFinal.json.slots.some((x) => x.startsAt === target) || cn2.status === 200;
    ok('seat accounting consistent after race (old/new windows)', oldVisible && newVisible, '');
  }

  // ── 12. idempotency ──────────────────────────────────────────────
  section('Idempotency (retry-safe mutations)');
  {
    const s = await api('GET', `/v1/slots?eventTypeId=${EVENT_TYPE_ID}&from=${RANGE_FROM}&to=${RANGE_TO}&timezone=Asia/Tehran`, { key: KEY_A });
    const islot = s.json.slots.map((x) => x.startsAt).find((x) => ![SLOT_1, SLOT_2, SLOT_3].includes(x));
    const idemKey = `e2e-idem-${TAG}`;

    const r1 = await api('POST', '/v1/bookings', {
      key: KEY_A,
      headers: { 'idempotency-key': idemKey },
      body: { eventTypeId: EVENT_TYPE_ID, start: islot, attendee: { name: 'Idem', phone: '09391000001' } },
    });
    ok('first create with Idempotency-Key → 201', r1.status === 201, JSON.stringify(r1.json).slice(0, 140));

    const r2 = await api('POST', '/v1/bookings', {
      key: KEY_A,
      headers: { 'idempotency-key': idemKey },
      body: { eventTypeId: EVENT_TYPE_ID, start: islot, attendee: { name: 'Idem', phone: '09391000001' } },
    });
    ok('retry with SAME key → same booking uid (no duplicate)', r2.status === 201 && r2.json?.uid === r1.json.uid, `${r2.status} ${r2.json?.uid}`);
    ok('replay marked via X-HBook-Idempotent-Replay', r2.headers.get('x-hbook-idempotent-replay') === 'true');

    const r3 = await api('POST', '/v1/bookings', {
      key: KEY_A,
      headers: { 'idempotency-key': idemKey },
      body: { eventTypeId: EVENT_TYPE_ID, start: islot, attendee: { name: 'Different', phone: '09391000002' } },
    });
    ok('same key + DIFFERENT body → 422 IDEMPOTENCY_KEY_REUSED', r3.status === 422 && r3.json?.error?.code === 'IDEMPOTENCY_KEY_REUSED', `status ${r3.status}`);

    const dupCheck = await api('GET', '/v1/bookings?attendeePhone=09391000001', { key: KEY_A });
    ok('exactly ONE booking exists for the idempotent patient', dupCheck.json?.items?.length === 1, `got ${dupCheck.json?.items?.length}`);

    // cancel idempotency
    const c1 = await api('POST', `/v1/bookings/${r1.json.uid}/cancel`, { key: KEY_A, headers: { 'idempotency-key': `${idemKey}-c` }, body: { reason: 'x' } });
    const c2 = await api('POST', `/v1/bookings/${r1.json.uid}/cancel`, { key: KEY_A, headers: { 'idempotency-key': `${idemKey}-c` }, body: { reason: 'x' } });
    ok('cancel retry with same key → 200 both, no 409 on replay', c1.status === 200 && c2.status === 200 && c2.headers.get('x-hbook-idempotent-replay') === 'true', `${c1.status}/${c2.status}`);
  }

  // ── 13. API keys: scopes & rotation ──────────────────────────────
  section('API key scopes & rotation');
  {
    const bk = await api('POST', '/v1/api-keys', { key: KEY_A, body: { name: 'booking-only', scopes: ['book'] } });
    ok('create book-scope key → 201', bk.status === 201 && bk.json?.scopes?.includes('book'));
    const KEY_BOOK = bk.json.key;

    const s = await api('GET', `/v1/slots?eventTypeId=${EVENT_TYPE_ID}&from=${RANGE_FROM}&to=${RANGE_TO}&timezone=Asia/Tehran`, { key: KEY_BOOK });
    ok('book key can read slots', s.status === 200);
    const free = s.json.slots.map((x) => x.startsAt)[0];
    const canBook = await api('POST', '/v1/bookings', {
      key: KEY_BOOK,
      body: { eventTypeId: EVENT_TYPE_ID, start: free, attendee: { name: 'Scoped', phone: '09392000001' } },
    });
    ok('book key CAN create bookings', canBook.status === 201, JSON.stringify(canBook.json?.error ?? '').slice(0, 120));
    const cannotManage = await api('POST', '/v1/users', { key: KEY_BOOK, body: { name: 'Nope' } });
    ok('book key CANNOT manage users → 403 SCOPE_INSUFFICIENT', cannotManage.status === 403 && cannotManage.json?.error?.code === 'SCOPE_INSUFFICIENT');
    const cannotKeys = await api('GET', '/v1/api-keys', { key: KEY_BOOK });
    ok('book key CANNOT list api-keys → 403', cannotKeys.status === 403);
    const cannotWebhooks = await api('POST', '/v1/webhooks', { key: KEY_BOOK, body: { url: 'https://example.com/x', events: ['ping'] } });
    ok('book key CANNOT create webhooks → 403', cannotWebhooks.status === 403);

    const esc = await api('POST', '/v1/api-keys', { key: KEY_BOOK, body: { name: 'escalate', scopes: ['admin'] } });
    ok('book key cannot escalate to admin scopes → 403/422', esc.status === 403 || esc.status === 422, `status ${esc.status}`);

    // rotation
    const rk = await api('POST', '/v1/api-keys', { key: KEY_A, body: { name: 'rotating', scopes: ['manage'] } });
    const rot = await api('POST', `/v1/api-keys/${rk.json.id}/rotate`, { key: KEY_A, body: {} });
    ok('rotate → 201 with new one-time key', rot.status === 201 && rot.json?.key?.startsWith('hbk_') && rot.json.key !== rk.json.key);
    const oldDenied = await api('GET', '/v1/me', { key: rk.json.key });
    ok('old key revoked after rotation → 401 API_KEY_REVOKED', oldDenied.status === 401 && oldDenied.json?.error?.code === 'API_KEY_REVOKED');
    const newWorks = await api('GET', '/v1/me', { key: rot.json.key });
    ok('rotated key works with SAME scopes', newWorks.status === 200 && newWorks.json?.apiKey?.scopes?.includes('manage'));
  }

  // ── 14. cross-tenant isolation matrix ────────────────────────────
  section('Cross-tenant isolation (full matrix)');
  {
    const resB = await api('POST', '/v1/tenants', {
      headers: { 'x-setup-token': SETUP_TOKEN },
      body: { name: 'E2E Clinic B', slug: `e2e-clinic-b-${TAG}`, owner: { name: 'Dr. B' } },
    });
    const KEY_B = resB.json.apiKey.key;
    const uB = await api('POST', '/v1/users', { key: KEY_B, body: { name: 'Dr. B host', timezone: 'Asia/Tehran' } });
    await api('PUT', `/v1/users/${uB.json.id}/availability`, { key: KEY_B, body: { weekly: [{ weekday: 0, windows: [{ start: '09:00', end: '17:00' }] }] } });
    const etB = await api('POST', '/v1/event-types', { key: KEY_B, body: { slug: 'b-visit', title: 'B visit', hostId: uB.json.id, durationMin: 30, slotIntervalMin: 30, minLeadMinutes: 0, maxLeadDays: 30 } });

    ok("B cannot read A's user → 404", (await api('GET', `/v1/users/${USER_ID}`, { key: KEY_B })).status === 404);
    ok("B cannot UPDATE A's user → 404", (await api('PATCH', `/v1/users/${USER_ID}`, { key: KEY_B, body: { name: 'Hacked' } })).status === 404);
    ok("B cannot DELETE A's user → 404", (await api('DELETE', `/v1/users/${USER_ID}`, { key: KEY_B })).status === 404);
    ok("B cannot read A's event type → 404", (await api('GET', `/v1/event-types/${EVENT_TYPE_ID}`, { key: KEY_B })).status === 404);
    ok("B cannot PATCH A's event type → 404", (await api('PATCH', `/v1/event-types/${EVENT_TYPE_ID}`, { key: KEY_B, body: { capacity: 9 } })).status === 404);
    ok("B cannot DELETE A's event type → 404", (await api('DELETE', `/v1/event-types/${EVENT_TYPE_ID}`, { key: KEY_B })).status === 404);
    ok("B cannot read A's availability → 404", (await api('GET', `/v1/users/${USER_ID}/availability`, { key: KEY_B })).status === 404);
    ok("B cannot PUT A's availability → 404", (await api('PUT', `/v1/users/${USER_ID}/availability`, { key: KEY_B, body: { weekly: [] } })).status === 404);
    ok("B cannot list A's bookings (zero items)", ((await api('GET', '/v1/bookings', { key: KEY_B })).json?.items?.length ?? 1) === 0);
    ok("B cannot GET A's booking by uid → 404", (await api('GET', `/v1/bookings/${BOOKING_UID}`, { key: KEY_B })).status === 404);
    ok("B cannot CANCEL A's booking → 404", (await api('POST', `/v1/bookings/${BOOKING_UID}/cancel`, { key: KEY_B, body: {} })).status === 404);
    ok("B cannot RESCHEDULE A's booking → 404", (await api('POST', `/v1/bookings/${BOOKING_UID}/reschedule`, { key: KEY_B, body: { start: new Date().toISOString() } })).status === 404);
    ok("B cannot CONFIRM A's booking → 404", (await api('POST', `/v1/bookings/${BOOKING_UID}/confirm`, { key: KEY_B, body: {} })).status === 404);
    ok("B cannot book with A's eventTypeId (cross-tenant booking) → 404", (await api('POST', '/v1/bookings', { key: KEY_B, body: { eventTypeId: EVENT_TYPE_ID, start: SLOT_3, attendee: { name: 'X', phone: '09393000001' } } })).status === 404);
    ok("B cannot fetch A's slots → 404", (await api('GET', `/v1/slots?eventTypeId=${EVENT_TYPE_ID}&from=${RANGE_FROM}&to=${RANGE_TO}`, { key: KEY_B })).status === 404);
    ok("B cannot book with A's hostId on own event type → 422 HOST_INVALID", (await api('POST', '/v1/bookings', { key: KEY_B, body: { eventTypeId: etB.json.id, hostId: USER_ID, start: new Date(Date.now() + 7 * 86_400_000).toISOString(), attendee: { name: 'X', phone: '09393000002' } } })).status === 422);
    ok("B cannot delete A's webhook → 404", (await api('DELETE', `/v1/webhooks/${WEBHOOK_ID}`, { key: KEY_B })).status === 404);
    ok("B cannot list A's webhook deliveries → 404", (await api('GET', `/v1/webhooks/${WEBHOOK_ID}/deliveries`, { key: KEY_B })).status === 404);
    ok("B cannot revoke A's api key → 404", (await api('DELETE', `/v1/api-keys/nonexistent`, { key: KEY_B })).status === 404);

    const meB = await api('GET', '/v1/me', { key: KEY_B });
    ok("B still fully functional (isolation ≠ breakage)", meB.status === 200 && meB.json.tenant.id !== TENANT_A.id);
  }

  // ── 15. latency probe (informational) ────────────────────────────
  section('Latency probe (sequential, informational)');
  {
    const from = new Date().toISOString().slice(0, 10);
    const to = new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10);
    const N = 50;
    const samples = [];
    for (let i = 0; i < N; i++) {
      const t0 = performance.now();
      const res = await fetch(`${BASE}/v1/slots?eventTypeId=${EVENT_TYPE_ID}&from=${from}&to=${to}`, {
        headers: { 'x-api-key': KEY_A },
      });
      await res.arrayBuffer();
      samples.push(performance.now() - t0);
    }
    samples.sort((a, b) => a - b);
    const avg = samples.reduce((s, x) => s + x, 0) / N;
    const p95 = samples[Math.floor(N * 0.95)];
    console.log(`    avg=${avg.toFixed(1)}ms  p50=${samples[Math.floor(N / 2)].toFixed(1)}ms  p95=${p95.toFixed(1)}ms  max=${samples[N - 1].toFixed(1)}ms  (n=${N})`);
    ok('p95 under 80ms on localhost', p95 < 80, `p95=${p95.toFixed(1)}ms`);
  }

  // ── 16. rate limiting (LAST — pollutes the IP auth-fail window) ──
  section('Rate limiting & invalid-key rotation (last)');
  {
    // per-key bucket: burst a valid key past its limit
    const probe = await fetch(`${BASE}/v1/me`, { headers: { 'x-api-key': KEY_A } });
    await probe.arrayBuffer();
    const limit = Number(probe.headers.get('x-ratelimit-limit')) || 300;
    let saw429 = false;
    let last = null;
    for (let i = 0; i < limit + 60; i++) {
      last = await api('GET', '/v1/me', { key: KEY_A });
      if (last.status === 429) {
        saw429 = true;
        break;
      }
    }
    ok(`valid-key burst > ${limit}/min → 429 RATE_LIMITED`, saw429 && last.json?.error?.code === 'RATE_LIMITED', `last=${last.status}`);
  }
  {
    // invalid-key rotation: random keys (and spoofed XFF) cannot bypass —
    // AUTH_FAIL_LIMIT failures per IP → 429
    let got429 = false;
    let lastBody = null;
    for (let i = 0; i < 60; i++) {
      const res = await fetch(`${BASE}/v1/me`, {
        headers: { 'x-api-key': `hbk_rotating-invalid-${i}-${Math.random().toString(36).slice(2)}`, 'x-forwarded-for': `10.0.${(i % 250) + 1}.${(i * 7) % 250}` },
      });
      lastBody = await res.json().catch(() => null);
      if (res.status === 429) {
        got429 = true;
        break;
      }
    }
    ok('rotating invalid keys (+spoofed XFF) → 429 RATE_LIMITED', got429 && lastBody?.error?.code === 'RATE_LIMITED', JSON.stringify(lastBody));
  }
}

main();
