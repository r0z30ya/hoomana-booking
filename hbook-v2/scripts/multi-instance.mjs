#!/usr/bin/env node
/**
 * hbook — multi-instance & recovery tests (zero dependencies).
 *
 * Proves the guarantees that a single-process suite cannot:
 *  1. Capacity races across SEPARATE server processes (advisory locks +
 *     SlotInstance counters live in PostgreSQL, so 3 instances agree):
 *       capacity 1 → exactly 1 winner, capacity 3 → exactly 3 winners.
 *  2. HTTP-level SSRF enforcement: an instance WITHOUT the test escape
 *     flags rejects private/loopback destinations and plain http.
 *  3. Outbox durability: a booking event queued while the receiver is DOWN
 *     is delivered after BOTH the receiver and the server are restarted
 *     (graceful stop + fresh process).
 *
 * Usage: node scripts/multi-instance.mjs   (starts/stops its own servers)
 */
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';

const SETUP_TOKEN = process.env.HBOOK_SETUP_TOKEN ?? 'e2e-setup-token-0123456789abcdef';
const PG_URL = 'postgresql://hbook:hbook@127.0.0.1:5433/hbook?connection_limit=10';

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
function section(t) {
  console.log(`\n▸ ${t}`);
}

const children = [];
function startServer(port, extraEnv = {}) {
  const child = spawn(process.execPath, ['dist/server.js'], {
    cwd: new URL('..', import.meta.url).pathname,
    env: {
      DATABASE_URL: PG_URL,
      HBOOK_SETUP_TOKEN: SETUP_TOKEN,
      PORT: String(port),
      NODE_ENV: 'development',
      RATE_LIMIT_MAX: '5000',
      WEBHOOK_TICK_MS: '250',
      // test escape hatch for the local webhook receiver (docs: explicit flags)
      HBOOK_WEBHOOK_ALLOW_INSECURE_HTTP: '1',
      HBOOK_WEBHOOK_ALLOW_PRIVATE_IPS: '1',
      HBOOK_WEBHOOK_ENC_KEY: 'mi-test-enc-key-0123456789abcdef',
      ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stderr.on('data', () => {});
  children.push(child);
  return child;
}

async function waitHealthy(port, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/health`);
      if (r.ok) return true;
    } catch {
      /* not up yet */
    }
    await sleep(250);
  }
  return false;
}

async function stopServer(child, signal = 'SIGTERM') {
  if (!child || child.exitCode !== null) return;
  child.kill(signal);
  await Promise.race([new Promise((r) => child.once('exit', r)), sleep(8000)]);
}

async function api(port, method, path, { key, body, headers = {} } = {}) {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
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
  } catch {}
  return { status: res.status, json };
}

async function main() {
  // receiver on 4990 (stopped/started by the test itself)
  const receiverScript = new URL('./webhook-receiver.js', import.meta.url).pathname;
  const startReceiver = () => {
    const rec = spawn(process.execPath, [receiverScript], {
      env: { ...process.env, PORT: '4990', WEBHOOK_SECRET: 'mi-whsec-0123456789abcdef0123456789' },
      stdio: 'ignore',
    });
    children.push(rec);
    return rec;
  };
  let receiver = startReceiver();
  await sleep(600);

  // ── setup: one tenant, one host, event types on THREE instances ──
  const PORTS = [3201, 3202, 3203];
  for (const p of PORTS) startServer(p);
  for (const p of PORTS) ok(`instance :${p} healthy`, await waitHealthy(p));

  const created = await api(3201, 'POST', '/v1/tenants', {
    headers: { 'x-setup-token': SETUP_TOKEN },
    body: { name: 'MI Clinic', slug: `mi-${Date.now().toString(36)}`, owner: { name: 'Dr. MI' } },
  });
  const KEY = created.json.apiKey.key;

  const u = await api(3201, 'POST', '/v1/users', { key: KEY, body: { name: 'Dr. MI host', timezone: 'Asia/Tehran' } });
  await api(3201, 'PUT', `/v1/users/${u.json.id}/availability`, {
    key: KEY,
    body: { weekly: [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, windows: [{ start: '08:00', end: '20:00' }] })) },
  });
  const et1 = await api(3202, 'POST', '/v1/event-types', {
    key: KEY,
    body: { slug: 'mi-single', title: 'MI single', hostId: u.json.id, durationMin: 30, slotIntervalMin: 30, minLeadMinutes: 0, maxLeadDays: 30 },
  });
  const et3 = await api(3203, 'POST', '/v1/event-types', {
    key: KEY,
    body: { slug: 'mi-group', title: 'MI group', hostId: u.json.id, durationMin: 30, slotIntervalMin: 30, capacity: 3, minLeadMinutes: 0, maxLeadDays: 30 },
  });

  // ── 1. capacity race across 3 instances ─────────────────────────
  section('Capacity race across 3 instances');
  {
    const from = new Date().toISOString().slice(0, 10);
    const to = new Date(Date.now() + 9 * 86_400_000).toISOString().slice(0, 10);
    const s = await api(3201, 'GET', `/v1/slots?eventTypeId=${et1.json.id}&from=${from}&to=${to}&timezone=Asia/Tehran`, { key: KEY });
    const slot = s.json.slots[0].startsAt;

    // 9 requests spread over 3 different instances (capacity 1)
    const attempts = [];
    await Promise.all(
      Array.from({ length: 9 }, (_, i) =>
        api(PORTS[i % 3], 'POST', '/v1/bookings', {
          key: KEY,
          body: { eventTypeId: et1.json.id, start: slot, attendee: { name: `R${i}`, phone: `0940${String(1000000 + i).slice(-7)}` } },
        }).then((r) => attempts.push(r)),
      ),
    );
    const wins = attempts.filter((a) => a.status === 201).length;
    ok('capacity 1 across 3 processes → exactly 1 of 9 wins', wins === 1, `wins=${wins} statuses=${attempts.map((a) => a.status).join(',')}`);

    // capacity 3 on the SAME start, same host, different event type → must
    // conflict (different group, overlapping window)
    const cross = await api(3202, 'POST', '/v1/bookings', {
      key: KEY,
      body: { eventTypeId: et3.json.id, start: slot, attendee: { name: 'Cross', phone: '09409999999' } },
    });
    ok('same instant via another service (different group) → rejected', cross.status === 409 || cross.status === 422, `status ${cross.status}`);

    const s2 = await api(3203, 'GET', `/v1/slots?eventTypeId=${et3.json.id}&from=${from}&to=${to}&timezone=Asia/Tehran`, { key: KEY });
    const gslot = s2.json.slots[0]?.startsAt;
    const attempts3 = [];
    await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        api(PORTS[(i + 1) % 3], 'POST', '/v1/bookings', {
          key: KEY,
          body: { eventTypeId: et3.json.id, start: gslot, attendee: { name: `G${i}`, phone: `0941${String(2000000 + i).slice(-7)}` } },
        }).then((r) => attempts3.push(r)),
      ),
    );
    const wins3 = attempts3.filter((a) => a.status === 201).length;
    ok('capacity 3 across 3 processes → exactly 3 of 12 win', wins3 === 3, `wins=${wins3} statuses=${attempts3.map((a) => a.status).join(',')}`);

    // DB-level invariant check: no group exceeds its capacity
    const { PrismaClient } = await import('@prisma/client');
    const prisma = new PrismaClient({ datasources: { db: { url: PG_URL } } });
    const over = (await prisma.$queryRaw`
      SELECT si."taken"::int AS taken, si.capacity::int AS capacity, si."hostId", si."eventTypeId", si."startsAt" FROM "SlotInstance" si WHERE si."taken" > si."capacity"`);
    const consistent = Number((await prisma.$queryRaw`
      SELECT count(*)::int AS bad FROM (
        SELECT si."hostId", si."eventTypeId", si."startsAt", si."taken",
          (SELECT count(*)::int FROM "Booking" b WHERE b."hostId"=si."hostId" AND b."eventTypeId"=si."eventTypeId"
             AND b."startsAt"=si."startsAt" AND b."status" IN ('PENDING','CONFIRMED')) AS real
        FROM "SlotInstance" si
      ) x WHERE x.taken <> x.real`)[0]?.bad ?? 1);
    ok('DB invariant: taken ≤ capacity everywhere', over.length === 0, JSON.stringify(over));
    ok('DB invariant: counter matches real active bookings', consistent === 0, `bad=${consistent}`);
    await prisma.$disconnect();
  }

  // ── 2. HTTP-level SSRF enforcement (flags OFF) ───────────────────
  section('SSRF at HTTP level (no test escape flags)');
  {
    const guardPort = 3204;
    const guard = startServer(guardPort, { HBOOK_WEBHOOK_ALLOW_INSECURE_HTTP: '0', HBOOK_WEBHOOK_ALLOW_PRIVATE_IPS: '0' });
    ok('guard instance healthy', await waitHealthy(guardPort));

    const w1 = await api(guardPort, 'POST', '/v1/webhooks', {
      key: KEY,
      body: { url: 'http://127.0.0.1:4990/hooks/hbook', events: ['ping'] },
    });
    ok('plain http → 422 INSECURE_WEBHOOK_URL', w1.status === 422 && w1.json?.error?.code === 'INSECURE_WEBHOOK_URL', JSON.stringify(w1.json?.error));

    const w2 = await api(guardPort, 'POST', '/v1/webhooks', {
      key: KEY,
      body: { url: 'https://localhost:4990/hooks/hbook', events: ['ping'] },
    });
    ok('https://localhost → 422 FORBIDDEN_WEBHOOK_TARGET', w2.status === 422 && w2.json?.error?.code === 'FORBIDDEN_WEBHOOK_TARGET', JSON.stringify(w2.json?.error));

    const w3 = await api(guardPort, 'POST', '/v1/webhooks', {
      key: KEY,
      body: { url: 'https://169.254.169.254/latest/meta-data', events: ['ping'] },
    });
    ok('cloud metadata IP literal → 422 FORBIDDEN_WEBHOOK_TARGET', w3.status === 422 && w3.json?.error?.code === 'FORBIDDEN_WEBHOOK_TARGET', JSON.stringify(w3.json?.error));

    const w4 = await api(guardPort, 'POST', '/v1/webhooks', {
      key: KEY,
      body: { url: 'ftp://example.com/x', events: ['ping'] },
    });
    ok('non-http scheme → 422 INVALID_URL', w4.status === 422 && w4.json?.error?.code === 'INVALID_URL');

    await stopServer(guard);
  }

  // ── 3. outbox durability across restarts ────────────────────────
  section('Outbox durability (receiver down + server restart)');
  {
    // stop the receiver → deliveries will fail
    await stopServer(receiver);
    const w = await api(3201, 'POST', '/v1/webhooks', {
      key: KEY,
      // e2e instances run with the test escape flags → local receiver ok
      body: { url: 'http://127.0.0.1:4990/hooks/hbook', events: ['booking.created'], secret: 'mi-whsec-0123456789abcdef0123456789' },
    });
    ok('webhook to local receiver created (test flags on)', w.status === 201, JSON.stringify(w.json?.error));

    const from = new Date().toISOString().slice(0, 10);
    const to = new Date(Date.now() + 9 * 86_400_000).toISOString().slice(0, 10);
    const s = await api(3202, 'GET', `/v1/slots?eventTypeId=${et1.json.id}&from=${from}&to=${to}&timezone=Asia/Tehran`, { key: KEY });
    const freeSlot = s.json.slots[1]?.startsAt ?? s.json.slots[0]?.startsAt;
    const b = await api(3203, 'POST', '/v1/bookings', {
      key: KEY,
      body: { eventTypeId: et1.json.id, start: freeSlot, attendee: { name: 'Outbox Pat', phone: '09421111111' } },
    });
    ok('booking created while receiver is down → 201 (event queued, not lost)', b.status === 201, JSON.stringify(b.json?.error ?? ''));

    const dl1 = await api(3201, 'GET', `/v1/webhooks/${w.json.id}/deliveries`, { key: KEY });
    const row1 = dl1.json.items[0];
    ok('delivery row persisted in PENDING/RETRY state', row1 && (row1.status === 'PENDING' || row1.status === 'PROCESSING'), JSON.stringify(row1 ?? {}));
    const queuedEventId = row1.eventId;

    // graceful stop of ALL instances, then fresh start (restart simulation)
    for (const c of children.filter((c) => c.spawnargs?.some((a) => String(a).includes('dist/server.js')))) {
      await stopServer(c);
    }
    await sleep(500);
    const restarted = [3211, 3212].map((p) => startServer(p));
    ok('restarted instances healthy', (await Promise.all(restarted.map((c) => waitHealthy(Number(c.spawnargs.filter((a) => !isNaN(Number(a)))[0] ?? 0))))).every(Boolean) || (await waitHealthy(3211) && await waitHealthy(3212)));

    // receiver comes back AFTER the servers restarted
    receiver = startReceiver();
    await sleep(600);

    // wait for the worker to deliver the queued event
    let delivered = null;
    for (let i = 0; i < 40; i++) {
      await sleep(500);
      const dl = await api(3211, 'GET', `/v1/webhooks/${w.json.id}/deliveries`, { key: KEY });
      const row = dl.json.items.find((x) => x.eventId === queuedEventId);
      if (row?.status === 'DELIVERED') {
        delivered = row;
        break;
      }
    }
    ok('queued event delivered AFTER server+receiver restart (no loss)', delivered?.status === 'DELIVERED', JSON.stringify(delivered ?? {}));

    // duplicate-receipt simulation: same event delivered twice must keep the
    // same event id (receiver records ids; consumers dedupe on it)
    await api(3211, 'POST', `/v1/webhooks/${w.json.id}/deliveries/${delivered.id}/replay`, { key: KEY });
    let ids = [];
    for (let i = 0; i < 20; i++) {
      await sleep(400);
      const rec = await fetch('http://127.0.0.1:4990/received').then((r) => r.json());
      ids = rec.filter((e) => e.body?.id === queuedEventId).map((e) => e.eventId);
      if (ids.length >= 2) break;
    }
    ok('event id STABLE across attempts (dedupe key for consumers)', ids.length >= 2 && new Set(ids).size === 1, JSON.stringify(ids));
  }

  console.log(`\n${'═'.repeat(60)}`);
  console.log(`MULTI-INSTANCE RESULT: ${passed} passed, ${failed} failed`);
  if (failed > 0) {
    console.log('Failed:', failures.join(' | '));
  }
  process.exitCode = failed > 0 ? 1 : 0;
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    for (const c of children) {
      try {
        c.kill('SIGTERM');
      } catch {}
    }
    await sleep(300);
  });
