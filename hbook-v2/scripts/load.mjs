#!/usr/bin/env node
/**
 * hbook — realistic load test (zero dependencies).
 *
 * Scenario (Homana-like):
 *   - 1 clinic tenant, 10 doctors, 2 services each (capacity 1 & capacity 3)
 *   - full-week availability 08:00–20:00 (Asia/Tehran)
 *   - data volume: ~2,000 pre-seeded bookings over a 3-week horizon
 *   - Phase A  3,000 slot-range queries (7/30/62-day), concurrency 25
 *   - Phase B  600 concurrent booking attempts on 20 hot slots (contention)
 *   - Phase C  1,200 mixed ops (list/get/create/cancel), concurrency 20
 *
 * Reports: tool, hardware, data volume, error rate, p50/p95/p99, throughput.
 * Run:  scripts/run-with-server.sh 3300 env ... node scripts/load.mjs 3300
 */
import { performance } from 'node:perf_hooks';
import os from 'node:os';

const PORT = process.argv[2] ?? '3300';
const BASE = `http://127.0.0.1:${PORT}`;
const SETUP_TOKEN = process.env.HBOOK_SETUP_TOKEN ?? 'e2e-setup-token-0123456789abcdef';

const SLOT_QUERIES = 3000;
const BOOKING_ATTEMPTS = 600;
const MIXED_OPS = 1200;

let passed = 0;
let failed = 0;
function ok(name, cond, extra = '') {
  if (cond) {
    passed++;
    console.log(`  ✔ ${name}`);
  } else {
    failed++;
    console.log(`  ✘ ${name} ${extra ? `— ${extra}` : ''}`);
  }
}

async function api(method, path, { key, body, headers = {} } = {}) {
  const t0 = performance.now();
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
  return { status: res.status, json, ms: performance.now() - t0 };
}

function pct(samples, p) {
  if (samples.length === 0) return 0;
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
}

function report(name, samples, errors, wallMs, thresholdP95) {
  const n = samples.length;
  const errRate = ((errors / Math.max(1, n)) * 100).toFixed(2);
  const rps = (n / (wallMs / 1000)).toFixed(1);
  console.log(`    n=${n}  errors=${errors} (${errRate}%)  rps=${rps}`);
  console.log(`    p50=${pct(samples, 50).toFixed(1)}ms  p95=${pct(samples, 95).toFixed(1)}ms  p99=${pct(samples, 99).toFixed(1)}ms  max=${pct(samples, 100).toFixed(1)}ms`);
  ok(`${name}: p95 < ${thresholdP95}ms`, pct(samples, 95) < thresholdP95, `p95=${pct(samples, 95).toFixed(1)}ms`);
}

async function pool(work, size, fn) {
  const results = [];
  let i = 0;
  const workers = Array.from({ length: size }, async () => {
    while (i < work.length) {
      const idx = i++;
      results[idx] = await fn(work[idx], idx);
    }
  });
  await Promise.all(workers);
  return results;
}

async function main() {
  console.log('▸ Environment');
  console.log(`    node ${process.version}, cpus=${os.cpus().length}, load-avg=${os.loadavg().map((x) => x.toFixed(2)).join('/')}`);
  console.log(`    tool=custom Node 24 fetch harness (zero-dep), target=Fastify hbook + PostgreSQL 18 (embedded, localhost)`);

  // ── setup ────────────────────────────────────────────────────────
  const t = await api('POST', '/v1/tenants', {
    headers: { 'x-setup-token': SETUP_TOKEN },
    body: { name: 'Load Clinic', slug: `load-${Date.now().toString(36)}`, owner: { name: 'Dr. Load' } },
  });
  const KEY = t.json.apiKey.key;

  const doctors = [];
  for (let d = 0; d < 10; d++) {
    const u = await api('POST', '/v1/users', { key: KEY, body: { name: `Dr. Load ${d}`, timezone: 'Asia/Tehran' } });
    await api('PUT', `/v1/users/${u.json.id}/availability`, {
      key: KEY,
      body: { weekly: [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, windows: [{ start: '08:00', end: '20:00' }] })) },
    });
    const cap1 = await api('POST', '/v1/event-types', {
      key: KEY,
      body: { slug: `l1-${d}`, title: `Load visit ${d}`, hostId: u.json.id, durationMin: 20, slotIntervalMin: 20, minLeadMinutes: 0, maxLeadDays: 60 },
    });
    const cap3 = await api('POST', '/v1/event-types', {
      key: KEY,
      body: { slug: `l3-${d}`, title: `Load group ${d}`, hostId: u.json.id, durationMin: 20, slotIntervalMin: 20, capacity: 3, minLeadMinutes: 0, maxLeadDays: 60 },
    });
    doctors.push({ hostId: u.json.id, cap1: cap1.json.id, cap3: cap3.json.id });
  }

  // pre-seed bookings: ~2,000 across the next 21 days (data volume)
  const seedT0 = performance.now();
  const from = new Date().toISOString().slice(0, 10);
  const to = new Date(Date.now() + 21 * 86_400_000).toISOString().slice(0, 10);
  const slotCache = [];
  for (const doc of doctors) {
    const s = await api('GET', `/v1/slots?eventTypeId=${doc.cap1}&from=${from}&to=${to}&timezone=Asia/Tehran`, { key: KEY });
    slotCache.push({ doc, slots: s.json.slots.map((x) => x.startsAt) });
  }
  const seedJobs = [];
  for (const { doc, slots } of slotCache) {
    // cap1 on the first 60 distinct slots, cap3 on the next 40 (×3 seats)
    // — disjoint ranges so seeding does not fight cross-service buffers
    for (let i = 0; i < 60 && i < slots.length; i++) {
      seedJobs.push({ eventTypeId: doc.cap1, hostId: doc.hostId, start: slots[Math.floor((i * slots.length) / 100)] });
    }
    for (let i = 60; i < 100 && i < slots.length; i++) {
      seedJobs.push({ eventTypeId: doc.cap3, hostId: doc.hostId, start: slots[Math.floor((i * slots.length) / 100)] });
      seedJobs.push({ eventTypeId: doc.cap3, hostId: doc.hostId, start: slots[Math.floor((i * slots.length) / 100)] });
    }
  }
  const seeded = await pool(seedJobs, 20, async (job, i) => {
    const r = await api('POST', '/v1/bookings', {
      key: KEY,
      body: { eventTypeId: job.eventTypeId, hostId: job.hostId, start: job.start, attendee: { name: `Seed ${i}`, phone: `095${String(10000000 + i).slice(-8)}` } },
    });
    return r.status === 201 ? 1 : 0;
  });
  const seedCount = seeded.reduce((a, b) => a + b, 0);
  console.log(`    seeded ${seedCount} bookings in ${((performance.now() - seedT0) / 1000).toFixed(1)}s (data volume ~${seedCount} active + ${doctors.length} doctors + 20 services)`);
  ok('seed volume ≥ 1200 bookings', seedCount >= 1200, `got ${seedCount}`);

  // ── Phase A: slot queries ────────────────────────────────────────
  console.log('\n▸ Phase A — slot-range queries (concurrency 25)');
  {
    const ranges = [7, 30, 60]; // 62 would cross the exclusive-day cap on day-only ranges
    const work = Array.from({ length: SLOT_QUERIES }, (_, i) => {
      const doc = doctors[i % doctors.length];
      const days = ranges[i % 3];
      return `/v1/slots?eventTypeId=${i % 2 ? doc.cap3 : doc.cap1}&from=${new Date().toISOString().slice(0, 10)}&to=${new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10)}&timezone=Asia/Tehran`;
    });
    const t0 = performance.now();
    const res = await pool(work, 25, (path) => api('GET', path, { key: KEY }));
    const wall = performance.now() - t0;
    const okRes = res.filter((r) => r.status === 200);
    const hist = {};
    for (const r of res) hist[r.status] = (hist[r.status] ?? 0) + 1;
    console.log(`    status histogram: ${JSON.stringify(hist)}`);
    if (!okRes.length && res[0]?.json?.error) console.log(`    sample error: ${JSON.stringify(res[0].json).slice(0, 220)}`);
    report('Phase A', okRes.map((r) => r.ms), res.length - okRes.length, wall, 800);
  }

  // ── Phase B: contention (concurrent booking on hot slots) ────────
  console.log('\n▸ Phase B — concurrent bookings on 20 hot slots (contention)');
  {
    const hotSlots = [];
    for (const { doc, slots } of slotCache.slice(0, 10)) {
      const fresh = await api('GET', `/v1/slots?eventTypeId=${doc.cap3}&from=${new Date(Date.now() + 22 * 86_400_000).toISOString().slice(0, 10)}&to=${new Date(Date.now() + 25 * 86_400_000).toISOString().slice(0, 10)}&timezone=Asia/Tehran`, { key: KEY });
      for (const s of fresh.json.slots.slice(0, 2)) hotSlots.push({ start: s.startsAt, eventTypeId: doc.cap3, hostId: doc.hostId, capacity: 3 });
    }
    const expectedSeats = hotSlots.reduce((a, s) => a + s.capacity, 0);
    const attempts = Array.from({ length: BOOKING_ATTEMPTS }, (_, i) => {
      const s = hotSlots[i % hotSlots.length];
      return { ...s, phone: `096${String(10000000 + i).slice(-8)}` };
    });
    const t0 = performance.now();
    const res = await pool(attempts, 30, (a) =>
      api('POST', '/v1/bookings', {
        key: KEY,
        body: { eventTypeId: a.eventTypeId, hostId: a.hostId, start: a.start, attendee: { name: `Hot ${a.phone}`, phone: a.phone } },
      }),
    );
    const wall = performance.now() - t0;
    const wins = res.filter((r) => r.status === 201);
    const cleanRejects = res.filter((r) => r.status === 409 || r.status === 422);
    const errors = res.length - wins.length - cleanRejects.length;
    console.log(`    wins=${wins.length}/${expectedSeats} expected · clean rejects=${cleanRejects.length} · hard errors=${errors}`);
    ok('Phase B: successful bookings == total seats (no overbook)', wins.length === expectedSeats, `wins=${wins.length} expected=${expectedSeats}`);
    ok('Phase B: zero 5xx under contention', errors === 0, `errors=${errors}`);
    report('Phase B', [...wins, ...cleanRejects].map((r) => r.ms), errors, wall, 400);
  }

  // ── Phase C: mixed read/write ────────────────────────────────────
  console.log('\n▸ Phase C — mixed ops: list/get/create/cancel (concurrency 20)');
  {
    const t0 = performance.now();
    let created = 0;
    let cancelled = 0;
    let errors = 0;
    const samples = [];
    const work = Array.from({ length: MIXED_OPS }, (_, i) => i);
    let hard5xx = 0;
    await pool(work, 20, async (i) => {
      const mode = i % 4;
      const doc = doctors[i % doctors.length];
      if (mode === 0) {
        const r = await api('GET', `/v1/bookings?limit=20&hostId=${doc.hostId}`, { key: KEY });
        samples.push(r.ms);
        if (r.status !== 200) errors++;
      } else if (mode === 1) {
        const s = await api('GET', `/v1/slots?eventTypeId=${doc.cap1}&from=${new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10)}&to=${new Date(Date.now() + 32 * 86_400_000).toISOString().slice(0, 10)}`, { key: KEY });
        samples.push(s.ms);
        if (s.status !== 200) errors++;
      } else if (mode === 2) {
        const s = await api('GET', `/v1/slots?eventTypeId=${doc.cap3}&from=${new Date(Date.now() + 33 * 86_400_000).toISOString().slice(0, 10)}&to=${new Date(Date.now() + 35 * 86_400_000).toISOString().slice(0, 10)}`, { key: KEY });
        const slot = s.json?.slots?.[0]?.startsAt;
        if (!slot) {
          errors++;
          return;
        }
        const r = await api('POST', '/v1/bookings', {
          key: KEY,
          body: { eventTypeId: doc.cap3, hostId: doc.hostId, start: slot, attendee: { name: `Mix ${i}`, phone: `097${String(10000000 + i).slice(-8)}` } },
        });
        samples.push(r.ms);
        if (r.status === 201) created++;
        else if (r.status >= 500) { errors++; hard5xx++; }
        else { /* 409/422 = seat exhausted — expected under load */ }
      } else {
        const list = await api('GET', `/v1/bookings?limit=3&status=CONFIRMED`, { key: KEY });
        const item = list.json?.items?.[Math.floor(Math.random() * Math.max(1, list.json?.items?.length ?? 1))];
        if (item) {
          const c = await api('POST', `/v1/bookings/${item.uid}/cancel`, { key: KEY, body: { reason: 'load test' } });
          samples.push(c.ms);
          if (c.status === 200) cancelled++;
          else if (c.status === 409) { /* raced cancel — fine */ }
          else if (c.status >= 500) { errors++; hard5xx++; }
          else errors++;
        } else {
          samples.push(list.ms);
        }
      }
    });
    const wall = performance.now() - t0;
    console.log(`    created=${created} cancelled=${cancelled} rejected(4xx)=${errors - hard5xx} hard 5xx=${hard5xx}`);
    report('Phase C', samples, errors, wall, 400);
  }

  console.log(`\n${'═'.repeat(60)}`);
  console.log(`LOAD RESULT: ${passed} passed, ${failed} failed`);
  process.exitCode = failed > 0 ? 1 : 0;
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
