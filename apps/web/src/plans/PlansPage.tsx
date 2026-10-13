import { Fragment, useState, type JSX } from 'react';
import { MoonIcon, SunIcon } from '../auth/LoginPage';

/**
 * Plans & comparison screen.
 *
 * Approved rules (owner, 2026-10-13):
 * - Hoomana is a management panel for doctors and treatment clinics: appointments,
 *   patient management, accounting, and appointment/reminder SMS to patient and doctor.
 * - Three plans: **آزمایشی** (the practice plan with a limited period), **مطب**
 *   (single doctor, yearly subscription) and **کلینیک** (several doctors, custom-module
 *   users, branches, dedicated support, yearly subscription).
 * - Both paid plans include a **custom domain** and an **exclusive SMS panel** with a
 *   gift credit (e.g. 300,000 Toman); the trial includes 100 gift messages.
 * - The trial length is set in the platform panel, so the UI deliberately does not
 *   advertise a number. SMS top-up exists in the panel but is not described here.
 */

type PlanId = 'free' | 'practice' | 'clinic';

interface PlanCard {
  readonly id: PlanId;
  readonly badge: string;
  readonly popular: boolean;
  readonly name: string;
  readonly lead: string;
  readonly price: string;
  readonly features: readonly { readonly text: string; readonly included: boolean }[];
  readonly cta: string;
}

const GIFT_PRACTICE = '۳۰۰٬۰۰۰ تومان شارژ هدیه';

const CARDS: readonly PlanCard[] = [
  {
    id: 'free',
    badge: 'شروع',
    popular: false,
    name: 'آزمایشی',
    lead: 'برای آشنایی کامل با هومانا: همان امکانات پکیج مطب، همراه ۱۰۰ پیامک هدیه.',
    price: 'برای آشنایی با هومانا',
    features: [
      { text: '۱ پزشک (حالت مطب)', included: true },
      { text: 'نوبت‌دهی، تقویم شمسی و رزرو آنلاین بیمار', included: true },
      { text: 'مدیریت بیماران بی‌نهایت + ایمپورت اکسل', included: true },
      { text: 'حسابداری و گزارش اکسل', included: true },
      { text: 'پنل پیامکی اختصاصی + ۱۰۰ پیامک هدیه', included: true },
      { text: 'دامنهٔ اختصاصی مطب', included: true },
    ],
    cta: 'شروع دورهٔ آزمایشی',
  },
  {
    id: 'practice',
    badge: 'محبوب',
    popular: true,
    name: 'مطب',
    lead: 'اشتراک یک‌سالهٔ پزشک تنها یا مطب کوچک — با همهٔ ابزارها و هدیهٔ پیامکی.',
    price: 'اشتراک یک‌ساله · قیمت‌گذاری: به‌زودی',
    features: [
      { text: '۱ پزشک، کارکنان بی‌نهایت', included: true },
      { text: 'همهٔ امکانات نوبت‌دهی، بیماران و حسابداری', included: true },
      { text: 'پیامک نوبت و یادآوری برای بیمار و پزشک', included: true },
      { text: `پنل پیامکی اختصاصی + ${GIFT_PRACTICE}`, included: true },
      { text: 'دامنهٔ اختصاصی مطب', included: true },
      { text: 'لیست روزانهٔ بیماران برای پزشک', included: true },
    ],
    cta: 'انتخاب پکیج مطب',
  },
  {
    id: 'clinic',
    badge: 'کامل',
    popular: false,
    name: 'کلینیک',
    lead: 'اشتراک یک‌سالهٔ کلینیک چندپزشکی: کاربران سفارشی، چند شعبه و پشتیبانی اختصاصی.',
    price: 'اشتراک یک‌ساله · قیمت‌گذاری: به‌زودی',
    features: [
      { text: 'پزشکان و کارکنان بی‌نهایت', included: true },
      { text: 'انتخاب پزشک در نوبت‌دهی و حضور روزانه', included: true },
      { text: 'کاربران با دسترسی سفارشی (ماژولی)', included: true },
      { text: `پنل پیامکی اختصاصی + ${GIFT_PRACTICE}`, included: true },
      { text: 'دامنهٔ اختصاصی کلینیک', included: true },
      { text: 'چند شعبه و پشتیبانی اختصاصی', included: true },
    ],
    cta: 'انتخاب پکیج کلینیک',
  },
];

const SECTIONS: readonly {
  readonly title: string;
  readonly rows: readonly {
    readonly label: string;
    readonly free: string;
    readonly practice: string;
    readonly clinic: string;
  }[];
}[] = [
  {
    title: 'پایه و کاربران',
    rows: [
      { label: 'تعداد پزشکان', free: '۱', practice: '۱', clinic: 'نامحدود' },
      {
        label: 'کاربران کارکنان (منشی/پذیرش)',
        free: 'نامحدود',
        practice: 'نامحدود',
        clinic: 'نامحدود',
      },
      { label: 'دسترسی سفارشی به ماژول‌ها (کاربر کاستوم)', free: '—', practice: '—', clinic: '✓' },
      { label: 'تعداد شعبه', free: '۱', practice: '۱', clinic: 'نامحدود' },
      { label: 'محدودیت تعداد بیمار یا پیامک', free: 'ندارد', practice: 'ندارد', clinic: 'ندارد' },
    ],
  },
  {
    title: 'نوبت‌دهی',
    rows: [
      { label: 'تقویم نوبت‌ها (روز/هفته/ماه، شمسی)', free: '✓', practice: '✓', clinic: '✓' },
      { label: 'ثبت نوبت توسط منشی', free: '✓', practice: '✓', clinic: '✓' },
      { label: 'رزرو آنلاین بیمار با کد پیامکی (OTP)', free: '✓', practice: '✓', clinic: '✓' },
      {
        label: 'انتخاب پزشک در نوبت‌دهی',
        free: '— (تک‌پزشک)',
        practice: '— (تک‌پزشک)',
        clinic: '✓',
      },
      { label: 'قوانین زمان‌بندی (بافر، سقف روزانه، استثناها)', free: '✓', practice: '✓', clinic: '✓' },
      { label: 'یادآوری پیامکی نوبت', free: '✓', practice: '✓', clinic: '✓' },
      { label: 'لیست بیماران هر پزشک (پیامکی، زمان‌بندی‌شده + لحظه‌ای)', free: '✓', practice: '✓', clinic: '✓' },
    ],
  },
  {
    title: 'بیماران',
    rows: [
      {
        label: 'پروندهٔ بیمار (نام، موبایل، کد ملی، شمارهٔ پرونده، تاریخ تولد)',
        free: '✓',
        practice: '✓',
        clinic: '✓',
      },
      { label: 'ایمپورت گروهی از اکسل', free: '✓', practice: '✓', clinic: '✓' },
      { label: 'ماژول پروندهٔ درمانی و گزارش‌ها (فاز بعد)', free: '✓', practice: '✓', clinic: '✓' },
    ],
  },
  {
    title: 'مالی',
    rows: [
      { label: 'حسابداری (تراکنش، دسته‌ها، روش پرداخت)', free: '✓', practice: '✓', clinic: '✓' },
      { label: 'گزارش روز/ماه و خروجی اکسل', free: '✓', practice: '✓', clinic: '✓' },
    ],
  },
  {
    title: 'پیامک',
    rows: [
      { label: 'پیامک نوبت و یادآوری برای بیمار و پزشک', free: '✓', practice: '✓', clinic: '✓' },
      {
        label: 'پنل پیامکی اختصاصی مستاجر (خط و اعتبار خودش)',
        free: '✓',
        practice: '✓',
        clinic: '✓',
      },
      {
        label: 'هدیهٔ اعتبار پیامک',
        free: '۱۰۰ پیامک',
        practice: GIFT_PRACTICE,
        clinic: GIFT_PRACTICE,
      },
      { label: 'کد پیامکی ورود/بازیابی', free: '✓', practice: '✓', clinic: '✓' },
    ],
  },
  {
    title: 'برند، دامنه و پشتیبانی',
    rows: [
      { label: 'ساب‌دامین هومانا', free: '✓', practice: '✓', clinic: '✓' },
      { label: 'دامنهٔ اختصاصی', free: '✓', practice: '✓', clinic: '✓' },
      { label: 'پشتیبانی', free: 'پایه', practice: 'استاندارد', clinic: 'اختصاصی' },
      { label: 'مدت اعتبار', free: 'دورهٔ آزمایشی', practice: '۱ ساله', clinic: '۱ ساله' },
    ],
  },
];

function Cell({ value }: { readonly value: string }): JSX.Element {
  if (value === '✓') return <span className="cell-yes">✓</span>;
  if (value === '—' || value.startsWith('—')) return <span className="cell-no">{value}</span>;
  return <span>{value}</span>;
}

export interface PlansPageProps {
  /** Starts the trial: sends the visitor to the signup screen. */
  readonly onStartFree: () => void;
  /** Back to the login screen (optional). */
  readonly onBackToLogin?: (() => void) | undefined;
}

export function PlansPage({ onStartFree, onBackToLogin }: PlansPageProps): JSX.Element {
  const [notice, setNotice] = useState<string | null>(null);
  const [theme, setTheme] = useState(() => document.documentElement.dataset['theme'] ?? 'light');

  function toggleTheme(): void {
    const next = theme === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset['theme'] = next;
    setTheme(next);
  }

  function choosePlan(id: PlanId): void {
    if (id === 'free') {
      onStartFree();
      return;
    }

    setNotice('خرید پکیج به‌زودی فعال می‌شود؛ فعلاً دورهٔ آزمایشی را شروع کنید.');
  }

  return (
    <div className="plans-shell">
      <div className="glow glow-teal" />
      <div className="glow glow-amber" />

      <button
        type="button"
        className="theme-btn theme-float neu-sm press"
        onClick={toggleTheme}
        aria-label="تعویض تم"
      >
        {theme === 'dark' ? <SunIcon /> : <MoonIcon />}
      </button>

      <main className="plans-wrap">
        <header className="plans-head">
          <p className="brand-fa">پکیج‌های هومانا</p>
          <p className="brand-sub">
            هومانا پنل مدیریت پزشکان و کلینیک‌های درمانی است: نوبت‌دهی، مدیریت بیماران، حسابداری و
            ارسال پیامک نوبت و یادآوری برای بیمار و پزشک.
          </p>
          <p className="brand-sub">
            پکیج مناسب خودتان را انتخاب کنید؛ هر دو پکیج مطب و کلینیک یک‌ساله‌اند و همراه دامنهٔ
            اختصاصی و پنل پیامکی اختصاصی با شارژ هدیه ارائه می‌شوند.
          </p>
        </header>

        {notice !== null && (
          <p className="notice" role="status">
            {notice}
          </p>
        )}

        <section className="plans-cards">
          {CARDS.map((plan) => (
            <article key={plan.id} className={plan.popular ? 'plan neu plan-popular' : 'plan neu'}>
              <span className={plan.popular ? 'plan-badge plan-badge-ok' : 'plan-badge'}>
                {plan.badge}
              </span>
              <h2>{plan.name}</h2>
              <p className="plan-lead">{plan.lead}</p>
              <p className="plan-price">{plan.price}</p>

              <ul className="plan-features">
                {plan.features.map((feature) => (
                  <li key={feature.text}>
                    <span className={feature.included ? 'tick' : 'tick tick-off'}>
                      {feature.included ? '✓' : '—'}
                    </span>
                    {feature.text}
                  </li>
                ))}
              </ul>

              <button
                type="button"
                className={plan.id === 'free' ? 'plan-btn cta' : 'plan-btn neu-sm press'}
                onClick={() => {
                  choosePlan(plan.id);
                }}
              >
                {plan.cta}
              </button>
            </article>
          ))}
        </section>

        <h3 className="plans-section-title">مقایسهٔ کامل امکانات</h3>

        <div className="plans-table-card neu">
          <table className="plans-table">
            <thead>
              <tr>
                <th>امکانات</th>
                <th>آزمایشی</th>
                <th>مطب</th>
                <th>کلینیک</th>
              </tr>
            </thead>
            <tbody>
              {SECTIONS.map((section) => (
                <Fragment key={section.title}>
                  <tr className="plans-group">
                    <td colSpan={4}>{section.title}</td>
                  </tr>
                  {section.rows.map((row) => (
                    <tr key={row.label}>
                      <td>{row.label}</td>
                      <td>
                        <Cell value={row.free} />
                      </td>
                      <td>
                        <Cell value={row.practice} />
                      </td>
                      <td>
                        <Cell value={row.clinic} />
                      </td>
                    </tr>
                  ))}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>

        <p className="plans-note">
          «آزمایشی» همان پکیج مطب است؛ تفاوتش دورهٔ محدود و میزان هدیهٔ پیامکی است. طول دورهٔ
          آزمایشی از پنل مدیریت تعیین می‌شود. مطب و کلینیک اشتراک یک‌ساله‌اند و در هر دو، دامنهٔ
          اختصاصی و پنل پیامکی اختصاصی همراه شارژ هدیه ارائه می‌شود. قیمت‌گذاری پکیج‌ها پس از تأیید
          مالک ثبت می‌شود.
        </p>

        <div className="plans-back">
          <button type="button" className="link-btn" onClick={onBackToLogin}>
            بازگشت به صفحهٔ ورود
          </button>
        </div>
      </main>
    </div>
  );
}
