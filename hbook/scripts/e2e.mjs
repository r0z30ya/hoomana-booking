#!/usr/bin/env node
/**
 * hbook — end-to-end test suite (zero dependencies, Node ≥ 20).
 *
 * Prerequisites:
 *   - a running hbook server   (BASE_URL, default http://127.0.0.1:3000)
 *   - the master setup token   (HBOOK_SETUP_TOKEN env)
 *   - NODE_ENV may be development (e2e creates its own tenants/keys)
 *
 * Usage:
 *   BASE_URL=http://127.0.0.1:3100 HBOOK_SETUP_TOKEN=… node scripts/e2e.mjs
 *
 * Covers: health, docs, tenant provisioning, auth, users, availability,
 * date overrides, event types, slots, booking creation, engine rejections,
 * concurrent double-booking, confirm/cancel/reschedule, webhook HMAC
 * signatures + delivery log, API key revocation, cross-tenant isolation,
 * rate limiting and a latency probe.
 */
import { spawn } from 'node:child_process';
import { createHmac } from 'node:crypto';

const BASE = process.env.BASE_URL ?? 'http://127.0.0.1:3000';
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

async function waitFor(receiver, predicate, timeoutMs = 8000) {
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

// ─────────────────────────────────────────────────────────────────────
async function main() {
  if (!SETUP_TOKEN) {
    console.error('HBOOK_SETUP_TOKEN env is required');
    process.exit(2);
  }

  const receiver = spawn(process.execPath, [new URL('./webhook-receiver.js', import.meta.url).pathname], {
    env: { ...process.env, PORT: String(HOOK_PORT), WEBHOOK_SECRET },
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
    const noToken = await api('POST', '/v1/tenants', { body: { name: 'xx', slug: 'xx', owner: { email: 'x@x.test' } } });
    ok('tenant create without setup token → 401/422 rejected', noToken.status === 401 || noToken.status === 422, `status ${noToken.status}`);
    const badToken = await api('POST', '/v1/tenants', {
      headers: { 'x-setup-token': 'wrong-token-123456' },
      body: { name: 'xx', slug: 'xx', owner: { email: 'x@x.test' } },
    });
    ok('tenant create with wrong token → 401', badToken.status === 401 && badToken.json?.error?.code === 'SETUP_TOKEN_INVALID', `status ${badToken.status}`);
  }

  // ── 3. tenant A provisioning ─────────────────────────────────────
  section('Tenant provisioning');
  let KEY_A, TENANT_A;
  {
    const res = await api('POST', '/v1/tenants', {
      headers: { 'x-setup-token': SETUP_TOKEN },
      body: {
        name: 'E2E Clinic A',
        slug: `e2e-clinic-a-${Date.now().toString(36)}`,
        timezone: 'Asia/Tehran',
        owner: { name: 'Dr. E2E', email: `owner-a-${Date.now().toString(36)}@e2e.test` },
      },
    });
    ok('tenant create → 201 + one-time key', res.status === 201 && /^hbk_[A-Za-z0-9_-]{32}$/.test(res.json?.apiKey?.key ?? ''), JSON.stringify(res.json).slice(0, 120));
    KEY_A = res.json.apiKey.key;
    TENANT_A = res.json.tenant;

    const me = await api('GET', '/v1/me', { key: KEY_A });
    ok('GET /v1/me → tenant + masked key', me.status === 200 && me.json?.apiKey?.prefix?.startsWith('hbk_') && !JSON.stringify(me.json).includes(KEY_A));
  }

  // ── 4. users, availability, event type ───────────────────────────
  section('Users / Availability / Event types');
  let USER_ID, EVENT_TYPE_ID;
  {
    const u = await api('POST', '/v1/users', {
      key: KEY_A,
      body: { name: 'Dr. Host', email: `host-${Date.now().toString(36)}@e2e.test`, timezone: 'Asia/Tehran' },
    });
    ok('create host user → 201', u.status === 201 && u.json?.isHost === true);
    USER_ID = u.json.id;

    const badTz = await api('POST', '/v1/users', {
      key: KEY_A,
      body: { name: 'Bad TZ', email: `bad-${Date.now().toString(36)}@e2e.test`, timezone: 'Mars/Olympus' },
    });
    ok('invalid timezone → 422 INVALID_TIMEZONE', badTz.status === 422 && badTz.json?.error?.code === 'INVALID_TIMEZONE');

    const av = await api('PUT', `/v1/users/${USER_ID}/availability`, {
      key: KEY_A,
      body: {
        weekly: [
          { weekday: 6, windows: [{ start: '09:00', end: '12:00' }] },
          { weekday: 0, windows: [{ start: '09:00', end: '12:00' }, { start: '13:00', end: '17:00' }] },
          { weekday: 1, windows: [{ start: '09:00', end: '17:00' }] },
          { weekday: 2, windows: [{ start: '09:00', end: '17:00' }] },
          { weekday: 3, windows: [{ start: '09:00', end: '17:00' }] },
        ],
      },
    });
    ok('PUT availability → normalized weekly', av.status === 200 && av.json?.weekly?.length === 5);

    const overlap = await api('PUT', `/v1/users/${USER_ID}/availability`, {
      key: KEY_A,
      body: { weekly: [{ weekday: 1, windows: [{ start: '10:00', end: '12:00' }, { start: '11:00', end: '13:00' }] }] },
    });
    ok('overlapping windows → 422 WINDOWS_OVERLAP', overlap.status === 422 && overlap.json?.error?.code === 'WINDOWS_OVERLAP');

    const et = await api('POST', '/v1/event-types', {
      key: KEY_A,
      body: { slug: 'e2e-visit', title: 'E2E visit', hostId: USER_ID, durationMin: 30, slotIntervalMin: 30, minLeadMinutes: 0, maxLeadDays: 30 },
    });
    ok('create event type → 201', et.status === 201);
    EVENT_TYPE_ID = et.json.id;

    const etBySlug = await api('GET', '/v1/event-types/e2e-visit', { key: KEY_A });
    ok('get event type by slug', etBySlug.status === 200 && etBySlug.json?.id === EVENT_TYPE_ID);
  }

  // ── 5. slots ─────────────────────────────────────────────────────
  section('Slot discovery');
  let SLOT_1, SLOT_2;
  let RANGE_FROM, RANGE_TO;
  {
    const from = new Date().toISOString().slice(0, 10);
    const to = new Date(Date.now() + 9 * 86_400_000).toISOString().slice(0, 10);
    RANGE_FROM = from;
    RANGE_TO = to;
    const s = await api('GET', `/v1/slots?eventTypeId=${EVENT_TYPE_ID}&from=${from}&to=${to}&timezone=Asia/Tehran`, { key: KEY_A });
    ok('GET /v1/slots → ascending UTC instants', s.status === 200 && Array.isArray(s.json?.slots) && s.json.slots.length >= 5, `got ${s.json?.slots?.length ?? 0}`);
    const slots = s.json.slots;
    ok('slots are 30-min apart and aligned', slots.length >= 2 && (new Date(slots[1]) - new Date(slots[0])) === 1_800_000);
    SLOT_1 = slots[0];
    SLOT_2 = slots[1];

    const s2 = await api('GET', `/v1/slots?eventTypeId=nonexistent&from=${from}&to=${to}`, { key: KEY_A });
    ok('unknown event type → 404', s2.status === 404);

    // date override: close the day of SLOT_1 and verify it disappears
    const slot1DayTehran = new Date(SLOT_1).toLocaleDateString('en-CA', { timeZone: 'Asia/Tehran' });
    const ov = await api('POST', `/v1/users/${USER_ID}/availability/overrides`, {
      key: KEY_A,
      body: { date: slot1DayTehran, closed: true },
    });
    ok('date override (day off) → 201', ov.status === 201);
    const s3 = await api('GET', `/v1/slots?eventTypeId=${EVENT_TYPE_ID}&from=${from}&to=${to}&timezone=Asia/Tehran`, { key: KEY_A });
    ok('closed day produces no slots', s3.status === 200 && !s3.json.slots.some((x) => new Date(x).toLocaleDateString('en-CA', { timeZone: 'Asia/Tehran' }) === slot1DayTehran));
    // remove override so the booking tests can use SLOT_1 again
    await api('DELETE', `/v1/users/${USER_ID}/availability/overrides/${slot1DayTehran}`, { key: KEY_A });
  }

  // ── 6. booking lifecycle ─────────────────────────────────────────
  section('Booking lifecycle');
  let BOOKING_UID;
  let THIRD_SLOT;
  {
    const b = await api('POST', '/v1/bookings', {
      key: KEY_A,
      body: {
        eventTypeId: EVENT_TYPE_ID,
        start: SLOT_1,
        attendee: { name: 'Ali Test', email: `ali-${Date.now().toString(36)}@example.com`, timezone: 'Asia/Tehran', notes: 'first visit' },
      },
    });
    ok('book a slot → 201 CONFIRMED', b.status === 201 && b.json?.status === 'CONFIRMED', JSON.stringify(b.json).slice(0, 140));
    BOOKING_UID = b.json?.uid;

    const again = await api('POST', '/v1/bookings', {
      key: KEY_A,
      body: { eventTypeId: EVENT_TYPE_ID, start: SLOT_1, attendee: { name: 'Second', email: 'second@example.com' } },
    });
    ok('same slot again → 4xx rejected', again.status >= 400 && again.status < 500, `status ${again.status}`);

    const misaligned = await api('POST', '/v1/bookings', {
      key: KEY_A,
      body: { eventTypeId: EVENT_TYPE_ID, start: new Date(new Date(SLOT_2).getTime() + 7 * 60_000).toISOString(), attendee: { name: 'Off', email: 'off@example.com' } },
    });
    ok('off-grid time → 422 SLOT_UNAVAILABLE', misaligned.status === 422 && misaligned.json?.error?.code === 'SLOT_UNAVAILABLE');

    const getOne = await api('GET', `/v1/bookings/${BOOKING_UID}`, { key: KEY_A });
    ok('GET booking by uid (attendee + host nested)', getOne.status === 200 && getOne.json?.attendee?.email && getOne.json?.host?.email);

    // book a second slot so pagination has 2 pages
    const s2 = await api('GET', `/v1/slots?eventTypeId=${EVENT_TYPE_ID}&from=${RANGE_FROM}&to=${RANGE_TO}&timezone=Asia/Tehran`, { key: KEY_A });
    const third = s2.json.slots.find((x) => x !== SLOT_1 && x !== SLOT_2);
    const b2nd = await api('POST', '/v1/bookings', {
      key: KEY_A,
      body: { eventTypeId: EVENT_TYPE_ID, start: third, attendee: { name: 'Second Booking', email: 'second2@example.com' } },
    });
    ok('book second slot for pagination', b2nd.status === 201, JSON.stringify(b2nd.json?.error ?? '').slice(0, 100));

    const list = await api('GET', `/v1/bookings?limit=1`, { key: KEY_A });
    ok('list bookings + cursor', list.status === 200 && list.json?.items?.length === 1 && typeof list.json?.nextCursor === 'string');
    const page2 = await api('GET', `/v1/bookings?limit=1&cursor=${list.json.nextCursor}`, { key: KEY_A });
    ok('cursor pagination page 2', page2.status === 200 && page2.json?.items?.length === 1 && page2.json?.items?.[0]?.uid !== list.json.items[0].uid);
  }

  // ── 7. concurrent double-booking ─────────────────────────────────
  section('Concurrency (race-proof)');
  {
    const attempts = await Promise.all(
      Array.from({ length: 6 }, () =>
        api('POST', '/v1/bookings', {
          key: KEY_A,
          body: { eventTypeId: EVENT_TYPE_ID, start: SLOT_2, attendee: { name: `Racer`, email: `racer-${Math.random().toString(36).slice(2)}@example.com` } },
        }),
      ),
    );
    const wins = attempts.filter((a) => a.status === 201);
    const rejects = attempts.filter((a) => a.status >= 400);
    ok('exactly 1 of 6 concurrent bookings wins', wins.length === 1 && rejects.length === 5, `wins=${wins.length} rejects=${rejects.map((r) => r.status).join(',')}`);
  }

  // ── 8. webhooks ──────────────────────────────────────────────────
  section('Webhooks (HMAC)');
  let WEBHOOK_ID;
  {
    const w = await api('POST', '/v1/webhooks', {
      key: KEY_A,
      body: {
        url: `http://127.0.0.1:${HOOK_PORT}/hooks/hbook`,
        events: ['booking.created', 'booking.cancelled', 'booking.rescheduled', 'ping'],
        secret: WEBHOOK_SECRET,
      },
    });
    ok('create webhook → 201 (secret echoed once)', w.status === 201 && w.json?.secret === WEBHOOK_SECRET);
    WEBHOOK_ID = w.json.id;

    const ping = await api('POST', `/v1/webhooks/${WEBHOOK_ID}/ping`, { key: KEY_A });
    ok('ping → 202', ping.status === 202);
    const got = await waitFor(null, (e) => e.event === 'ping');
    ok('ping received with VALID HMAC signature', got && got.verified === true, got ? got.reason : 'not received');

    const deliveries = await api('GET', `/v1/webhooks/${WEBHOOK_ID}/deliveries`, { key: KEY_A });
    ok('delivery log recorded', deliveries.status === 200 && deliveries.json?.items?.length >= 1);
  }

  // ── 9. confirm / cancel / reschedule ─────────────────────────────
  section('Confirm / Cancel / Reschedule');
  {
    // follow-up event type requires confirmation
    const et2 = await api('POST', '/v1/event-types', {
      key: KEY_A,
      body: { slug: 'e2e-followup', title: 'E2E follow-up', hostId: USER_ID, durationMin: 45, slotIntervalMin: 45, requiresConfirmation: true },
    });
    const day = new Date().toISOString().slice(0, 10);
    const to = new Date(Date.now() + 9 * 86_400_000).toISOString().slice(0, 10);
    const s = await api('GET', `/v1/slots?eventTypeId=${et2.json.id}&from=${day}&to=${to}&timezone=Asia/Tehran`, { key: KEY_A });
    const fslot = s.json.slots[0];
    const fb = await api('POST', '/v1/bookings', {
      key: KEY_A,
      body: { eventTypeId: et2.json.id, start: fslot, attendee: { name: 'Pending Pet', email: 'pending@example.com' } },
    });
    ok('requiresConfirmation → PENDING', fb.status === 201 && fb.json?.status === 'PENDING');
    const cf = await api('POST', `/v1/bookings/${fb.json.uid}/confirm`, { key: KEY_A, body: {} });
    ok('confirm → CONFIRMED', cf.status === 200 && cf.json?.status === 'CONFIRMED');
    const cf2 = await api('POST', `/v1/bookings/${fb.json.uid}/confirm`, { key: KEY_A, body: {} });
    ok('double confirm → 409 NOT_PENDING', cf2.status === 409);

    const sR = await api('GET', `/v1/slots?eventTypeId=${EVENT_TYPE_ID}&from=${RANGE_FROM}&to=${RANGE_TO}&timezone=Asia/Tehran`, { key: KEY_A });
    const takenBefore = new Set([SLOT_1, SLOT_2, fslot]);
    const mv = sR.json.slots.find((x) => !takenBefore.has(x));
    const b2 = await api('POST', '/v1/bookings', {
      key: KEY_A,
      body: { eventTypeId: EVENT_TYPE_ID, start: mv, attendee: { name: 'Move Me', email: 'move@example.com' } },
    });
    ok('book another slot for reschedule', b2.status === 201, JSON.stringify(b2.json).slice(0, 500));
    const target = await api('GET', `/v1/slots?eventTypeId=${EVENT_TYPE_ID}&from=${RANGE_FROM}&to=${RANGE_TO}&timezone=Asia/Tehran`, { key: KEY_A });
    const taken = new Set([SLOT_1, SLOT_2, mv, fslot]);
    const free = target.json.slots.find((x) => !taken.has(x));
    const rs = await api('POST', `/v1/bookings/${b2.json.uid}/reschedule`, { key: KEY_A, body: { start: free } });
    ok('reschedule → 200 with new start', rs.status === 200 && rs.json?.startsAt === free, JSON.stringify(rs.json?.error ?? '').slice(0, 120));

    const cn = await api('POST', `/v1/bookings/${BOOKING_UID}/cancel`, { key: KEY_A, body: { reason: 'e2e cancel' } });
    ok('cancel → CANCELLED + reason', cn.status === 200 && cn.json?.status === 'CANCELLED' && cn.json?.cancellationReason === 'e2e cancel');
    const cn2 = await api('POST', `/v1/bookings/${BOOKING_UID}/cancel`, { key: KEY_A, body: {} });
    ok('double cancel → 409 ALREADY_CANCELLED', cn2.status === 409);

    const cancelledEvents = await waitFor(null, (e) => e.event === 'booking.cancelled' && e.body?.data?.uid === BOOKING_UID, 6000);
    ok('booking.cancelled webhook received & signed', cancelledEvents && cancelledEvents.verified === true);
  }

  // ── 10. API keys & revocation ────────────────────────────────────
  section('API key revocation');
  {
    const nk = await api('POST', '/v1/api-keys', { key: KEY_A, body: { name: 'temporary' } });
    ok('create second key → 201 one-time', nk.status === 201 && nk.json?.key?.startsWith('hbk_'));
    const list = await api('GET', '/v1/api-keys', { key: KEY_A });
    ok('list keys never exposes secrets', list.status === 200 && !JSON.stringify(list.json).includes(nk.json.key));

    const rv = await api('DELETE', `/v1/api-keys/${nk.json.id}`, { key: KEY_A });
    ok('revoke → 200 revokedAt set', rv.status === 200 && rv.json?.revokedAt);
    const denied = await api('GET', '/v1/me', { key: nk.json.key });
    ok('revoked key → 401 API_KEY_REVOKED', denied.status === 401 && denied.json?.error?.code === 'API_KEY_REVOKED');
  }

  // ── 11. cross-tenant isolation ───────────────────────────────────
  section('Cross-tenant isolation');
  {
    const resB = await api('POST', '/v1/tenants', {
      headers: { 'x-setup-token': SETUP_TOKEN },
      body: {
        name: 'E2E Clinic B',
        slug: `e2e-clinic-b-${Date.now().toString(36)}`,
        owner: { email: `owner-b-${Date.now().toString(36)}@e2e.test` },
      },
    });
    const KEY_B = resB.json.apiKey.key;
    const spy = await api('GET', `/v1/users/${USER_ID}`, { key: KEY_B });
    ok("tenant B cannot read tenant A's user → 404", spy.status === 404);
    const spyBookings = await api('GET', `/v1/bookings`, { key: KEY_B });
    ok("tenant B sees zero bookings of tenant A", spyBookings.status === 200 && spyBookings.json?.items?.length === 0);
  }

  // ── 12. latency probe ────────────────────────────────────────────
  section('Latency probe (sequential)');
  {
    const day = new Date().toISOString().slice(0, 10);
    const to = new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10);
    const N = 50;
    const samples = [];
    for (let i = 0; i < N; i++) {
      const t0 = performance.now();
      const res = await fetch(`${BASE}/v1/slots?eventTypeId=${EVENT_TYPE_ID}&from=${day}&to=${to}`, {
        headers: { 'x-api-key': KEY_A },
      });
      await res.arrayBuffer();
      samples.push(performance.now() - t0);
    }
    samples.sort((a, b) => a - b);
    const avg = samples.reduce((s, x) => s + x, 0) / N;
    const p95 = samples[Math.floor(N * 0.95)];
    console.log(`    avg=${avg.toFixed(1)}ms  p50=${samples[Math.floor(N / 2)].toFixed(1)}ms  p95=${p95.toFixed(1)}ms  max=${samples[N - 1].toFixed(1)}ms  (n=${N})`);
    ok('p95 under 50ms on localhost', p95 < 50, `p95=${p95.toFixed(1)}ms`);
  }

  // ── 13. rate limiting (own tenant/key, LAST test) ────────────────
  section('Rate limiting');
  {
    const resC = await api('POST', '/v1/tenants', {
      headers: { 'x-setup-token': SETUP_TOKEN },
      body: {
        name: 'Rate Test',
        slug: `rate-test-${Date.now().toString(36)}`,
        owner: { email: `rate-${Date.now().toString(36)}@e2e.test` },
      },
    });
    const KEY_C = resC.json.apiKey.key;
    // discover the configured limit from headers, then burst past it
    const probe = await fetch(`${BASE}/v1/me`, { headers: { 'x-api-key': KEY_C } });
    await probe.arrayBuffer();
    const limit = Number(probe.headers.get('x-ratelimit-limit')) || 320;
    let saw429 = false;
    let last = null;
    for (let i = 0; i < limit + 15; i++) {
      last = await api('GET', '/v1/me', { key: KEY_C });
      if (last.status === 429) {
        saw429 = true;
        break;
      }
    }
    ok(`burst > ${limit}/min → 429 RATE_LIMITED`, saw429 && last.json?.error?.code === 'RATE_LIMITED', `last=${last.status}`);
  }
}

main();
