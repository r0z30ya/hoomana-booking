import assert from "node:assert/strict";
import { createHmac } from "node:crypto";

// Only run against a manually started local instance using an isolated test database.
if (process.env.HNOBAT_ISOLATED_TEST !== "yes") throw Error("Set HNOBAT_ISOLATED_TEST=yes after starting the server with an isolated database.");
const base = "http://127.0.0.1:33971/api/v2";
const suffix = Date.now().toString(36);
async function request(path, method = "GET", body, token) {
  const response = await fetch(base + path, { method, headers: { ...(body ? { "content-type": "application/json" } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const json = await response.json();
  return { status: response.status, json };
}
async function expect(path, method, body, token, status) {
  const result = await request(path, method, body, token);
  assert.equal(result.status, status, `${method} ${path}: ${JSON.stringify(result.json)}`);
  return result.json.data;
}
const sign = async (name) => (await expect("/auth/signup", "POST", { username: name + suffix, email: `${name}${suffix}@example.test`, password: "only-for-isolated-test" }, null, 201)).accessToken;
const a = await sign("hosta"), b = await sign("hostb");
const schedule = async (token) => (await expect("/schedules", "POST", { name: "all days", timeZone: "Etc/UTC", availability: [{ days: [0,1,2,3,4,5,6], startTime: "09:00", endTime: "17:00" }] }, token, 201)).schedule.id;
const scheduleA = await schedule(a), scheduleB = await schedule(b);
const encode = (obj) => Buffer.from(JSON.stringify(obj)).toString("base64url");
const unsigned = `${encode({ alg: "HS256", typ: "JWT" })}.${encode({ sub: 1, iat: 1, email: "x@example.test", username: "x" })}`;
const forged = `${unsigned}.${createHmac("sha256", "isolated-tests-only-secret-0123456789").update(unsigned).digest("base64url")}`;
await expect("/schedules", "GET", null, forged, 401);
const event = (await expect("/event-types", "POST", { title: "Test", slug: "test", length: 30, slotInterval: 30, minimumBookingNotice: 0, scheduleId: scheduleA }, a, 201)).eventType;
await expect(`/event-types/${event.id}`, "PATCH", { scheduleId: scheduleB }, a, 404);
await expect("/schedules", "POST", { name: "bad", availability: [{ days: [1], startTime: "99:99", endTime: "00:00" }] }, a, 400);
await expect("/schedules", "POST", { name: "bad", timeZone: "invalid/zone" }, a, 400);
await expect("/webhooks", "POST", { subscriberUrl: "http://127.0.0.1:80", eventTriggers: ["BOOKING_CREATED"] }, a, 400);
const day = new Date(); day.setUTCDate(day.getUTCDate() + 2); day.setUTCHours(0,0,0,0);
const end = new Date(day.getTime() + 86400000);
async function slots(start) { return (await expect(`/slots?eventTypeId=${event.id}&startTime=${encodeURIComponent(start.toISOString())}&endTime=${encodeURIComponent(end.toISOString())}&timeZone=Etc%2FUTC`, "GET", null, null, 200)).slots; }
const full = Object.values(await slots(day)).flat();
const clipped = Object.values(await slots(new Date(day.getTime() + 9*3600000 + 7*60000))).flat();
assert.equal(full[1].utc, clipped[0].utc, "slot grid must remain anchored to schedule");
const bookingBody = { eventTypeId: event.id, start: full[0].utc, attendee: { name: "test patient", email: "patient@example.test", timeZone: "Etc/UTC" } };
await expect("/bookings", "POST", bookingBody, null, 401);
await expect("/bookings", "POST", bookingBody, b, 403);
const outcomes = await Promise.all([request("/bookings", "POST", bookingBody, a), request("/bookings", "POST", bookingBody, a)]);
assert.equal(outcomes.filter((x) => x.status === 201).length, 1, JSON.stringify(outcomes));
const booking = outcomes.find((x) => x.status === 201).json.data.booking;
await expect(`/bookings/${booking.uid}`, "GET", null, null, 401);
await expect(`/bookings/${booking.uid}`, "GET", null, b, 403);
await expect(`/bookings/${booking.uid}`, "GET", null, a, 200);
await expect(`/bookings/${booking.uid}/cancel`, "POST", { email: "patient@example.test" }, null, 403);
await expect(`/bookings/${booking.uid}/reschedule`, "POST", { start: full[0].utc }, a, 200);
const sharedEvent = (await expect("/event-types", "POST", { title: "Shared", slug: "shared", length: 30, minimumBookingNotice: 0, scheduleId: scheduleA, seatsPerTimeSlot: 2 }, a, 201)).eventType;
const sharedBody = { ...bookingBody, eventTypeId: sharedEvent.id, start: full[2].utc };
const shared = await Promise.all([request("/bookings", "POST", sharedBody, a), request("/bookings", "POST", sharedBody, a), request("/bookings", "POST", sharedBody, a)]);
assert.equal(shared.filter((x) => x.status === 201).length, 2, JSON.stringify(shared));
const afterShared = (await expect(`/slots?eventTypeId=${sharedEvent.id}&startTime=${encodeURIComponent(day.toISOString())}&endTime=${encodeURIComponent(end.toISOString())}`, "GET", null, null, 200)).slots;
assert(!Object.values(afterShared).flat().some((slot) => slot.utc === sharedBody.start), "full slot must not be offered");
console.log("PASS: owner isolation, time validation, webhook allowlist, stable slots, concurrent booking and shared capacity, reschedule");
console.log("Concurrent responses:", outcomes.map((x) => x.status).join(", "));
