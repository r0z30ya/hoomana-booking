# hbook — راهنمای استقرار و عملیات (فارسی)

این سند برای زیرساخت هومانا نوشته شده است: اجرای hbook کنار هومانا روی
**یک نمونه PostgreSQL مشترک با schema جداگانه**، بدون نیاز به PostgreSQL دوم.

---

## ۱. معماری و پیش‌نیازها

- hbook: Fastify + Prisma، بدون فرانت‌اند؛ فقط API.
- دیتابیس: PostgreSQL ≥ 14. تمام زمان‌ها `timestamptz` (UTC) ذخیره می‌شوند.
- هیچ وابستگی به موتور یا دیتابیس فرانت‌اند هومانا ندارد.

### متغیرهای محیطی ضروری محیط عملیاتی

| متغیر | الزام | توضیح |
| --- | --- | --- |
| `DATABASE_URL` | ✅ | مثل `postgresql://hbook_app:***@db:5432/homana?schema=hbook&connection_limit=10` |
| `HBOOK_SETUP_TOKEN` | ✅ | توکن اصلی ساخت مجموعه (فقط سرور-به-سرور). `openssl rand -hex 32` |
| `HBOOK_WEBHOOK_ENC_KEY` | ✅ در production | کلید رمزنگاری secretهای وب‌هوک. `openssl rand -base64 32`. **همهٔ instanceها باید یکسان داشته باشند.** در نبود آن، استارت‌آپ production با خطا متوقف می‌شود. |
| `NODE_ENV` | ✅ | `production` |
| `TRUST_PROXY` | توصیه‌شده | پشت nginx/traefik → `true` تا IP واقعی کلاینت برای rate-limit درست باشد. |
| `RATE_LIMIT_MAX` / `AUTH_FAIL_LIMIT` | اختیاری | پیش‌فرض ۳۰۰ درخواست/دقیقه و ۳۰ احراز هویت ناموفق/دقیقه به‌ازای هر IP. |
| `WEBHOOK_*` | اختیاری | timeout، backoff، concurrency کارگر ارسال وب‌هوک. |

## ۲. PostgreSQL مشترک با schema جدا (سناریوی هومانا)

### گام‌های یک‌بارهٔ ادمین دیتابیس

```sql
-- روی دیتابیس مشترک (مثلاً homana)
CREATE SCHEMA IF NOT EXISTS hbook;
CREATE ROLE hbook_app LOGIN PASSWORD '<رمز-قوی>' CONNECTION LIMIT 20;
GRANT USAGE, CREATE ON SCHEMA hbook TO hbook_app;
-- prisma migrate deploy داخل خودش CREATE SCHEMA IF NOT EXISTS صدا می‌زند:
GRANT CREATE ON DATABASE homana TO hbook_app;
ALTER ROLE hbook_app SET search_path = hbook;
-- پیش‌نیاز یک‌بارهٔ migration قدیمی (در نسخهٔ ۲ دیگر استفاده نمی‌شود اما replay می‌شود):
CREATE EXTENSION IF NOT EXISTS btree_gist;
```

> نکته: `CREATE EXTENSION` نیاز به دسترسی ادمین دارد؛ یک‌بار توسط DBA اجرا
> شود. اجرای مجدد آن بی‌ضرر است. (extensionهای هومانا دست‌نخورده می‌مانند.)

### اتصال موتور

```
DATABASE_URL=postgresql://hbook_app:<رمز>@db-host:5432/homana?schema=hbook&connection_limit=10&pool_timeout=10
```

- `?schema=hbook` باعث می‌شود همهٔ جدول‌ها و `_prisma_migrations` موتور داخل
  schema `hbook` ساخته شوند؛ migrationهای هومانا و داده‌های آن **دست‌نخورده**
  می‌مانند (تست خودکار: `npm run test:shared-schema`).
- نقش `hbook_app` به schema هومانا هیچ دسترسی‌ای ندارد (در تست بررسی شده).
- برای backup جداگانه: `pg_dump -n hbook homana > hbook-$(date +%F).sql` و
  بازیابی: `pg_restore`/`psql` با همان نقش. (dump فقط schema موتور را می‌گیرد.)

### Connection pool

- هر instance موتور: `connection_limit=10` (پیش‌فرض). فرمول امن:
  `(تعداد instance × connection_limit) ≤ ~۴۰٪ max_connections دیتابیس`
  تا هومانا هم سهم کافی داشته باشد.
- `pool_timeout=10` (ثانیه) تا در فشار، خطای شفاف بدهید نه هنگ.
- `CONNECTION LIMIT 20` روی نقش، سقف کلی نقش را مشخص می‌کند.

## ۳. اجرا

### توسعه (docker compose موجود)

```bash
cp .env.example .env    # مقادیر را پر کنید
docker compose up -d --build
docker compose exec api npx prisma migrate deploy   # در CMD خودکار هم اجرا می‌شود
docker compose exec api npx tsx prisma/seed.ts       # اختیاری: دیتای نمایشی
```

### عملیاتی (نمونهٔ امن)

```bash
docker build -t hbook:2.0.0 .
docker run -d --name hbook --restart unless-stopped \
  -p 127.0.0.1:3000:3000 \            # فقط از طریق reverse proxy در دسترس باشد
  -e NODE_ENV=production \
  -e DATABASE_URL='postgresql://hbook_app:***@db:5432/homana?schema=hbook&connection_limit=10' \
  -e HBOOK_SETUP_TOKEN="$(openssl rand -hex 32)" \
  -e HBOOK_WEBHOOK_ENC_KEY="$(openssl rand -base64 32)" \
  -e TRUST_PROXY=true \
  --memory 512m --cpus 1.0 \
  hbook:2.0.0
```

چند instance (scale) کاملاً پشتیبانی می‌شود: قفل‌ها و شمارندهٔ ظرفیت در
خود PostgreSQL هستند (advisory lock + `SELECT … FOR UPDATE`) و صف وب‌هوک
با `FOR UPDATE SKIP LOCKED` بین instanceها تقسیم می‌شود. تنها شرط:
`HBOOK_WEBHOOK_ENC_KEY` یکسان در همهٔ instanceها.

### reverse proxy

- فقط HTTPS به بیرون. `TRUST_PROXY=true` تا IP واقعی برای محدودیت نرخ درست
  باشد؛ در این حالت مطمئن شوید هدر `X-Forwarded-For` را proxy ست می‌کند و
  کلاینت نمی‌تواند آن را جعل کند (لایهٔ proxy هدر ورودی از بیرون را پاک کند).
- `/health` را برای probe داخلی باز نگه دارید؛ `/docs` را در صورت نیاز مسدود کنید.

## ۴. سلامت، منابع و پشتیبان‌گیری

- Health: `GET /health` → `200 {"status":"ok","db":"up"}` یا `503`.
- منابع پیشنهادی شروع: `0.5–1 vCPU` و `256–512MB` RAM به‌ازای هر instance.
- پشتیبان‌گیری روزانه: `pg_dump -Fc -n hbook homana > /backup/hbook-$(date +%F).dump`
- بازیابی آزمایشی ماهانه روی یک دیتابیس موقت + `prisma migrate deploy` (idempotent).
- لاگ‌ها: کلیدهای API، توکن setup و secretها هرگز لاگ نمی‌شوند (redact شده‌اند)؛
  دادهٔ تماس بیمار در لاگ نمی‌آید و payload وب‌هوک بدون PII است.

## ۵. چک‌لیست امنیتی قبل از production

- [ ] `HBOOK_SETUP_TOKEN` و `HBOOK_WEBHOOK_ENC_KEY` قوی و یکتا ست شده‌اند (نه نمونهٔ پیش‌فرض).
- [ ] `NODE_ENV=production` (پورت‌های تست و کلیدهای آزمایشی HTTP/لوکال را غیرفعال می‌کند).
- [ ] رمز دیتابیس پیش‌فرض (`change-me-strong` / `hbook`) عوض شده است.
- [ ] API موتور فقط از شبکهٔ داخلی/پشت proxy در دسترس است و کلیدها هرگز به فرانت‌اند نمی‌روند.
- [ ] `TRUST_PROXY` درست تنظیم شده و proxy هدرهای ورودی را پاک می‌کند.
- [ ] پشتیبان‌گیری خودکار + یک بازیابی آزمایشی موفق.
- [ ] وب‌هوک‌های هومانا با `https://` عمومی ثبت شده‌اند.
