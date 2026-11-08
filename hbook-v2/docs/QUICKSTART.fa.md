# راهنمای سریع hbook (فارسی)

موتور نوبت‌دهی سریع و امن — بدون فرانت‌اند، فقط API روی PostgreSQL.
الگوی آن از cal.com / cal.diy گرفته شده: خدمت (Event Type)، ساعات کاری
(Availability)، اسلات آزاد و رزرو — آمادهٔ اتصال سرور-به-سرور به هومانا.

> مستندات کامل انگلیسی: [`README.md`](../README.md) · قرارداد اتصال هومانا:
> [`INTEGRATION.md`](INTEGRATION.md) · استقرار عملیاتی: [`DEPLOY.md`](DEPLOY.md)
> · مرجع تعاملی API: `/docs`

---

## ۱) راه‌اندازی با Docker (یک دستور)

```bash
cp .env.example .env
# در فایل .env این سه را عوض کنید:
#   HBOOK_SETUP_TOKEN=<خروجی: openssl rand -hex 32>
#   HBOOK_WEBHOOK_ENC_KEY=<خروجی: openssl rand -base64 32>   (الزامی در production)
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
| **Tenant** | هر مجموعه (مطب تک‌پزشک یا کلینیک چندپزشک) یک Tenant است |
| **API Key** | احراز هویت همه‌ی درخواست‌ها با هدر `X-API-Key`؛ در دیتابیس فقط هش SHA-256 ذخیره می‌شود؛ دارای **scope** (`admin > manage > book > read`) و چرخش (`rotate`) |
| **User / Host** | افراد قابل نوبت‌دهی (پزشک) — **ایمیل اختیاری**؛ نگهداری شناسهٔ هومانا با `externalId` |
| **Availability** | ساعات کاری هفتگی + تعطیلی/تغییر روز مشخص (Date Override) |
| **Event Type** | خدمت قابل رزرو: مدت، گام اسلات، **ظرفیت هم‌زمان (capacity)**، بافر قبل/بعد، مهلت‌ها |
| **Slot** | زمان‌های آزاد؛ خروجی UTC با `seatsRemaining` |
| **Booking** | رزرو نهایی — بیمار فقط با **شماره موبایل**؛ ایمیل اختیاری |

## ۳) جریان کامل با curl

```bash
KEY="hbk_xxx"        # کلید seed یا کلید ساخته‌شده
BASE="http://localhost:3000"

# ساختن مجموعه (فقط با توکن راه‌اندازی — هدر X-Setup-Token؛ سرور-به-سرور)
# ایمیل مالک اختیاری است
curl -s -X POST $BASE/v1/tenants \
  -H "X-Setup-Token: $HBOOK_SETUP_TOKEN" -H "Content-Type: application/json" \
  -d '{"name":"کلینیک من","slug":"my-clinic","timezone":"Asia/Tehran",
       "owner":{"name":"دکتر سارا"}}'
# ← apiKey.key را ذخیره کنید؛ دوباره نمایش داده نمی‌شود

# ساعات کاری (شنبه تا چهارشنبه، ۹ تا ۱۳ و ۱۴ تا ۱۷)
# weekday: 0=یکشنبه … 6=شنبه
curl -s -X PUT $BASE/v1/users/<userId>/availability \
  -H "X-API-Key: $KEY" -H "Content-Type: application/json" \
  -d '{"weekly":[{"weekday":6,"windows":[{"start":"09:00","end":"13:00"},{"start":"14:00","end":"17:00"}]}]}'

# خدمت با ظرفیت ۳ بیمار هم‌زمان برای هر بازه
curl -s -X POST $BASE/v1/event-types \
  -H "X-API-Key: $KEY" -H "Content-Type: application/json" \
  -d '{"slug":"quick-visit","title":"ویزیت سریع","hostId":"<userId>",
       "durationMin":15,"slotIntervalMin":15,"capacity":3,
       "bufferBeforeMin":0,"bufferAfterMin":10}'

# اسلات‌های آزاد — خروجی UTC با تعداد صندلی باقی‌مانده
curl -s "$BASE/v1/slots?eventTypeId=quick-visit&from=2026-11-10&to=2026-11-12" \
  -H "X-API-Key: $KEY"
# { "slots": [ { "startsAt": "2026-11-10T05:30:00.000Z", "seatsRemaining": 3 }, … ] }

# رزرو فقط با موبایل (فرمت‌های ایرانی پذیرفته می‌شود: ۰۹۱۲… / +98… / 0098…)
# هدر Idempotency-Key: در صورت قطعی شبکه و تلاش مجدد، نوبت تکراری ساخته نمی‌شود
curl -s -X POST $BASE/v1/bookings \
  -H "X-API-Key: $KEY" -H "Content-Type: application/json" \
  -H "Idempotency-Key: <uuid یکتا>" \
  -d '{"eventTypeId":"quick-visit","start":"2026-11-10T05:30:00.000Z",
       "attendee":{"name":"علی رضایی","phone":"۰۹۱۲ ۳۴۵ ۶۷۸۹","timezone":"Asia/Tehran"}}'

# لغو / تأیید / جابجایی
curl -s -X POST $BASE/v1/bookings/<uid>/confirm    -H "X-API-Key: $KEY"
curl -s -X POST $BASE/v1/bookings/<uid>/cancel     -H "X-API-Key: $KEY" -H "Content-Type: application/json" -d '{"reason":"بدون توضیح"}'
curl -s -X POST $BASE/v1/bookings/<uid>/reschedule -H "X-API-Key: $KEY" -H "Content-Type: application/json" -d '{"start":"2026-11-11T06:00:00.000Z"}'
```

## ۴) وب‌هوک‌های قابل‌اتکا

```bash
curl -s -X POST $BASE/v1/webhooks -H "X-API-Key: $KEY" -H "Content-Type: application/json" \
  -d '{"url":"https://homana.example/hooks/hbook","events":["booking.created","booking.cancelled"]}'
# ← secret فقط همین‌جا برگردانده می‌شود؛ در دیتابیس رمزنگاری‌شده (AES-256-GCM) نگه‌داری می‌شود
```

بررسی امضا (Node):

```js
const expected = createHmac('sha256', secret).update(`${t}.${rawBody}`).digest('hex');
// هدرها:  X-HBook-Signature: t=<unix>,v1=<hex>  +  X-HBook-Event-Id (برای dedupe)
// حتماً بدنه‌ی خام امضا شود و |t - الان| ≤ ۳۰۰ ثانیه باشد (ضد replay)
```

- رخدادها: `booking.created` · `booking.confirmed` · `booking.cancelled` · `booking.rescheduled` · `ping`
- تحویل **transactional outbox**: رخداد با خود تغییر در یک تراکنش ثبت می‌شود؛
  با توقف/ری‌استارت موتور از دست نمی‌رود (تست شده).
- تلاش مجدد محدود با backoff (۱s → ۴s → ۱۶s → ۶۴s) و سپس وضعیت `FAILED`؛
  ارسال مجدد دستی: `POST /v1/webhooks/:id/deliveries/:deliveryId/replay`
- تحویل **at-least-once** است — مصرف‌کننده باید بر اساس `X-HBook-Event-Id` تکراری‌ها را حذف کند.
- مقصد وب‌هوک باید عمومی باشد؛ در production فقط `https://` (ضد SSRF؛ لوکال‌هاست/IP خصوصی/لینک-لوکال مسدود است).
- payload بدون دادهٔ حساس بیمار است (فقط شناسه‌ها، زمان‌ها و وضعیت).

## ۵) امنیت — چه چیزهایی رعایت شده

- **ظرفیت در سطح دیتابیس تضمین می‌شود:** شمارندهٔ صندلی (`SlotInstance`) با
  `CHECK (taken <= capacity)` + قفل سطری + `pg_advisory_xact_lock` + تریگر
  دفاعی؛ با چند پردازش و چند instance هم تعداد رزروهای فعال هرگز از ظرفیت
  بیشتر نمی‌شود (تست چندنمونه‌ای دارد).
- **بافر قابل دورزدن نیست:** فهرست اسلات، ثبت نوبت و جابجایی از یک موتور
  مشترک استفاده می‌کنند؛ بازه‌ای که در فهرست مخفی است، با درخواست مستقیم هم
  رزرو نمی‌شود (تست رگرسیون دارد).
- **کلیدها همیشه هش‌شده** با SHA-256؛ چرخش و لغو فوری؛ حملهٔ تعویض کلیدهای
  نامعتبر per-IP محدود می‌شود (حتی با X-Forwarded-For جعلی).
- **عایق‌بندی مستأجر دو لایه:** همهٔ کوئری‌ها با `tenantId` کلید فیلتر می‌شوند
  و FKهای ترکیبی `(id, tenantId)` در دیتابیس جلوی ارجاع بین‌مجموعه‌ای را (حتی
  با SQL خام) می‌گیرند.
- **idempotency سمت سرور** برای ایجاد/لغو/تأیید/جابجایی.
- **توکن راه‌اندازی:** ساخت مجموعه فقط با `HBOOK_SETUP_TOKEN` (مقایسهٔ
  زمان-ثابت، ۵ درخواست در دقیقه)؛ هرگز نباید به فرانت‌اند داده شود.
- **لاگ‌ها بدون راز و بدون دادهٔ تماس بیمار**؛ خروجی‌ها فقط فیلدهای تعریف‌شده.

## ۶) خطاهای رایج

| کد | معنی | راه‌حل |
| --- | --- | --- |
| `SLOT_UNAVAILABLE` (۴۲۲) | زمان درخواستی دقیقاً یکی از اسلات‌ها نیست (یا داخل بافر است) | خروجی `/v1/slots` را عیناً استفاده کنید |
| `SLOT_TAKEN` (۴۰۹) | اسلات/صندلی لحظاتی پیش پر شد | دوباره `/v1/slots` بگیرید |
| `INVALID_PHONE` (۴۲۲) | شماره موبایل معتبر نیست | مثل `09123456789` بفرستید |
| `IDEMPOTENCY_KEY_REUSED` (۴۲۲) | همان کلید idempotency با بدنهٔ متفاوت | کلید جدید برای عملیات جدید |
| `CAPACITY_CONFLICT` (۴۲۲) | کاهش ظرفیت زیر صندلی‌های رزروشده | اول نوبت‌ها را لغو کنید |
| `INVALID_API_KEY` (۴۰۱) | کلید اشتباه/باطل‌شده | کلید جدید بسازید `POST /v1/api-keys` |
| `SCOPE_INSUFFICIENT` (۴۰۳) | کلید اجازهٔ این کار را ندارد | کلید با scope مناسب بسازید |
| `RATE_LIMITED` (۴۲۹) | عبور از سقف درخواست/تلاش ناموفق | چند ثانیه صبر کنید |

## ۷) بدون Docker (توسعه‌ی محلی)

```bash
npm install
export DATABASE_URL="postgresql://hbook:hbook@localhost:5432/hbook?connection_limit=10"
npm run db:migrate && npm run db:seed
npm run dev
```

تست‌ها (واقعی، روی PostgreSQL):

```bash
npm test                 # ۵۹ واحدی + ۱۱۲ انتها-به-انتها
npm run test:multi       # چند instance + بازیابی پس از ری‌استارت
npm run test:load        # بار واقع‌بینانه
```
