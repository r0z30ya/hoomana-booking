#!/usr/bin/env node
/**
 * hbook — unit tests (zero dependencies): time/DST, phone normalization,
 * SSRF guards, webhook secret encryption, slot engine conflict semantics.
 * Run: node --import tsx scripts/unit.mjs
 */
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
function eq(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

// env BEFORE importing app modules (config reads env at import time)
process.env.NODE_ENV = 'development';
process.env.DATABASE_URL = 'postgresql://hbook:hbook@127.0.0.1:5433/hbook?connection_limit=1';
process.env.HBOOK_WEBHOOK_ENC_KEY = 'unit-test-passphrase-0123456789';

const { zonedToUtc, getZonedParts, weekdayOfDateKey, dateKeyAddDays, tzOffsetMs } = await import('../src/lib/time.ts');
const { normalizePhone, normalizeIrMobile, toAsciiDigits, maskPhone } = await import('../src/lib/phone.ts');
const { isForbiddenAddress } = await import('../src/lib/ssrf.ts');
const { encryptSecret, decryptSecret } = await import('../src/lib/webhookCrypto.ts');
const { conflictsWithBusy, generateSlots } = await import('../src/lib/slots.ts');

// ── time & DST ──────────────────────────────────────────────────────
section('Time & timezone (UTC storage, Asia/Tehran, DST)');
{
  ok('Tehran fixed +03:30', tzOffsetMs('Asia/Tehran', new Date('2026-06-01T08:00:00Z')) === 3.5 * 3600_000, `${tzOffsetMs('Asia/Tehran', new Date('2026-06-01T08:00:00Z'))}`);

  // Iran: 09:00 local = 05:30 UTC
  ok('zonedToUtc Tehran 09:00 → 05:30Z', zonedToUtc('Asia/Tehran', '2026-06-02', 540).toISOString() === '2026-06-02T05:30:00.000Z', zonedToUtc('Asia/Tehran', '2026-06-02', 540).toISOString());

  const springSlots = generateSlots({
    timeZone: 'America/New_York', fromUtc: new Date('2026-03-08T05:00:00Z'),
    toUtc: new Date('2026-03-08T09:00:00Z'), eventTypeId: 'dst',
    weekly: new Map([[0, [{ startMinute: 60, endMinute: 240 }]]]),
    overrides: new Map(), busy: [], durationMin: 30, slotIntervalMin: 30,
    bufferBeforeMin: 0, bufferAfterMin: 0, capacity: 1, minLeadMinutes: 0,
    maxLeadDays: 30, nowUtc: new Date('2026-03-07T00:00:00Z'),
  });
  ok('NY spring-forward skips nonexistent 02:00 and 02:30',
    springSlots.every((slot) => ![120, 150].includes(getZonedParts('America/New_York', slot.startsAt).minutes)) &&
      new Set(springSlots.map((slot) => slot.startsAt.getTime())).size === springSlots.length);

  // New York fall back 2026-11-01: 01:30 local occurs twice → engine picks
  // the FIRST occurrence (offset -04:00 → 05:30Z)
  const fall = zonedToUtc('America/New_York', '2026-11-01', 90); // 01:30
  ok('NY fall-back ambiguous 01:30 → first occurrence 05:30Z (EDT)', fall.toISOString() === '2026-11-01T05:30:00.000Z', fall.toISOString());

  ok('fall-back second pass consistent (same wall clock → same UTC each run)', eq(zonedToUtc('America/New_York', '2026-11-01', 90).getTime(), zonedToUtc('America/New_York', '2026-11-01', 90).getTime()));

  ok('weekday of dateKey (Tehran 2026-06-02 is Tuesday=2)', weekdayOfDateKey('Asia/Tehran', '2026-06-02') === 2, String(weekdayOfDateKey('Asia/Tehran', '2026-06-02')));
  ok('dateKeyAddDays crosses month', dateKeyAddDays('2026-02-28', 1) === '2026-03-01');
  const parts = getZonedParts('Asia/Tehran', new Date('2026-06-02T05:30:00Z')); // 09:00 Tehran
  ok('getZonedParts minutes-from-midnight', parts.dateKey === '2026-06-02' && parts.minutes === 540, JSON.stringify(parts));
  const mid = getZonedParts('Asia/Tehran', new Date('2026-06-02T20:30:00Z')); // = next local midnight
  ok('getZonedParts rolls over local midnight', mid.dateKey === '2026-06-03' && mid.minutes === 0, JSON.stringify(mid));
}

// ── phone ───────────────────────────────────────────────────────────
section('Phone normalization (Iranian formats)');
{
  ok('09123456789', normalizePhone('09123456789') === '09123456789');
  ok('+989123456789', normalizePhone('+989123456789') === '09123456789', normalizePhone('+989123456789'));
  ok('00989123456789', normalizePhone('00989123456789') === '09123456789');
  ok('989123456789', normalizePhone('989123456789') === '09123456789');
  ok('9123456789 (no leading 0)', normalizePhone('9123456789') === '09123456789');
  ok('Persian digits ۰۹۱۲۳۴۵۶۷۸۹', normalizePhone('۰۹۱۲۳۴۵۶۷۸۹') === '09123456789');
  ok('Arabic digits ٠٩١٢٣٤٥٦٧٨٩', normalizePhone('٠٩١٢٣٤٥٦٧٨٩') === '09123456789');
  ok('mixed with separators (0912) 345-6789', normalizePhone('(0912) 345-6789') === '09123456789', normalizePhone('(0912) 345-6789'));
  ok('spaces and dashes +98 912 345-6789', normalizePhone('+98 912 345-6789') === '09123456789');
  ok('Persian digits with +۹۸ prefix', normalizePhone('+۹۸۹۱۲۳۴۵۶۷۸۹') === '09123456789', normalizePhone('+۹۸۹۱۲۳۴۵۶۷۸۹'));
  ok('other country +447911123456 → E.164 kept', normalizePhone('+447911123456') === '+447911123456');
  ok('0044791123456 → +44791123456', normalizePhone('0044791123456') === '+44791123456', normalizePhone('0044791123456'));
  ok('garbage 12345678 → null', normalizePhone('12345678') === null);
  ok('garbage hello → null', normalizePhone('hello') === null);
  ok('empty → null', normalizePhone('') === null);
  ok('too short 09123 → null', normalizePhone('09123') === null);
  ok('landline 02112345678 → null (mobile only)', normalizePhone('02112345678') === null, normalizePhone('02112345678'));
  ok('normalizeIrMobile rejects +44', normalizeIrMobile('+447911123456') === null);
  ok('toAsciiDigits', toAsciiDigits('۰۱۲') === '012');
  ok('maskPhone hides middle', maskPhone('09123456789') === '09123***789', maskPhone('09123456789'));
}

// ── SSRF ────────────────────────────────────────────────────────────
section('SSRF address guards');
{
  ok('loopback 127.0.0.1 forbidden', isForbiddenAddress('127.0.0.1'));
  ok('loopback 127.9.9.9 forbidden', isForbiddenAddress('127.9.9.9'));
  ok('private 10.1.2.3 forbidden', isForbiddenAddress('10.1.2.3'));
  ok('private 192.168.1.1 forbidden', isForbiddenAddress('192.168.1.1'));
  ok('private 172.16.0.5 forbidden', isForbiddenAddress('172.16.0.5'));
  ok('CGNAT 100.64.0.1 forbidden', isForbiddenAddress('100.64.0.1'));
  ok('link-local 169.254.169.254 (metadata) forbidden', isForbiddenAddress('169.254.169.254'));
  ok('broadcast 255.255.255.255 forbidden', isForbiddenAddress('255.255.255.255'));
  ok('IPv6 ::1 forbidden', isForbiddenAddress('::1'));
  ok('IPv6 fd00::1 (ULA) forbidden', isForbiddenAddress('fd00::1'));
  ok('IPv6 fe80::1 forbidden', isForbiddenAddress('fe80::1'));
  ok('IPv4-mapped ::ffff:10.0.0.1 forbidden', isForbiddenAddress('::ffff:10.0.0.1'));
  ok('public 8.8.8.8 allowed', !isForbiddenAddress('8.8.8.8'));
  ok('public 93.184.216.34 allowed', !isForbiddenAddress('93.184.216.34'));
  ok('public IPv6 2606:4700::1111 allowed', !isForbiddenAddress('2606:4700::1111'));
}

// ── webhook secret encryption ───────────────────────────────────────
section('Webhook secret encryption (AES-256-GCM)');
{
  const secret = 'whsec_abcd1234-very-long-secret-value';
  const enc = encryptSecret(secret);
  ok('ciphertext uses enc.v1 envelope', enc.startsWith('enc.v1.'));
  ok('ciphertext differs from plaintext', !enc.includes(secret));
  ok('two encryptions differ (random IV)', encryptSecret(secret) !== enc);
  const dec = decryptSecret(enc);
  ok('decrypt round-trips', dec.secret === secret && dec.legacy === false);
  const legacy = decryptSecret('whsec_plaintext-legacy');
  ok('legacy plaintext detected for lazy re-encryption', legacy.secret === 'whsec_plaintext-legacy' && legacy.legacy === true);
  let tamperThrew = false;
  try {
    const t = enc.slice(0, -4) + 'AAAA';
    decryptSecret(t);
  } catch {
    tamperThrew = true;
  }
  ok('tampered ciphertext rejected (GCM auth tag)', tamperThrew);
}

// ── slot engine semantics ───────────────────────────────────────────
section('Slot engine (buffers & seat groups)');
{
  const T0 = Date.UTC(2026, 5, 2, 6, 0); // 09:30 Tehran
  const busy = [
    { startsAt: new Date(T0), endsAt: new Date(T0 + 30 * 60_000), bufferBeforeMin: 5, bufferAfterMin: 30, eventTypeId: 'svcA' },
  ];
  ok('candidate inside existing after-buffer conflicts', conflictsWithBusy(busy, { startMs: T0 + 30 * 60_000, endMs: T0 + 45 * 60_000, eventTypeId: 'svcA2', bufferBeforeMin: 0, bufferAfterMin: 0 }));
  ok('candidate AFTER buffer expires is free', !conflictsWithBusy(busy, { startMs: T0 + 60 * 60_000, endMs: T0 + 75 * 60_000, eventTypeId: 'svcA2', bufferBeforeMin: 0, bufferAfterMin: 0 }));
  ok('candidate BEFORE existing start (buffer-before side) conflicts', conflictsWithBusy(busy, { startMs: T0 - 25 * 60_000, endMs: T0 - 4 * 60_000, eventTypeId: 'svcA2', bufferBeforeMin: 0, bufferAfterMin: 0 }));
  ok('back-to-back touch (cand ends exactly at padded busy start) is NOT a conflict', !conflictsWithBusy(busy, { startMs: T0 - 20 * 60_000, endMs: T0 - 5 * 60_000, eventTypeId: 'svcA2', bufferBeforeMin: 0, bufferAfterMin: 0 }));
  ok('same seat group (same type+start) never self-conflicts', !conflictsWithBusy(busy, { startMs: T0, endMs: T0 + 30 * 60_000, eventTypeId: 'svcA', bufferBeforeMin: 5, bufferAfterMin: 30 }));

  // capacity via generateSlots
  const mkInput = (capacity) => ({
    timeZone: 'Asia/Tehran',
    fromUtc: new Date(T0 - 3_600_000),
    toUtc: new Date(T0 + 3_600_000),
    eventTypeId: 'svcA',
    weekly: new Map([[2, [{ startMinute: 0, endMinute: 24 * 60 }]]]),
    overrides: new Map(),
    busy,
    durationMin: 15,
    slotIntervalMin: 15,
    bufferBeforeMin: 0,
    bufferAfterMin: 0,
    capacity,
    minLeadMinutes: 0,
    maxLeadDays: 30,
    nowUtc: new Date(T0 - 10 * 3_600_000),
  });
  const cap1 = generateSlots(mkInput(1));
  const atT0cap1 = cap1.find((s) => s.startsAt.getTime() === T0);
  const atT0cap1B = cap1.find((s) => s.startsAt.getTime() === T0 + 30 * 60_000);
  ok('capacity 1: occupied start hidden', atT0cap1 === undefined);
  ok('capacity 1: start hidden while inside after-buffer', atT0cap1B === undefined);

  const cap3 = generateSlots(mkInput(3));
  const atT0cap3 = cap3.find((s) => s.startsAt.getTime() === T0);
  ok('capacity 3: same group shows remaining seats (3-1=2)', atT0cap3 && atT0cap3.seatsRemaining === 2, JSON.stringify(atT0cap3));
  const atT0cap3B = cap3.find((s) => s.startsAt.getTime() === T0 + 30 * 60_000);
  ok('capacity 3 does NOT bypass another group buffer', atT0cap3B === undefined, JSON.stringify(atT0cap3B));
}

console.log(`\n${'═'.repeat(60)}`);
console.log(`UNIT RESULT: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log('Failed:', failures.join(' | '));
  process.exit(1);
}
