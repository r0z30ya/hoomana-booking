# hnobat — موتور نوبت‌دهی (فاز ۱: فقط API)

کلون API-محور از سرویس متن‌باز **cal.com** با همان معماری و مفاهیم دامنه (User, EventType, Schedule/Availability, Booking, Slot Engine, Webhook, API Key) — به‌علاوه قواعد ایرانی: هفتهٔ کاری شنبه تا چهارشنبه و منطقهٔ زمانی پیش‌فرض `Asia/Tehran`.

این مخزن **بدون رابط کاربری** است؛ کل محصول یک REST API نسخهٔ v2 است که می‌تواند به‌عنوان «موتور نوبت‌دهی» در هر سامانهٔ دیگری (اپ موبایل، سایت، ربات) استفاده شود. یک صفحهٔ وضعیت کوچک در `/` مستندات خلاصهٔ Endpoint ها را نشان می‌دهد.

---

## تکنولوژی‌ها (هم‌سو با cal.com)

| لایه | تکنولوژی |
|---|---|
| فریم‌ورک | Next.js 16 (App Router, Route Handlers) + TypeScript |
| ORM / دیتابیس | Prisma + SQLite (فایل `db/custom.db`؛ قابل تعویض با PostgreSQL) |
| اعتبارسنجی | Zod (اسکیمای ورودی همهٔ Endpoint ها) |
| زمان و تایم‌زون | date-fns + date-fns-tz (همان کتابخانه‌های موتور اسلات cal.com) |
| احراز هویت | JWT دستی (HS256) + API Key با پیشوند `hnb_` (ذخیرهٔ هش SHA-256 — مثل cal.com) |
| وب‌هوک | تریگرهای هم‌نام cal.com + امضای HMAC-SHA256 |

---

## راه‌اندازی سریع

```bash
# ۱) نصب وابستگی‌ها (bun یا npm)
bun install        # یا: npm install

# ۲) تنظیم محیط
cp .env.example .env

# ۳) ساخت اسکیمای دیتابیس (اگر db/custom.db از قبل موجود است، این مرحله اختیاری است)
npx prisma db push          # یا: bunx prisma db push

# ۴) دادهٔ دمو (میزبان نمونه، ساعات کاری، دو نوع نوبت، کلید API)
npx tsx scripts/seed.ts     # یا: bunx tsx scripts/seed.ts

# ۵) اجرا
npm run dev                 # http://localhost:3000
```

> فایل `db/custom.db` در همین مخزن **از قبل seed شده** است؛ بنابراین با `npm run dev` می‌توانید بلافاصله شروع کنید.

### دادهٔ دمو

| مورد | مقدار |
|---|---|
| میزبان | `demo@hnobat.io` / رمز `hnobat1234` (username: `demo`) |
| نوع نوبت‌ها | `consultation-30` (۳۰ دقیقه‌ای، تأیید خودکار) و `team-meeting-60` (۶۰ دقیقه‌ای، نیازمند تأیید میزبان) |
| ساعات کاری | شنبه–چهارشنبه ۰۹:۰۰–۱۷:۰۰ و پنجشنبه ۰۹:۰۰–۱۳:۰۰ به وقت `Asia/Tehran` |
| کلید API دمو | `hnb_yP8VJCAEggsrg5tRWWjKYQSCBoHO1Pnx` (فقط برای تست محلی) |

---

## متغیرهای محیطی

| متغیر | پیش‌فرض | توضیح |
|---|---|---|
| `DATABASE_URL` | `file:../db/custom.db` | مسیر دیتابیس SQLite (نسبت به `prisma/schema.prisma`) یا رشتهٔ اتصال PostgreSQL |
| `JWT_SECRET` | مقدار توسعه | کلید امضای توکن‌های JWT — در محیط واقعی حتماً تغییر دهید (`openssl rand -hex 32`) |

---

## احراز هویت

**۱) JWT (نشست کاربر):**

```bash
curl -X POST http://localhost:3000/api/v2/auth/login \
  -H 'content-type: application/json' \
  -d '{"email":"demo@hnobat.io","password":"hnobat1234"}'
# → { "status":"success", "data":{ "accessToken":"eyJ...", "tokenType":"Bearer", "expiresIn":2592000 } }
```

سپس روی Endpoint های محافظت‌شده: `Authorization: Bearer <token>`

**۲) API Key (برای سامانه‌های ماشین‌توماشین):**

```bash
curl http://localhost:3000/api/v2/me -H "x-api-key: hnb_xxxxx"
# یا
curl http://localhost:3000/api/v2/me -H "Authorization: Bearer hnb_xxxxx"
```

کلیدها فقط یک‌بار هنگام ساخت نمایش داده می‌شوند و در دیتابیس فقط هش SHA-256 آن‌ها ذخیره می‌شود (همان رفتار cal.com).

---

## Endpoint های API v2

پاسخ‌ها با پاکت استاندارد cal.com v2 برمی‌گردند:

```jsonc
// موفق
{ "status": "success", "data": { ... } }
// خطا
{ "status": "error", "timestamp": "...", "path": "...", "error": { "code": "BookingSlotUnavailable", "message": "..." } }
```

### Auth و پروفایل

| متد | مسیر | دسترسی | توضیح |
|---|---|---|---|
| POST | `/api/v2/auth/signup` | عمومی | ثبت‌نام → JWT |
| POST | `/api/v2/auth/login` | عمومی | ورود → JWT |
| GET | `/api/v2/me` | JWT / API Key | پروفایل کاربر جاری |
| PATCH | `/api/v2/me` | JWT / API Key | ویرایش نام، username، timeZone، … |

### انواع نوبت (EventType) — مثل «Meeting Types» در cal.com

| متد | مسیر | دسترسی | توضیح |
|---|---|---|---|
| GET | `/api/v2/event-types` | JWT / API Key | لیست انواع نوبت خودم |
| GET | `/api/v2/event-types?username=demo` | عمومی | انواع نوبت عمومی یک میزبان (مثل صفحهٔ رزرو) |
| POST | `/api/v2/event-types` | JWT / API Key | ایجاد نوع نوبت |
| GET/PATCH/DELETE | `/api/v2/event-types/{id}` | JWT / API Key | جزئیات / ویرایش / حذف |

فیلدهای مهم هنگام ایجاد:

```jsonc
{
  "title": "مشاوره ۳۰ دقیقه‌ای",
  "length": 30,                        // دقیقه (۵ تا ۷۲۰)
  "slotInterval": 30,                  // فاصلهٔ اسلات‌ها؛ پیش‌فرض = length
  "minimumBookingNotice": 120,         // حداقل فاصلهٔ رزرو تا زمان نوبت (دقیقه)
  "beforeBufferTime": 0,               // بافر قبل از رویداد
  "afterBufferTime": 0,                // بافر بعد از رویداد
  "requiresConfirmation": false,       // true → نوبت‌ها PENDING می‌شوند
  "disableGuests": false,
  "seatsPerTimeSlot": null,            // ظرفیت اشتراکی یک اسلات (کلاس گروهی)
  "periodType": "UNLIMITED",           // UNLIMITED | ROLLING | RANGE
  "periodDays": 30,
  "periodCountCalendarDays": true,     // false = روز کاری
  "periodStartDate": null,
  "periodEndDate": null,
  "timeZone": null,                    // override تایم‌زون برنامهٔ هفتگی
  "scheduleId": 1,
  "locations": ["integrations:daily"],
  "price": 0, "currency": "usd",
  "metadata": {}
}
```

### ساعات کاری (Schedule / Availability)

| متد | مسیر | توضیح |
|---|---|---|
| GET | `/api/v2/schedules` | لیست برنامه‌ها + ردیف‌های availability |
| POST | `/api/v2/schedules` | ایجاد برنامهٔ هفتگی |
| PATCH | `/api/v2/schedules/{id}` | ویرایش؛ جایگزینی کامل ردیف‌ها |
| DELETE | `/api/v2/schedules/{id}` | حذف (برنامهٔ پیش‌فرض بعدی ارتقا می‌یابد) |

قرارداد ردیف availability (دقیقاً مثل cal.com — زمان‌ها روی تاریخ مرجع ۱۹۷۰-۰۱-۰۱ ذخیره می‌شوند):

```jsonc
{ "days": [6,0,1,2,3], "startTime": "09:00", "endTime": "17:00" }
// ۰=یکشنبه … ۶=شنبه (قرارداد getDay جاوااسکریپت)
// endTime == "00:00" یعنی ۲۴:۰۰
// + فیلد اختیاری "date": "2026-12-25" → override برای یک روز مشخص (تعطیلی یا ساعت خاص)
```

### اسلات‌های آزاد (قلب موتور نوبت‌دهی)

```
GET /api/v2/slots?eventTypeId=1
                 &startTime=2026-11-10T00:00:00Z
                 &endTime=2026-11-12T00:00:00Z
                 &timeZone=Asia/Tehran
```

- `eventTypeId` **یا** `username` + `eventTypeSlug` (حالت عمومی صفحهٔ رزرو)
- بازهٔ حداکثر ۳۱ روز
- خروجی: اسلات‌ها بر اساس روزِ محلی در تایم‌زون درخواستی:

```jsonc
{ "status": "success", "data": {
  "slots": {
    "2026-11-10": [
      { "time": "2026-11-10T09:00:00+03:30", "utc": "2026-11-10T05:30:00.000Z" },
      { "time": "2026-11-10T09:30:00+03:30", "utc": "2026-11-10T06:00:00.000Z" }
    ]
  },
  "meta": { "eventTypeId": 1, "duration": 30, "timeZone": "Asia/Tehran", "slotInterval": 30 }
} }
```

قواعد موتور (رفتار cal.com):
1. ساعات کاری از برنامهٔ نوبت (یا برنامهٔ پیش‌فرض میزبان) و به‌وقت تایم‌زون برنامه محاسبه می‌شود.
2. ردیف‌های دارای `date` جایگزین کامل ردیف‌های هفتگی همان روز می‌شوند.
3. نوبت‌های فعال میزبان (PENDING/ACCEPTED) + بافرهای قبل/بعد، «اشغال» محسوب می‌شوند.
4. `minimumBookingNotice` از نزدیک‌ترین لحظهٔ قابل رزرو جلوگیری می‌کند.
5. `periodType` بازهٔ مجاز رزرو را محدود می‌کند (ROLLING با روز کاری یا تقویمی، RANGE بازهٔ مطلق).
6. گام اسلات‌ها = `slotInterval ?? length` و اسلات باید کامل داخل بازهٔ آزاد جا شود.
7. برای رویدادهای ظرفیتی (`seatsPerTimeSlot`) اسلات پرشده حذف می‌شود و `seatsLeft` گزارش می‌شود.

### رزرو نوبت (Booking)

| متد | مسیر | دسترسی | توضیح |
|---|---|---|---|
| POST | `/api/v2/bookings` | عمومی | رزرو نوبت (اعتبارسنجی کامل موتور) |
| GET | `/api/v2/bookings?status=upcoming\|past\|cancelled\|unconfirmed\|all&take=&skip=` | JWT / API Key | لیست نوبت‌های میزبان |
| GET | `/api/v2/bookings/{uid}` | عمومی | جزئیات نوبت (فیلدهای حساس برای غیرمیزبان حذف می‌شود) |
| POST | `/api/v2/bookings/{uid}/confirm` | میزبان | PENDING → ACCEPTED |
| POST | `/api/v2/bookings/{uid}/decline` | میزبان | PENDING → REJECTED (+ `reason`) |
| POST | `/api/v2/bookings/{uid}/cancel` | میزبان یا حاضر | لغو (حاضر فقط با ایمیل مطابق: `{"email":"ali@example.com"}`) |
| POST | `/api/v2/bookings/{uid}/reschedule` | میزبان یا حاضر | جابه‌جایی به زمان آزاد جدید (اعتبارسنجی موتور دوباره اجرا می‌شود) |

ایجاد نوبت:

```bash
curl -X POST http://localhost:3000/api/v2/bookings \
  -H 'content-type: application/json' \
  -d '{
    "start": "2026-11-10T06:30:00.000Z",       // ۰۹:۰۰ تهران — باید دقیقاً یکی از اسلات‌های موتور باشد
    "username": "demo", "eventTypeSlug": "consultation-30",
    "attendee": { "name": "علی رضایی", "email": "ali@example.com", "timeZone": "Asia/Tehran" },
    "guests": ["guest@example.com"],
    "metadata": { "crmId": "123" }
  }'
```

- نوبتِ نوعِ بدون تأیید → `ACCEPTED`؛ نوعِ نیازمند تأیید → `PENDING`
- درخواست روی اسلات اشغال/خارج از شبکهٔ اسلات‌ها → خطای `BookingSlotUnavailable`
- رزرو زودتر از حداقل فاصله → `MinimumBookingNoticeError`
- لغو/رد، اسلات را برای دیگران آزاد می‌کند.

### وب‌هوک‌ها

| متد | مسیر | توضیح |
|---|---|---|
| GET/POST | `/api/v2/webhooks` | ثبت/لیست subscriber ها |
| PATCH/DELETE | `/api/v2/webhooks/{id}` | ویرایش/حذف |

تریگرها (هم‌نام cal.com): `BOOKING_CREATED`, `BOOKING_REQUESTED`, `BOOKING_CONFIRMED`, `BOOKING_RESCHEDULED`, `BOOKING_CANCELLED`, `BOOKING_REJECTED`, `BOOKING_PAID`, `MEETING_ENDED`

بدنهٔ ارسالی: `{ "triggerEvent", "createdAt", "webhookId", "payload": { "booking": ... } }` و در صورت تعیین `secret`، هدر امضا:

```
x-hnobat-signature-256: <hex(HMAC_SHA256(rawBody, secret))>
```

برای تست محلی: `bun scripts/hook-receiver.ts` (گیرندهٔ نمونه روی پورت 3099).

### کلیدهای API

| متد | مسیر | توضیح |
|---|---|---|
| GET | `/api/v2/api-keys` | لیست کلیدها (بدون مقدار خام) |
| POST | `/api/v2/api-keys` | ساخت کلید `hnb_...` — فقط یک‌بار نمایش داده می‌شود |
| DELETE | `/api/v2/api-keys/{id}` | ابطال |

### سلامت سرویس

```
GET /api/v2/health  →  { "status":"success", "data":{ "service":"hnobat", "engine":"booking-engine", "version":"v2", ... } }
```

---

## تست پایان‌به‌پا

با سرور در حال اجرا (`npm run dev`) روی پورت 3000:

```bash
bash scripts/test-api.sh
```

۱۵ سناریو را می‌سنجد: سلامت، ورود، کلید API، اسلات‌گیری، رزرو، جلوگیری از رزرو دوباره، حداقل فاصله، لیست میزبان، جزئیات، جابه‌جایی، لغو توسط حاضر، چرخهٔ تأیید/رد، CRUD وب‌هوک، چرخهٔ کلید API و CRUD ساعات کاری.

---

## ساختار پروژه

```
src/
├── app/
│   ├── api/v2/…            # تمام Endpoint ها (Route Handlers)
│   ├── layout.tsx          # RTL فارسی
│   └── page.tsx            # صفحهٔ وضعیت + مستندات خلاصه
├── lib/
│   ├── api/
│   │   ├── slot-engine.ts  # موتور محاسبهٔ اسلات (هم‌ارز packages/core در cal.com)
│   │   ├── auth.ts         # JWT + API Key (scrypt برای رمز، SHA-256 برای کلید)
│   │   ├── validate.ts     # اسکیمای Zod همهٔ ورودی‌ها
│   │   ├── response.ts     # پاکت پاسخ + کدهای خطای cal.com v2
│   │   ├── serialize.ts    # DTO خروجی (Booking/Availability)
│   │   ├── booking-access.ts # مالکیت میزبان / لغو و جابه‌جایی توسط حاضر
│   │   ├── webhooks.ts     # تریگرها + امضای HMAC
│   │   └── availability.ts # تبدیل ورودی availability به ردیف دیتابیس
│   └── db.ts               # کلاینت Prisma (singleton)
scripts/
├── seed.ts                 # دادهٔ دمو (میزبان تهران، دو نوع نوبت، کلید API)
├── test-api.sh             # تست پایان‌به‌پا (۱۵ سناریو)
└── hook-receiver.ts        # گیرندهٔ نمونهٔ وب‌هوک
prisma/schema.prisma        # مدل دامنه: User, Team, EventType, Schedule, Availability, Booking, Attendee, ApiKey, Webhook
db/custom.db                # دیتابیس SQLite آماده (seed شده)
```

---

## مهاجرت به PostgreSQL

اسکیما عمداً ساده نگه داشته شده (enum ها و آرایه‌ها به‌صورت رشتهٔ JSON در SQLite ذخیره می‌شوند). برای PostgreSQL:

1. در `prisma/schema.prisma` مقدار `provider` را به `"postgresql"` تغییر دهید.
2. `DATABASE_URL` را به رشتهٔ اتصال Postgres تغییر دهید.
3. فیلدهای `days`, `locations`, `eventTriggers`, `metadata`, `responses` را به `Int[]`/`Json` برگردانید و استفادهٔ `JSON.parse/stringify` را از سرویس‌ها حذف کنید.
4. `npx prisma db push && npx tsx scripts/seed.ts`

---

## نقشهٔ راه (فاز ۲)

- Teams و Event Type تیمی با Round-Robin (مدل‌های `Team` و `Membership` از الان در اسکیما هستند)
- تقویم‌های خارجی (Google / Outlook) و BookingReference
- OAuth و ورود با ایمیل (Magic Link)
- پرداخت نوبت (`paid`, `price` آماده است) و trigger مکالمات/یادآوری
- محدودسازی نرخ (Rate-limit) و لاگ ممیزی

---

*نسخهٔ فاز ۱ — تولیدشده بر پایهٔ معماری متن‌باز cal.com (AGPLv3) به‌عنوان مرجع طراحی.*
