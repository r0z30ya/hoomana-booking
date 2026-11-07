"use client";

import { useEffect, useState } from "react";

type Health = { service: string; engine: string; version: string; time: string; uptimeSeconds: number };

const ENDPOINTS: { group: string; rows: { m: string; p: string; auth: string; d: string }[] }[] = [
  {
    group: "Auth",
    rows: [
      { m: "POST", p: "/api/v2/auth/signup", auth: "عمومی", d: "ثبت‌نام (username, email, password) → JWT" },
      { m: "POST", p: "/api/v2/auth/login", auth: "عمومی", d: "ورود با ایمیل/رمز → JWT (۳۰ روز)" },
      { m: "GET", p: "/api/v2/me", auth: "JWT / API Key", d: "پروفایل کاربر جاری" },
      { m: "PATCH", p: "/api/v2/me", auth: "JWT / API Key", d: "ویرایش پروایل (نام، username، timezone و…)" },
    ],
  },
  {
    group: "Event Types — انواع نوبت",
    rows: [
      { m: "GET", p: "/api/v2/event-types", auth: "JWT / API Key", d: "لیست انواع نوبت خودم" },
      { m: "GET", p: "/api/v2/event-types?username=", auth: "عمومی", d: "انواع نوبت عمومی یک کاربر (صفحهٔ رزرو)" },
      { m: "POST", p: "/api/v2/event-types", auth: "JWT / API Key", d: "ایجاد نوع نوبت (مدت، بافر، حداقل فاصله، period و…)" },
      { m: "GET/PATCH/DELETE", p: "/api/v2/event-types/{id}", auth: "JWT / API Key", d: "جزئیات / ویرایش / حذف" },
    ],
  },
  {
    group: "Schedules — ساعات کاری",
    rows: [
      { m: "GET", p: "/api/v2/schedules", auth: "JWT / API Key", d: "لیست برنامه‌های هفتگی + availability" },
      { m: "POST", p: "/api/v2/schedules", auth: "JWT / API Key", d: "ایجاد برنامه (timezone + ردیف‌های روز/ساعت)" },
      { m: "PATCH", p: "/api/v2/schedules/{id}", auth: "JWT / API Key", d: "ویرایش + date override (تعطیلی/ساعت خاص یک روز)" },
      { m: "DELETE", p: "/api/v2/schedules/{id}", auth: "JWT / API Key", d: "حذف (با ارتقای برنامهٔ پیش‌فرض)" },
    ],
  },
  {
    group: "Slots — اسلات‌های آزاد",
    rows: [
      { m: "GET", p: "/api/v2/slots", auth: "عمومی", d: "?eventTypeId= یا ?username=&eventTypeSlug= + startTime/endTime/timeZone" },
    ],
  },
  {
    group: "Bookings — نوبت‌ها",
    rows: [
      { m: "POST", p: "/api/v2/bookings", auth: "عمومی", d: "رزرو نوبت (اعتبارسنجی کامل موتور: اسلات دقیق، notice، ظرفیت)" },
      { m: "GET", p: "/api/v2/bookings", auth: "JWT / API Key", d: "لیست نوبت‌های میزبان ?status=upcoming|past|cancelled|unconfirmed" },
      { m: "GET", p: "/api/v2/bookings/{uid}", auth: "عمومی", d: "جزئیات نوبت با uid" },
      { m: "POST", p: "/api/v2/bookings/{uid}/cancel", auth: "میزبان یا حاضر", d: "لغو (حاضر با email)" },
      { m: "POST", p: "/api/v2/bookings/{uid}/reschedule", auth: "میزبان یا حاضر", d: "جابه‌جایی به زمان جدید + وب‌هوک" },
      { m: "POST", p: "/api/v2/bookings/{uid}/confirm", auth: "میزبان", d: "تأیید نوبت PENDING" },
      { m: "POST", p: "/api/v2/bookings/{uid}/decline", auth: "میزبان", d: "رد نوبت PENDING (+reason)" },
    ],
  },
  {
    group: "Webhooks",
    rows: [
      { m: "GET/POST", p: "/api/v2/webhooks", auth: "JWT / API Key", d: "ثبت subscriber + امضای HMAC (x-hnobat-signature-256)" },
      { m: "PATCH/DELETE", p: "/api/v2/webhooks/{id}", auth: "JWT / API Key", d: "ویرایش / حذف" },
    ],
  },
  {
    group: "API Keys",
    rows: [
      { m: "GET/POST", p: "/api/v2/api-keys", auth: "JWT", d: "کلید hnb_... فقط یک‌بار نمایش داده می‌شود (ذخیرهٔ هش SHA-256)" },
      { m: "DELETE", p: "/api/v2/api-keys/{id}", auth: "JWT", d: "ابطال کلید" },
    ],
  },
];

const QUICKSTART = `# 1) ورود و گرفتن توکن
TOKEN=$(curl -s -X POST <BASE>/api/v2/auth/login \\
  -H 'content-type: application/json' \\
  -d '{"email":"demo@hnobat.io","password":"hnobat1234"}' \\
  | jq -r .data.accessToken)

# 2) اسلات‌های آزاد (موتور نوبت‌دهی)
curl -s "<BASE>/api/v2/slots?username=demo&eventTypeSlug=consultation-30\\
&startTime=2026-11-05T00:00:00Z&endTime=2026-11-08T00:00:00Z&timeZone=Asia/Tehran"

# 3) رزرو یک اسلات (عمومی — مثل صفحهٔ رزرو cal.com)
curl -s -X POST <BASE>/api/v2/bookings \\
  -H 'content-type: application/json' \\
  -d '{"start":"<SLOT_UTC>","eventTypeId":1,
       "attendee":{"name":"Ali","email":"ali@example.com","timeZone":"Asia/Tehran"}}'

# 4) لیست نوبت‌ها (میزبان)
curl -s "<BASE>/api/v2/bookings?status=upcoming" -H "Authorization: Bearer $TOKEN"`;

function CopyBtn({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      onClick={() => {
        navigator.clipboard?.writeText(text);
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }}
      className="absolute top-2 left-2 rounded border border-zinc-700 bg-zinc-800 px-2 py-1 text-[11px] text-zinc-300 hover:bg-zinc-700 transition-colors"
    >
      {copied ? "کپی شد ✓" : "کپی"}
    </button>
  );
}

const METHOD_COLOR: Record<string, string> = {
  GET: "bg-emerald-900/60 text-emerald-300 border-emerald-700/50",
  POST: "bg-amber-900/50 text-amber-300 border-amber-700/50",
  PATCH: "bg-violet-900/50 text-violet-300 border-violet-700/50",
  DELETE: "bg-rose-900/50 text-rose-300 border-rose-700/50",
};

export default function Home() {
  const [health, setHealth] = useState<Health | null>(null);
  const [alive, setAlive] = useState<boolean | null>(null);

  useEffect(() => {
    fetch("/api/v2/health")
      .then((r) => r.json())
      .then((j) => {
        setHealth(j.data);
        setAlive(true);
      })
      .catch(() => setAlive(false));
  }, []);

  return (
    <div dir="rtl" className="min-h-screen bg-zinc-950 text-zinc-200 font-mono">
      <div className="mx-auto max-w-4xl px-5 py-10">
        {/* header */}
        <header className="mb-10 flex flex-wrap items-center justify-between gap-4">
          <div>
            <h1 className="text-3xl font-bold tracking-tight text-white">
              hno<span className="text-emerald-400">bat</span>
            </h1>
            <p className="mt-1 text-sm text-zinc-400">
              موتور نوبت‌دهی — API نسخهٔ v۲ (معماری cal.com) | فاز ۱: فقط API
            </p>
          </div>
          <div
            className={`flex items-center gap-2 rounded-full border px-4 py-2 text-xs ${
              alive === null
                ? "border-zinc-700 text-zinc-400"
                : alive
                  ? "border-emerald-700/60 bg-emerald-900/30 text-emerald-300"
                  : "border-rose-700/60 bg-rose-900/30 text-rose-300"
            }`}
          >
            <span className={`inline-block h-2 w-2 rounded-full ${alive ? "bg-emerald-400" : "bg-rose-400"}`} />
            {alive ? `موتور فعال · API ${health?.version ?? "v2"} · uptime ${health?.uptimeSeconds ?? 0}s` : "موتور پاسخ نمی‌دهد"}
          </div>
        </header>

        {/* demo credentials */}
        <section className="mb-8 rounded-lg border border-zinc-800 bg-zinc-900/60 p-5">
          <h2 className="mb-3 text-sm font-bold text-white">دادهٔ دمو (Seed)</h2>
          <ul className="space-y-1.5 text-[13px] text-zinc-300">
            <li>
              میزبان: <code className="rounded bg-zinc-800 px-1.5 py-0.5 text-emerald-300">demo@hnobat.io</code> / رمز:{" "}
              <code className="rounded bg-zinc-800 px-1.5 py-0.5 text-emerald-300">hnobat1234</code>
            </li>
            <li>
              لینک رزرو عمومی: <code className="rounded bg-zinc-800 px-1.5 py-0.5">/api/v2/slots?username=demo&amp;eventTypeSlug=consultation-30</code>
            </li>
            <li>
              انواع نوبت: <b>consultation-30</b> (۳۰ دقیقه‌ای) و <b>team-meeting-60</b> (۶۰ دقیقه‌ای، نیازمند تأیید)
            </li>
            <li>ساعات کاری: شنبه تا چهارشنبه ۰۹:۰۰–۱۷:۰۰ و پنجشنبه ۰۹:۰۰–۱۳:۰۰ (Asia/Tehran)</li>
          </ul>
        </section>

        {/* quickstart */}
        <section className="mb-8">
          <h2 className="mb-3 text-sm font-bold text-white">شروع سریع (curl)</h2>
          <pre dir="ltr" className="relative overflow-x-auto rounded-lg border border-zinc-800 bg-black/60 p-4 text-left text-[12px] leading-6 text-emerald-200/90">
            <CopyBtn text={QUICKSTART.replaceAll("<BASE>", typeof window !== "undefined" ? window.location.origin : "")} />
            {QUICKSTART}
          </pre>
        </section>

        {/* endpoints */}
        <section className="space-y-6">
          <h2 className="text-sm font-bold text-white">Endpoint ها</h2>
          {ENDPOINTS.map((g) => (
            <div key={g.group} className="overflow-hidden rounded-lg border border-zinc-800">
              <div className="border-b border-zinc-800 bg-zinc-900/80 px-4 py-2 text-xs font-bold text-zinc-300">{g.group}</div>
              <table className="w-full text-[12.5px]">
                <tbody>
                  {g.rows.map((r) => (
                    <tr key={r.p + r.m} className="border-b border-zinc-800/60 last:border-0 hover:bg-zinc-900/40">
                      <td className="w-36 px-3 py-2 align-top">
                        <span className={`inline-block rounded border px-1.5 py-0.5 text-[10.5px] font-bold ${METHOD_COLOR[r.m.split("/")[0]] ?? "border-zinc-700 bg-zinc-800 text-zinc-300"}`}>
                          {r.m}
                        </span>
                      </td>
                      <td dir="ltr" className="px-3 py-2 text-left align-top text-emerald-300/90">
                        {r.p}
                      </td>
                      <td className="w-32 px-3 py-2 align-top text-zinc-500">{r.auth}</td>
                      <td className="px-3 py-2 align-top text-zinc-400">{r.d}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ))}
        </section>

        {/* webhooks */}
        <section className="mt-8 rounded-lg border border-zinc-800 bg-zinc-900/60 p-5">
          <h2 className="mb-3 text-sm font-bold text-white">تریگرهای وب‌هوک (هم‌نام cal.com)</h2>
          <div className="flex flex-wrap gap-2 text-[11.5px]">
            {["BOOKING_CREATED", "BOOKING_REQUESTED", "BOOKING_CONFIRMED", "BOOKING_RESCHEDULED", "BOOKING_CANCELLED", "BOOKING_REJECTED", "BOOKING_PAID", "MEETING_ENDED"].map((t) => (
              <span key={t} dir="ltr" className="rounded border border-zinc-700 bg-zinc-800/80 px-2 py-1 text-zinc-300">
                {t}
              </span>
            ))}
          </div>
          <p className="mt-3 text-[12px] text-zinc-500">
            امضا: <code dir="ltr" className="text-zinc-400">x-hnobat-signature-256 = HMAC-SHA256(body, secret)</code> — همان الگوی x-cal-signature-256
          </p>
        </section>

        {/* stack */}
        <footer className="mt-10 border-t border-zinc-800 pt-5 text-[11.5px] leading-6 text-zinc-500">
          <p>
            استک (هم‌سو با cal.com): <b className="text-zinc-400">Next.js ۱۶ + TypeScript + Prisma + Zod + date-fns(-tz)</b> — پایگاه داده: SQLite (قابل تعویض با PostgreSQL با تغییر provider)
          </p>
          <p className="mt-1">
            فاز بعدی: Teams و Event Type تیمی، Round-Robin، تقویم‌های خارجی (Google/Outlook)، OAuth، payment.
          </p>
        </footer>
      </div>
    </div>
  );
}
