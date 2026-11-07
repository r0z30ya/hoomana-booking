#!/usr/bin/env bash
# hnobat API v2 — end-to-end test of the full booking cycle
set -u
BASE="http://localhost:3000/api/v2"
PASS=0; FAIL=0

ok()   { PASS=$((PASS+1)); echo "  PASS  $1"; }
bad()  { FAIL=$((FAIL+1)); echo "  FAIL  $1"; }
check(){ if [ "$1" = "$2" ]; then ok "$3"; else bad "$3 (expected: $2 | got: $1)"; fi }

j() { python3 -c "import sys,json; d=json.load(sys.stdin); print(eval(sys.argv[1]))" "$1" 2>/dev/null; }

echo "== 0. Health =="
H=$(curl -s "$BASE/health")
check "$(echo "$H" | j 'd["status"]')" "success" "GET /health"

echo "== 1. Auth =="
L=$(curl -s -X POST "$BASE/auth/login" -H 'content-type: application/json' \
  -d '{"email":"demo@hnobat.io","password":"hnobat1234"}')
TOKEN=$(echo "$L" | j 'd["data"]["accessToken"]')
[ -n "$TOKEN" ] && ok "POST /auth/login returns JWT" || bad "POST /auth/login (got: $L)"

BAD=$(curl -s -X POST "$BASE/auth/login" -H 'content-type: application/json' -d '{"email":"demo@hnobat.io","password":"wrong"}')
check "$(echo "$BAD" | j 'd["error"]["code"]')" "UnauthorizedError" "login with wrong password -> 401 UnauthorizedError"

ME=$(curl -s "$BASE/me" -H "Authorization: Bearer $TOKEN")
check "$(echo "$ME" | j 'd["data"]["timeZone"]')" "Asia/Tehran" "GET /me (timezone Asia/Tehran)"

XAPI=$(curl -s "$BASE/me" -H "x-api-key: hnb_yP8VJCAEggsrg5tRWWjKYQSCBoHO1Pnx")
check "$(echo "$XAPI" | j 'd["data"]["username"]')" "demo" "GET /me via x-api-key (hnb_ key works)"

echo "== 2. Public event types by username =="
PUB=$(curl -s "$BASE/event-types?username=demo")
check "$(echo "$PUB" | j 'len(d["data"]["eventTypes"])')" "2" "GET /event-types?username=demo (2 visible)"

echo "== 3. Slots (engine) =="
START=$(date -u -d "+3 hours" +%Y-%m-%dT%H:%M:%SZ)
END=$(date -u -d "+12 days" +%Y-%m-%dT%H:%M:%SZ)
SLOTS=$(curl -s "$BASE/slots?eventTypeId=1&startTime=$START&endTime=$END&timeZone=Asia/Tehran")
N_DATES=$(echo "$SLOTS" | j 'len(d["data"]["slots"])')
# book a MIDDLE slot (second overall) to prove slot-grid alignment, not just interval starts
FIRST_SLOT=$(echo "$SLOTS" | j 'sorted(s["utc"] for day in d["data"]["slots"].values() for s in day)[1]')
FIRST_TZ=$(echo "$SLOTS" | j 'next(iter(d["data"]["slots"].values()))[0]["time"]')
echo "        -> $N_DATES days with slots; first: $FIRST_SLOT ($FIRST_TZ Tehran)"
[ "$N_DATES" -ge 1 ] && ok "GET /slots returns availability" || bad "GET /slots (got: $SLOTS)"

SLOTS_USERNAME=$(curl -s "$BASE/slots?username=demo&eventTypeSlug=consultation-30&startTime=$START&endTime=$END&timeZone=Asia/Tehran")
check "$(echo "$SLOTS_USERNAME" | j 'd["status"]')" "success" "GET /slots via username+eventTypeSlug"

echo "== 4. Create booking (public) =="
B=$(curl -s -X POST "$BASE/bookings" -H 'content-type: application/json' \
  -d "{\"start\":\"$FIRST_SLOT\",\"eventTypeId\":1,\"attendee\":{\"name\":\"Ali Rezaei\",\"email\":\"ali@example.com\",\"timeZone\":\"Asia/Tehran\"},\"guests\":[\"guest@example.com\"]}")
BOOK_UID=$(echo "$B" | j 'd["data"]["booking"]["uid"]')
check "$(echo "$B" | j 'd["data"]["booking"]["status"]')" "ACCEPTED" "POST /bookings creates ACCEPTED booking"
[ -n "$BOOK_UID" ] && ok "booking uid = $BOOK_UID" || bad "no booking uid (got: $B)"

echo "== 5. Double-booking rejected =="
DUP=$(curl -s -X POST "$BASE/bookings" -H 'content-type: application/json' \
  -d "{\"start\":\"$FIRST_SLOT\",\"eventTypeId\":1,\"attendee\":{\"name\":\"Sara\",\"email\":\"sara@example.com\",\"timeZone\":\"Asia/Tehran\"}}")
check "$(echo "$DUP" | j 'd["error"]["code"]')" "BookingSlotUnavailable" "same slot twice -> BookingSlotUnavailable"

echo "== 6. minimumBookingNotice enforced =="
NOW2=$(date -u -d "+10 minutes" +%Y-%m-%dT%H:%M:%SZ)
NOTICE=$(curl -s -X POST "$BASE/bookings" -H 'content-type: application/json' \
  -d "{\"start\":\"$NOW2\",\"eventTypeId\":1,\"attendee\":{\"name\":\"Early\",\"email\":\"early@example.com\"}}")
check "$(echo "$NOTICE" | j 'd["error"]["code"]')" "MinimumBookingNoticeError" "booking 10min ahead -> MinimumBookingNoticeError"

echo "== 7. Host booking list =="
LIST=$(curl -s "$BASE/bookings?status=upcoming" -H "Authorization: Bearer $TOKEN")
check "$(echo "$LIST" | j 'd["data"]["pagination"]["total"] >= 1')" "True" "GET /bookings?status=upcoming (auth)"

echo "== 8. Booking detail =="
DET=$(curl -s "$BASE/bookings/$BOOK_UID")
check "$(echo "$DET" | j 'd["data"]["booking"]["attendees"][0]["email"]')" "ali@example.com" "GET /bookings/{uid} (public detail)"

echo "== 9. Reschedule (host) =="
# find a second slot at least 2h ahead that is still free (slots refresh after booking)
SECOND=$(curl -s "$BASE/slots?eventTypeId=1&startTime=$START&endTime=$END&timeZone=Asia/Tehran" \
  | j 'sorted(s["utc"] for day in d["data"]["slots"].values() for s in day if s["utc"] > "'$FIRST_SLOT'")[0]')
RES=$(curl -s -X POST "$BASE/bookings/$BOOK_UID/reschedule" -H "Authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' -d "{\"start\":\"$SECOND\"}")
GOT_START=$(echo "$RES" | j 'd["data"]["booking"]["start"]')
check "$(python3 -c "from datetime import datetime;print(int(datetime.fromisoformat('$GOT_START'.replace('Z','+00:00')).timestamp()))")" \
      "$(python3 -c "from datetime import datetime;print(int(datetime.fromisoformat('$SECOND'.replace('Z','+00:00')).timestamp()))")" \
      "POST /bookings/{uid}/reschedule moves the slot"
check "$(echo "$RES" | j 'd["data"]["booking"]["rescheduledBy"]')" "host:1" "reschedule recorded rescheduledBy"

echo "== 10. Cancel by attendee email (no auth) =="
CAN=$(curl -s -X POST "$BASE/bookings/$BOOK_UID/cancel" -H 'content-type: application/json' \
  -d '{"email":"ali@example.com","reason":"Plans changed"}')
check "$(echo "$CAN" | j 'd["data"]["booking"]["status"]')" "CANCELLED" "attendee cancels via email match"
check "$(echo "$CAN" | j 'd["data"]["booking"]["cancelledBy"]')" "ali@example.com" "cancelledBy recorded"

echo "== 11. Confirmation workflow (requiresConfirmation) =="
# team-meeting-60 -> PENDING
MEET_SLOT=$(curl -s "$BASE/slots?eventTypeId=2&startTime=$START&endTime=$END&timeZone=Asia/Tehran" \
  | j 'sorted(s["utc"] for day in d["data"]["slots"].values() for s in day)[0]')
PB=$(curl -s -X POST "$BASE/bookings" -H 'content-type: application/json' \
  -d "{\"start\":\"$MEET_SLOT\",\"eventTypeId\":2,\"attendee\":{\"name\":\"Mina\",\"email\":\"mina@example.com\"}}")
MEET_UID=$(echo "$PB" | j 'd["data"]["booking"]["uid"]')
check "$(echo "$PB" | j 'd["data"]["booking"]["status"]')" "PENDING" "requiresConfirmation -> PENDING booking"
check "$(echo "$PB" | j 'd["data"]["booking"]["title"]')" "Mina & کاربر نمونه hnobat" "booking title composed host+booker"

CONF=$(curl -s -X POST "$BASE/bookings/$MEET_UID/confirm" -H "Authorization: Bearer $TOKEN")
check "$(echo "$CONF" | j 'd["data"]["booking"]["status"]')" "ACCEPTED" "POST confirm -> ACCEPTED"

# another pending booking to decline
PB2=$(curl -s -X POST "$BASE/bookings" -H 'content-type: application/json' \
  -d "{\"start\":\"$(curl -s "$BASE/slots?eventTypeId=2&startTime=$START&endTime=$END&timeZone=Asia/Tehran" | j 'sorted(s["utc"] for day in d["data"]["slots"].values() for s in day if s["utc"] > "'$MEET_SLOT'")[0]')\",\"eventTypeId\":2,\"attendee\":{\"name\":\"Omid\",\"email\":\"omid@example.com\"}}")
MEET_UID2=$(echo "$PB2" | j 'd["data"]["booking"]["uid"]')
DEC=$(curl -s -X POST "$BASE/bookings/$MEET_UID2/decline" -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' -d '{"reason":"Not available"}')
check "$(echo "$DEC" | j 'd["data"]["booking"]["status"]')" "REJECTED" "POST decline -> REJECTED"
# freed slot can be booked again
FREED=$(curl -s -X POST "$BASE/bookings" -H 'content-type: application/json' \
  -d "{\"start\":\"$(echo "$PB2" | j 'd["data"]["booking"]["start"]')\",\"eventTypeId\":2,\"attendee\":{\"name\":\"Nima\",\"email\":\"nima@example.com\"}}")
check "$(echo "$FREED" | j 'd["data"]["booking"]["status"]')" "PENDING" "rejected slot freed and bookable again"

echo "== 12. Webhooks CRUD =="
W=$(curl -s -X POST "$BASE/webhooks" -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"subscriberUrl":"https://example.com/hnobat-hook","eventTriggers":["BOOKING_CREATED","BOOKING_CANCELLED"],"secret":"supersecret123"}')
WID=$(echo "$W" | j 'd["data"]["webhook"]["id"]')
check "$(echo "$W" | j 'd["data"]["webhook"]["active"]')" "True" "POST /webhooks registers subscriber"
WDEL=$(curl -s -X DELETE "$BASE/webhooks/$WID" -H "Authorization: Bearer $TOKEN")
check "$(echo "$WDEL" | j 'd["data"]["deleted"]')" "True" "DELETE /webhooks/{id}"

echo "== 13. API keys lifecycle =="
K=$(curl -s -X POST "$BASE/api-keys" -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' -d '{"name":"e2e-test"}')
RAW=$(echo "$K" | j 'd["data"]["key"]')
check "$(echo "$RAW" | cut -c1-4)" "hnb_" "POST /api-keys returns hnb_ key once"
KME=$(curl -s "$BASE/me" -H "x-api-key: $RAW")
check "$(echo "$KME" | j 'd["data"]["username"]')" "demo" "new key authenticates"
KID=$(echo "$K" | j 'd["data"]["apiKey"]["id"]')
KDEL=$(curl -s -X DELETE "$BASE/api-keys/$KID" -H "Authorization: Bearer $TOKEN")
check "$(echo "$KDEL" | j 'd["data"]["deleted"]')" "True" "DELETE /api-keys/{id}"
KME2=$(curl -s "$BASE/me" -H "x-api-key: $RAW")
check "$(echo "$KME2" | j 'd["error"]["code"]')" "UnauthorizedError" "revoked key no longer works"

echo "== 14. Schedules CRUD =="
S=$(curl -s -X POST "$BASE/schedules" -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"name":"Evening shift","timeZone":"Asia/Tehran","availability":[{"days":[4,5],"startTime":"18:00","endTime":"21:00"}]}')
SID=$(echo "$S" | j 'd["data"]["schedule"]["id"]')
check "$(echo "$S" | j 'len(d["data"]["schedule"]["availability"])')" "1" "POST /schedules with availability rows"
SP=$(curl -s -X PATCH "$BASE/schedules/$SID" -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"availability":[{"days":[5],"startTime":"19:00","endTime":"22:00"},{"days":[5],"startTime":"19:00","endTime":"22:00","date":"'$END'"}]}')
check "$(echo "$SP" | j 'len(d["data"]["schedule"]["availability"])')" "2" "PATCH /schedules/{id} replaces availability (+date override)"
SDEL=$(curl -s -X DELETE "$BASE/schedules/$SID" -H "Authorization: Bearer $TOKEN")
check "$(echo "$SDEL" | j 'd["data"]["deleted"]')" "True" "DELETE /schedules/{id}"

echo "== 15. Unauthorized access =="
NOAUTH=$(curl -s "$BASE/bookings?status=all")
check "$(echo "$NOAUTH" | j 'd["error"]["code"]')" "UnauthorizedError" "GET /bookings without auth -> UnauthorizedError"

echo ""
echo "================================================"
echo "  RESULT: $PASS passed, $FAIL failed"
echo "================================================"
exit $FAIL
