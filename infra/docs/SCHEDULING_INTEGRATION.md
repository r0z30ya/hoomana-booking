# اتصال نوبت‌دهی هومانا به hnobat

## امکانات این مرحله

- مدیر کلینیک می‌تواند پزشک اضافه کند، روزها و ساعت کاری هفتگی پزشک را تعیین کند و خدمت با مدت، گام نوبت و ظرفیت هم‌زمان بسازد یا ویرایش کند.
- مدیر و منشی می‌توانند زمان آزاد بگیرند و با نام و موبایل بیمار نوبت بسازند یا لغو کنند. در این مرحله حساب پزشک واردشده به پنل به پزشک موتور نگاشت نشده و نقش DOCTOR به API نوبت دسترسی ندارد.
- کلید اختصاصی موتور برای هر پزشک فقط در پایگاه داده هومانا، با AES-256-GCM و اطلاعات زمینه شامل کلینیک و شناسه پزشک، ذخیره می‌شود. مرورگر کلید را دریافت نمی‌کند. جدول نگاشت از RLS کلینیک استفاده می‌کند.
- حساب داخلی موتور با نشانی دامنه رزروش‌شده `engine.invalid` فقط برای شناسایی میزبان ساخته می‌شود و کانال ارتباطی نیست. بیمار به ایمیل نیاز ندارد و موبایل واقعی او در رکورد شرکت‌کننده موتور ثبت می‌شود.
- درخواست‌های تغییردهنده از پنل باید Origin برابر میزبان درخواست داشته باشند. نقش، نشست، کلینیک و تعلق پزشک در سرور کنترل می‌شود.

## راه‌اندازی و تغییر ساختار

این مرحله بدون دیتابیس PostgreSQL در حال اجرا و بدون پیکربندی، در پنل عملیاتی نخواهد شد. پیش از انتقال داده نسخه پشتیبان بگیرید و مهاجرت را ابتدا روی کپی آزمایشی بررسی کنید.

1. موتور hnobat را در شبکه خصوصی و برای توسعه روی loopback اجرا کنید. ثبت‌نام موتور هنوز عمومی است؛ آن را مستقیماً در اینترنت در دسترس قرار ندهید.
2. اگر دیتابیس SQLite موتور از قبل وجود دارد، با توقف سرویس و پس از پشتیبان و بررسی ساختار، فایل `hnobat/prisma/manual/20261107_attendee_phone.sql` ستون ایمیل بیمار را nullable می‌کند. این فایل یک تغییر دستی است و در تاریخچه Prisma ثبت خودکار ندارد؛ با `PRAGMA foreign_key_check` و شمارش رکوردها صحت آن را بررسی کنید. آن را روی دیتابیس موجود کاربر در این مرحله اجرا نکرده‌ایم. برای دیتابیس جدید آزمایشی می‌توان schema فعلی را روی فایل خالی اعمال کرد.
3. مهاجرت PostgreSQL موجود در `packages/db/prisma/migrations/20261107150000_scheduling_doctors` باید با کاربر migrator و روند استقرار پروژه اعمال شود؛ برنامه با نقش محدود `hmn_app` اجرا می‌شود. این مهاجرت در محیط فعلی اعمال یا روی PostgreSQL واقعی تأیید نشده است.
4. در تنظیمات سرور هومانا `HNOBAT_URL` را به آدرس داخلی API موتور، مانند `http://127.0.0.1:33971/api/v2`، و `HNOBAT_ENCRYPTION_KEY` را به کلید تصادفی مستقل ۳۲ بایتی با قالب base64 تنظیم کنید. نسخه کلید در `HNOBAT_ENCRYPTION_KEY_VERSION` ثبت می‌شود؛ کلید باید در محل امن و پایدار نگهداری شود. آدرس HTTP فقط برای loopback پذیرفته می‌شود؛ سایر مقصدها باید HTTPS باشند.
5. API، موتور و پنل را اجرا کنید. مسیر `/tenant` در پروکسی توسعه وب اضافه شده است. برای سرویس‌دهی واقعی، پراکسی محیط استقرار نیز باید این مسیر را به API هومانا هدایت کند.

## آزمون‌ها

آزمون امنیتی Fastify با مخزن و نشست شبیه‌سازی‌شده، نبود نشست، جداسازی کلینیک، جلوگیری از تغییر توسط منشی، کنترل Origin، عدم افشای کلید و ممنوعیت مقصد HTTP غیرمحلی و مسیر نامعتبر را بررسی می‌کند. آزمون یکپارچگی اختیاری با موتور واقعی SQLite و مخزن هومانا شبیه‌سازی‌شده، ساخت پزشک تا لغو نوبت با موبایل را اجرا می‌کند؛ این آزمون تنها با `HNOBAT_ISOLATED_INTEGRATION=yes` فعال است و روی موتور آزمایشی ثابت پورت ۳۳۹۷۱ داده می‌نویسد. هرگز آن را به دیتابیس واقعی وصل نکنید. آزمون مؤلفه پنل ارسال گام و ظرفیت را بررسی می‌کند.

فایل مهاجرت SQLite روی یک دیتابیس آزمایشی دارای ۸ شرکت‌کننده اعمال شد؛ تعداد ردیف‌ها حفظ و بررسی foreign key موفق بود. Docker و PostgreSQL در محیط فعلی در دسترس نبودند، بنابراین مهاجرت و RLS واقعی PostgreSQL، اجرای کامل مرورگر تا دیتابیس و کارایی زیر بار تأیید نشده‌اند.

## محدودیت‌های باقی‌مانده

- حذف یا غیرفعال‌سازی پزشک و خدمت، نگاشت حساب پزشک هومانا، ویرایش برنامه چند بازه‌ای/تعطیلات، تقویم شمسی کامل، پرونده بیمار و جابه‌جایی نوبت هنوز در پنل پیاده نشده‌اند. فرم ساعت کاری تمام برنامه پیش‌فرض را با یک بازه هفتگی جایگزین می‌کند.
- در ایجاد پزشک، قطع ارتباط پس از ساخت حساب موتور و پیش از ذخیره نگاشت می‌تواند یک حساب بدون نگاشت باقی بگذارد. بازآشتی و پاک‌سازی امن و idempotency بین دو سرویس هنوز پیاده‌سازی نشده‌اند.
- مجوزهای نقش سفارشی، محدودسازی نرخ، آزمون نفوذ مستقل، آزمون هم‌زمانی چندپردازشی و سناریوهای بازیابی کلید لازم‌اند. این آزمون‌ها تضمین امنیت کامل نیستند.
- موتور همچنان SQLite است و مهاجرت به PostgreSQL، تحویل پایدار وب‌هوک و تعطیلات تقویمی باقی مانده‌اند. تا تکمیل آزمون PostgreSQL و کنترل‌های استقرار، آماده‌بودن برای داده واقعی تأیید نمی‌شود.

## Local trial and runtime configuration

New signups choose SOLO (one doctor) or CLINIC (no doctor-count cap). Both use a trial whose default is 14 days; a platform administrator with MFA can change the duration for future registrations in the platform panel. Scheduling checks the subscription period and rejects expired trials. Existing tenants keep their previous subscription dates and default to CLINIC to preserve access. The old tenant self-service endpoint cannot renew trials; paid activation is not implemented by this change.

The development engine runs only on 127.0.0.1:33972 with `DATABASE_URL=file:../db/hoomana-local.db`; its database is separate from the pre-existing `custom.db`. The API uses `HNOBAT_URL` and the persistent random `HNOBAT_ENCRYPTION_KEY` from the root `.env`; keep the key and engine database backed up together. The local PostgreSQL backup is in `.local-backups/`, excluded from git. These services are intended for local development, not production deployment.

Run the database-backed suite against a separately provisioned test database. Some tests modify shared catalogue entries, so use `vitest run --no-file-parallelism`. The opt-in engine test creates test data and must use a separate engine database.
