# راهنمای سریع hbook (فارسی)

موتور نوبت‌دهی سریع و امن — بدون فرانت‌اند، فقط API روی PostgreSQL.
الگوی آن از cal.com / cal.diy گرفته شده: رویداد (Event Type)، ساعات کاری (Availability)، اسلات آزاد و رزرو.

> مستندات کامل انگلیسی: [`README.md`](../README.md) — مرجع تعاملی API: `/docs`

---

## ۱) راه‌اندازی با Docker (یک دستور)

```bash
cp .env.example .env
# در فایل .env این دو را عوض کنید:
#   HBOOK_SETUP_TOKEN=<خروجی: openssl rand -hex 32>
#   POSTGRES_PASSWORD=<یک رمز قوی>
docker compose up -d --build
```

- آدرس API: `http://localhost:3000`
- مستندات تعاملی (Swagger): `http://localhost:3000/docs`
- سلامت سرویس: `http://localhost:3000/health`

داده نمونه کلینیک (اختیاری):

```bash
docker compose exec api npm run db:seed
```

این دستور یک **کلید API** در ترمینال چاپ می‌کند — فقط همین یک بار نمایش داده می‌شود؛ همان لحظه ذخیره‌اش کنید.

## ۲) مفاهیم (به ترتیب استفاده)

| مفهوم | توضیح |
| --- | --- |
| **Tenant** | هر کسب‌وکار (کلینیک، سالن، مشاور) یک Tenant است |
| **API Key** | احراز هویت همه‌ی درخواست‌ها با هدر `X-API-Key`؛ در دیتابیس فقط هش SHA-256 ذخیره می‌شود |
| **User / Host** | افراد قابل نوبت‌دهی (مثلاً پزشک) |
| **Availability** | ساعات کاری هفتگی + تعطیلی/تغییر روز مشخص (Date Override) |
| **Event Type** | خدمت قابل رزرو: مدت، فاصله اسلات، بافر، مهلت قبلی/بعدی |
| **Slot** | زمان‌های آزاد که `GET /v1/slots` به UTC برمی‌گرداند |
| **Booking** | رزرو نهایی — ایمن در برابر رزرو همزمان |

## ۳) جریان کامل با curl

```bash
KEY="hbk_xxx"        # کلید seed یا کلید ساخته‌شده
BASE="http://localhost:3000"

# ساختن Tenant جدید (فقط با توکن راه‌اندازی — هدر X-Setup-Token)
curl -s -X POST $BASE/v1/tenants \
  -H "X-Setup-Token: $HBOOK_SETUP_TOKEN" -H "Content-Type: application/json" \
  -d '{"name":"کلینیک من","slug":"my-clinic","timezone":"Asia/Tehran",
       "owner":{"name":"دکتر سارا","email":"sara@clinic.test"}}'
# ← apiKey.key را ذخیره کنید؛ دوباره نمایش داده نمی‌شود

# ساعات کاری (شنبه تا چهارشنبه، ۹ تا ۱۳ و ۱۴ تا ۱۷)
# weekday: 0=یکشنبه … 6=شنبه
curl -s -X PUT $BASE/v1/users/<userId>/availability \
  -H "X-API-Key: $KEY" -H "Content-Type: application/json" \
  -d '{"weekly":[{"weekday":6,"windows":[{"start":"09:00","end":"13:00"},{"start":"14:00","end":"17:00"}]}]}'

# نوع خدمت (ویزیت ۱۵ دقیقه‌ای)
curl -s -X POST $BASE/v1/event-types \
  -H "X-API-Key: $KEY" -H "Content-Type: application/json" \
  -d '{"slug":"quick-visit","title":"ویزیت سریع","hostId":"<userId>","durationMin":15}'

# اسلات‌های آزاد (از/تا به تاریخ محلی؛ خروجی UTC است)
curl -s "$BASE/v1/slots?eventTypeId=quick-visit&from=2026-11-10&to=2026-11-12" \
  -H "X-API-Key: $KEY"

# رزرو — start باید دقیقاً یکی از اسلات‌ها باشد
curl -s -X POST $BASE/v1/bookings \
  -H "X-API-Key: $KEY" -H "Content-Type: application/json" \
  -d '{"eventTypeId":"quick-visit","start":"2026-11-10T05:30:00.000Z",
       "attendee":{"name":"علی رضایی","email":"ali@example.com","timezone":"Asia/Tehran"}}'

# لغو / جابجایی
curl -s -X POST $BASE/v1/bookings/<uid>/cancel   -H "X-API-Key: $KEY" -H "Content-Type: application/json" -d '{"reason":"بدون توضیح"}'
curl -s -X POST $BASE/v1/bookings/<uid>/reschedule -H "X-API-Key: $KEY" -H "Content-Type: application/json" -d '{"start":"2026-11-11T06:00:00.000Z"}'
```

## ۴) وب‌هوک‌ها (امضادار)

```bash
curl -s -X POST $BASE/v1/webhooks -H "X-API-Key: $KEY" -H "Content-Type: application/json" \
  -d '{"url":"https://your-app.example/hooks/hbook","events":["booking.created","booking.cancelled"]}'
# ← secret فقط همین‌جا برگردانده می‌شود
```

بررسی امضا (Node):

```js
const expected = createHmac('sha256', secret).update(`${t}.${rawBody}`).digest('hex');
// هدر:  X-HBook-Signature: t=<unix>,v1=<hex>   — حتماً بدنه‌ی خام (raw) امضا شود
```

رخدادها: `booking.created` · `booking.confirmed` · `booking.cancelled` · `booking.rescheduled` · `ping`
تلاش مجدد: ۳ بار (۱ ثانیه → ۴ ثانیه → ۱۶ ثانیه) + لاگ در `GET /v1/webhooks/:id/deliveries`

## ۵) امنیت — چه چیزهایی رعایت شده

- **ضد رزرو دوبله در سطح دیتابیس:** قید `EXCLUDE USING gist` روی بازه‌ی زمانی + `pg_advisory_xact_lock` داخل تراکنش؛ حتی اگر دو درخواست همزمان برسند، فقط یکی ثبت می‌شود و دیگری `409 SLOT_TAKEN` می‌گیرد.
- **کلیدها همیشه هش‌شده:** با SHA-256 ذخیره می‌شوند؛ نشت دیتابیس = نشت کلید نیست.
- **توکن راه‌اندازی:** ساخت Tenant فقط با `HBOOK_SETUP_TOKEN` (مقایسه‌ی زمان-ثابت) و محدود به ۵ درخواست در دقیقه؛ در پروduction بدون این توکن سرور اصلاً بالا نمی‌آید.
- **اعتبارسنجی و سریالایزیشن:** ورودی‌ها با JSON Schema (AJV) اعتبارسنجی و فیلدهای اضافه حذف می‌شوند؛ خروجی‌ها فقط فیلدهای تعریف‌شده را شامل می‌شوند (ضد نشت داده).
- **محدودسازی نرخ + هدرهای امنیتی:** ۳۰۰ درخواست/دقیقه برای هر کلید/IP (قابل تنظیم)، هدرهای Helmet، بدنه حداکثر ۶۴ کیلوبایت.
- **عایق‌بندی مستأجر (Tenant Isolation):** همه‌ی کوئری‌ها با `tenantId` کلید API فیلتر می‌شوند؛ هیچ مسیری بین Tenantها عبور نمی‌کند.
- **کرسر به‌جای OFFSET:** صفحه‌بندی بدون اسکن عمیق؛ همه‌ی مسیرهای فیلتر ایندکس دارند.

## ۶) خطاهای رایج

| کد | معنی | راه‌حل |
| --- | --- | --- |
| `SLOT_UNAVAILABLE` (۴۲۲) | زمان درخواستی دقیقاً یکی از اسلات‌ها نیست | خروجی `/v1/slots` را عیناً استفاده کنید |
| `SLOT_TAKEN` (۴۰۹) | اسلات لحظاتی پیش رزرو شد | دوباره `/v1/slots` بگیرید |
| `INVALID_API_KEY` (۴۰۱) | کلید اشتباه/باطل‌شده | کلید جدید بسازید `POST /v1/api-keys` |
| `SETUP_TOKEN_INVALID` (۴۰۱) | توکن راه‌اندازی غلط | مقدار `.env` را بررسی کنید |
| `RATE_LIMITED` (۴۲۹) | عبور از سقف درخواست | چند ثانیه صبر کنید |

## ۷) بدون Docker (توسعه‌ی محلی)

```bash
npm install
export DATABASE_URL="postgresql://hbook:hbook@localhost:5432/hbook?connection_limit=10"
npm run db:migrate && npm run db:seed
npm run dev
```

تست جامع انتها-به-انتها (روی سرور در حال اجرا):

```bash
BASE_URL=http://localhost:3000 HBOOK_SETUP_TOKEN=<token> npm run test:e2e
```
