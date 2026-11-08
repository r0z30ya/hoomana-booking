import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';

if (process.env.HBOOK_ISOLATED_TEST !== 'yes' || !process.env.DATABASE_URL || !process.env.HBOOK_SETUP_TOKEN || !process.env.BASE_URL) {
  throw new Error('Set HBOOK_ISOLATED_TEST=yes, DATABASE_URL, HBOOK_SETUP_TOKEN and BASE_URL for an isolated test server.');
}

const db = new PrismaClient();
const base = process.env.BASE_URL;
const tag = randomUUID().slice(0, 8);

async function request(method, path, body, key, headers = {}) {
  const response = await fetch(base + path, {
    method,
    headers: {
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(key ? { 'x-api-key': key } : { 'x-setup-token': process.env.HBOOK_SETUP_TOKEN }),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, body: await response.json(), headers: response.headers };
}

async function expectSuccess(promise) {
  const result = await promise;
  assert.ok(result.status < 400, JSON.stringify(result));
  return result.body;
}

const day = (offset) => new Date(Date.now() + offset * 86400000).toISOString().slice(0, 10);

try {
  const tenant = await expectSuccess(request('POST', '/v1/tenants', {
    name: 'Regression clinic', slug: `regression-${tag}`, owner: { name: 'Owner' },
  }));
  const key = tenant.apiKey.key;
  const doctor = await expectSuccess(request('POST', '/v1/users', { name: 'Doctor' }, key));
  const other = await expectSuccess(request('POST', '/v1/users', { name: 'Other doctor' }, key));
  const weekly = Array.from({ length: 7 }, (_, weekday) => ({
    weekday, windows: [{ start: '08:00', end: '18:00' }],
  }));
  for (const user of [doctor, other]) {
    await expectSuccess(request('PUT', `/v1/users/${user.id}/availability`, { weekly }, key));
  }
  const createService = (name, extra = {}) => expectSuccess(request('POST', '/v1/event-types', {
    slug: `${name}-${tag}`, title: name, hostId: doctor.id, durationMin: 30,
    slotIntervalMin: 30, minLeadMinutes: 0, maxLeadDays: 30, ...extra,
  }, key));
  const service = await createService('visit', { capacity: 3 });
  const anotherTenant = await expectSuccess(request('POST', '/v1/tenants', {
    name: 'Other clinic', slug: `other-${tag}`, owner: { name: 'Other owner' },
  }));
  await assert.rejects(db.eventType.update({
    where: { id: service.id }, data: { hostId: anotherTenant.owner.id },
  }));
  console.log('PASS database rejects cross-tenant service hosts');
  const temporaryHost = await expectSuccess(request('POST', '/v1/users', { name: 'Temporary doctor' }, key));
  const temporaryService = await createService('temporary', { hostId: temporaryHost.id });
  const deleted = await request('DELETE', `/v1/users/${temporaryHost.id}`, undefined, key);
  assert.equal(deleted.status, 200, JSON.stringify(deleted.body));
  assert.equal((await expectSuccess(request('GET', `/v1/event-types/${temporaryService.id}`, undefined, key))).hostId, null);
  console.log('PASS deleting an unused host clears the fixed service host');
  const slotQuery = (id, from, to, timezone = 'Asia/Tehran') =>
    `/v1/slots?eventTypeId=${id}&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&timezone=${encodeURIComponent(timezone)}`;
  const slots = (await expectSuccess(request('GET', slotQuery(service.id, day(1), day(4)), undefined, key))).slots;
  const bookingBody = (eventTypeId, start, phone = '09120000000') => ({
    eventTypeId, start, attendee: { name: 'Patient', phone },
  });
  const createBooking = (eventTypeId, start, phone) =>
    expectSuccess(request('POST', '/v1/bookings', bookingBody(eventTypeId, start, phone), key));

  const first = await createBooking(service.id, slots[0].startsAt);
  const second = await createBooking(service.id, slots[0].startsAt);
  const idem = `cancel-${tag}`;
  const cancelFirst = await request('POST', `/v1/bookings/${first.uid}/cancel`, {}, key, { 'idempotency-key': idem });
  const cancelSecond = await request('POST', `/v1/bookings/${second.uid}/cancel`, {}, key, { 'idempotency-key': idem });
  assert.equal(cancelFirst.status, 200);
  assert.equal(cancelSecond.status, 422);
  assert.equal(cancelSecond.body.error.code, 'IDEMPOTENCY_KEY_REUSED');
  assert.equal((await expectSuccess(request('GET', `/v1/bookings/${second.uid}`, undefined, key))).status, 'CONFIRMED');
  console.log('PASS idempotency includes booking identity');

  const override = await request('POST', '/v1/bookings', {
    ...bookingBody(service.id, slots[0].startsAt), hostId: other.id,
  }, key);
  assert.equal(override.status, 422);
  assert.equal(override.body.error.code, 'HOST_INVALID');
  console.log('PASS fixed service host cannot be overridden');

  const utcSlots = (await expectSuccess(request('GET', slotQuery(service.id, day(5), day(5), 'UTC'), undefined, key))).slots;
  assert.ok(utcSlots.length > 0);
  const utcBooking = await request('POST', '/v1/bookings', bookingBody(service.id, utcSlots.at(-1).startsAt), key);
  assert.equal(utcBooking.status, 201, JSON.stringify(utcBooking.body));
  console.log('PASS requested timezone preserves doctor working hours');

  const before = await createService('before', { bufferBeforeMin: 240 });
  const after = await createService('after', { bufferAfterMin: 240 });
  const earlier = (await expectSuccess(request('GET', slotQuery(after.id, day(7), day(7)), undefined, key))).slots[0].startsAt;
  await createBooking(after.id, earlier);
  const target = new Date(new Date(earlier).getTime() + 7 * 3600000).toISOString();
  const targetEnd = new Date(new Date(target).getTime() + 30 * 60000).toISOString();
  const narrow = await expectSuccess(request('GET', slotQuery(before.id, target, targetEnd), undefined, key));
  assert.ok(!narrow.slots.some((slot) => slot.startsAt === target));
  const blocked = await request('POST', '/v1/bookings', bookingBody(before.id, target), key);
  assert.equal(blocked.status, 422);
  console.log('PASS combined buffers agree for listing and booking');

  const raceSlots = (await expectSuccess(request('GET', slotQuery(service.id, day(10), day(15)), undefined, key))).slots;
  for (let index = 0; index < 10; index++) {
    const booking = await createBooking(service.id, raceSlots[index * 3].startsAt);
    const results = await Promise.all([
      request('POST', `/v1/bookings/${booking.uid}/reschedule`, { start: raceSlots[index * 3 + 1].startsAt }, key),
      request('POST', `/v1/bookings/${booking.uid}/reschedule`, { start: raceSlots[index * 3 + 2].startsAt }, key),
    ]);
    assert.ok(results.some((result) => result.status === 200), JSON.stringify(results));
    assert.ok(results.every((result) => result.status < 500), JSON.stringify(results));
  }
  const inconsistent = await db.$queryRaw`
    SELECT count(*)::int AS count FROM (
      SELECT si."taken", (SELECT count(*)::int FROM "Booking" b
        WHERE b."hostId" = si."hostId" AND b."eventTypeId" = si."eventTypeId"
          AND b."startsAt" = si."startsAt" AND b."status" IN ('PENDING', 'CONFIRMED')) AS actual
      FROM "SlotInstance" si WHERE si."tenantId" = ${tenant.tenant.id}
    ) counters WHERE counters."taken" <> counters.actual`;
  assert.equal(inconsistent[0].count, 0);
  console.log('PASS simultaneous reschedules preserve seat counters');

  const faultKey = `rollback-test-${tag}`;
  const faultSlot = (await expectSuccess(request('GET', slotQuery(service.id, day(20), day(20)), undefined, key))).slots[0].startsAt;
  await db.$executeRawUnsafe(`CREATE OR REPLACE FUNCTION hbook_regression_fail_idempotency() RETURNS trigger AS $$
    BEGIN IF NEW."key" LIKE 'rollback-test-%' THEN RAISE EXCEPTION 'injected idempotency failure'; END IF; RETURN NEW; END
    $$ LANGUAGE plpgsql`);
  await db.$executeRawUnsafe('CREATE TRIGGER hbook_regression_fail_idempotency BEFORE INSERT ON "IdempotencyKey" FOR EACH ROW EXECUTE FUNCTION hbook_regression_fail_idempotency()');
  try {
    const failed = await request('POST', '/v1/bookings', bookingBody(service.id, faultSlot, '09129999999'), key, {
      'idempotency-key': faultKey,
    });
    assert.equal(failed.status, 500);
    const count = await db.booking.count({ where: { tenantId: tenant.tenant.id, attendeePhone: '09129999999' } });
    assert.equal(count, 0);
  } finally {
    await db.$executeRawUnsafe('DROP TRIGGER IF EXISTS hbook_regression_fail_idempotency ON "IdempotencyKey"');
    await db.$executeRawUnsafe('DROP FUNCTION IF EXISTS hbook_regression_fail_idempotency()');
  }
  const retry = await request('POST', '/v1/bookings', bookingBody(service.id, faultSlot, '09129999999'), key, {
    'idempotency-key': faultKey,
  });
  const replay = await request('POST', '/v1/bookings', bookingBody(service.id, faultSlot, '09129999999'), key, {
    'idempotency-key': faultKey,
  });
  assert.equal(retry.status, 201);
  assert.equal(replay.status, 201);
  assert.equal(replay.body.uid, retry.body.uid);
  assert.equal(replay.headers.get('x-hbook-idempotent-replay'), 'true');
  console.log('PASS failed idempotency write rolls back booking and retry replays safely');

  const parallelSlot = (await expectSuccess(request('GET', slotQuery(service.id, day(21), day(21)), undefined, key))).slots[0].startsAt;
  const parallelKey = `parallel-${tag}`;
  const parallel = await Promise.all(Array.from({ length: 6 }, () =>
    request('POST', '/v1/bookings', bookingBody(service.id, parallelSlot, '09128888888'), key, {
      'idempotency-key': parallelKey,
    })));
  assert.ok(parallel.every((result) => result.status === 201), JSON.stringify(parallel));
  assert.equal(new Set(parallel.map((result) => result.body.uid)).size, 1);
  assert.equal(await db.booking.count({ where: { tenantId: tenant.tenant.id, attendeePhone: '09128888888' } }), 1);
  console.log('PASS concurrent identical requests create one booking');
} finally {
  await db.$disconnect();
}
