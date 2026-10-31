import { useState, type FormEvent, type JSX } from 'react';
import {
  BrandMark,
  MobileIcon,
  MoonIcon,
  SmsIcon,
  SunIcon,
  type SessionProfile,
} from './LoginPage';

/**
 * Self-service signup, two steps (owner decision 2026-10-13):
 *   1. the mobile number — the account is verified by an SMS one-time code;
 *   2. the code plus the clinic details, including the **address**.
 *
 * The account is created by the second call (`POST /auth/register` with the code), so
 * nothing is stored until the clinic information is complete.
 *
 * No passphrase at signup: the account starts code-based (the API keeps passphrase
 * signup for other clients). Setting a passphrase later is a separate slice.
 *
 * Naming note: the wire field name for the SMS code is `code`.
 */

/** The API's request field name for the one-time code. */
const OTP_FIELD = 'code';

export interface RegisterPageProps {
  readonly onAuthenticated: (profile: SessionProfile) => void;
  /** Returns to the login screen (optional). */
  readonly onBackToLogin?: (() => void) | undefined;
}

type SubmitState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'sending' }
  | { readonly kind: 'error'; readonly message: string };

type Step = 'mobile' | 'details';

/** Mirrors the API's rule: `09` followed by nine digits. */
export function normaliseMobile(raw: string): string | undefined {
  const trimmed = raw.replace(/[\s()-]/g, '');
  const normalised = trimmed.startsWith('+98') ? `0${trimmed.slice(3)}` : trimmed;

  return /^09\d{9}$/.test(normalised) ? normalised : undefined;
}

function IdCardIcon(): JSX.Element {
  return (
    <svg
      className="t-sub"
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      aria-hidden="true"
    >
      <rect x="2" y="4" width="20" height="16" rx="3" />
      <circle cx="9" cy="11" r="2.5" />
      <path d="M5 17c1.2-1.8 2.6-2.6 4-2.6s2.8.8 4 2.6M15 10h4M15 14h3" />
    </svg>
  );
}

function ClinicIcon(): JSX.Element {
  return (
    <svg
      className="t-sub"
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      aria-hidden="true"
    >
      <path d="M3 21h18M5 21V7l7-4 7 4v14" />
      <path d="M12 9v6M9 12h6" />
    </svg>
  );
}

function PinIcon(): JSX.Element {
  return (
    <svg
      className="t-sub"
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      aria-hidden="true"
    >
      <path d="M12 21s7-5.6 7-11a7 7 0 1 0-14 0c0 5.4 7 11 7 11z" />
      <circle cx="12" cy="10" r="2.5" />
    </svg>
  );
}

function CityIcon(): JSX.Element {
  return (
    <svg
      className="t-sub"
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      aria-hidden="true"
    >
      <path d="M4 21V6l6-3v18M10 21h10V10l-10-4" />
      <path d="M7 9v1M7 13v1M7 17v1M14 12v1M14 16v1" />
    </svg>
  );
}

export function RegisterPage({ onAuthenticated, onBackToLogin }: RegisterPageProps): JSX.Element {
  const [step, setStep] = useState<Step>('mobile');
  const [mobile, setMobile] = useState('');
  const [otpCode, setOtpCode] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [tenantName, setTenantName] = useState('');
  const [address, setAddress] = useState('');
  const [city, setCity] = useState('');
  const [devCode, setDevCode] = useState<string | null>(null);
  const [state, setState] = useState<SubmitState>({ kind: 'idle' });
  const [shaking, setShaking] = useState(false);
  const [theme, setTheme] = useState(() => document.documentElement.dataset['theme'] ?? 'light');

  function toggleTheme(): void {
    const next = theme === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset['theme'] = next;
    setTheme(next);
  }

  function shakeOnce(): void {
    setShaking(true);
    window.setTimeout(() => {
      setShaking(false);
    }, 450);
  }

  function fail(message: string): void {
    setState({ kind: 'error', message });
    shakeOnce();
  }

  async function requestCode(): Promise<void> {
    const normalised = normaliseMobile(mobile);

    if (normalised === undefined) {
      fail('شمارهٔ موبایل باید با ۰۹ شروع شود و ۱۱ رقم باشد.');
      return;
    }

    setState({ kind: 'sending' });

    try {
      const response = await fetch('/auth/otp/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ mobile: normalised, purpose: 'SIGNUP' }),
      });

      if (response.status === 429) {
        fail('کد قبلی هنوز معتبر است یا تلاش‌ها زیاد بوده؛ چند لحظه بعد دوباره امتحان کنید.');
        return;
      }

      if (!response.ok) {
        fail('ارسال کد ممکن نشد؛ دوباره امتحان کنید.');
        return;
      }

      const payload = (await response.json()) as { devCode?: string };
      setDevCode(payload.devCode ?? null);
      setState({ kind: 'idle' });
      setStep('details');
    } catch {
      fail('ارتباط با سرور برقرار نشد. اتصال را بررسی کنید.');
    }
  }

  async function createAccount(): Promise<void> {
    const normalised = normaliseMobile(mobile);

    if (normalised === undefined) {
      fail('شمارهٔ موبایل باید با ۰۹ شروع شود و ۱۱ رقم باشد.');
      return;
    }

    if (!/^\d{5}$/.test(otpCode)) {
      fail('کد تأیید پنج‌رقمی پیامک‌شده را وارد کنید.');
      return;
    }

    if (displayName.trim() === '' || tenantName.trim() === '' || address.trim() === '') {
      fail('نام، نام مطب/کلینیک و آدرس را کامل کنید.');
      return;
    }

    setState({ kind: 'sending' });

    try {
      const response = await fetch('/auth/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({
          mobile: normalised,
          [OTP_FIELD]: otpCode,
          displayName: displayName.trim(),
          tenantName: tenantName.trim(),
          address: address.trim(),
          ...(city.trim() === '' ? {} : { city: city.trim() }),
        }),
      });

      if (response.status === 401) {
        fail('کد تأیید نامعتبر یا منقضی شده است؛ دوباره کد بگیرید.');
        return;
      }

      if (response.status === 409) {
        fail('این شمارهٔ موبایل قبلاً ثبت شده است؛ وارد شوید.');
        return;
      }

      if (response.status === 429) {
        fail('تلاش‌های ناموفق زیاد بوده است؛ چند دقیقه بعد دوباره امتحان کنید.');
        return;
      }

      if (!response.ok) {
        fail('ثبت‌نام انجام نشد؛ اطلاعات را بررسی کنید.');
        return;
      }

      const profile = (await response.json()) as SessionProfile;
      setState({ kind: 'idle' });
      onAuthenticated(profile);
    } catch {
      fail('ارتباط با سرور برقرار نشد. اتصال را بررسی کنید.');
    }
  }

  function submit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();

    if (step === 'mobile') {
      void requestCode();
      return;
    }

    void createAccount();
  }

  return (
    <div className="auth-shell">
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

      <main className="auth-wrap">
        <form
          className={shaking ? 'auth-card neu-sm shake' : 'auth-card neu-sm'}
          onSubmit={submit}
        >
          <header className="brand">
            <div
              className="beat-host"
              role="presentation"
              onClick={() => {
                toggleTheme();
              }}
            >
              <BrandMark />
            </div>
            <p className="brand-fa">هومانا</p>
            <p className="brand-sub">
              {step === 'mobile'
                ? 'ثبت‌نام — تأیید شمارهٔ موبایل'
                : 'ثبت‌نام — اطلاعات مطب یا کلینیک'}
            </p>
          </header>

          {state.kind === 'error' && (
            <p className="alert" role="alert">
              {state.message}
            </p>
          )}

          {step === 'mobile' ? (
            <div className="fields">
              <div className="field">
                <label className="field-label" htmlFor="register-mobile">
                  شمارهٔ موبایل
                </label>
                <div className="field-wrap neu-in fld">
                  <MobileIcon />
                  <input
                    id="register-mobile"
                    className="field-input ltr"
                    name="mobile"
                    value={mobile}
                    onChange={(event) => {
                      setMobile(event.target.value);
                    }}
                    inputMode="tel"
                    autoComplete="tel"
                    dir="ltr"
                    placeholder="09123456789"
                  />
                </div>
              </div>

              <p className="auth-note">
                کد تأیید به همین شماره پیامک می‌شود؛ ثبت‌نام با کد پیامکی انجام می‌شود.
              </p>
            </div>
          ) : (
            <div className="fields">
              <div className="field">
                <label className="field-label" htmlFor="register-code">
                  کد تأیید پیامک‌شده
                </label>
                <div className="field-wrap neu-in fld">
                  <SmsIcon />
                  <input
                    id="register-code"
                    className="field-input ltr"
                    name="code"
                    value={otpCode}
                    onChange={(event) => {
                      setOtpCode(event.target.value.replace(/\D/g, '').slice(0, 5));
                    }}
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    dir="ltr"
                    placeholder="۵ رقم"
                  />
                </div>
                {devCode !== null && (
                  <p className="auth-note">کد آزمایشی (فقط محیط توسعه): {devCode}</p>
                )}
              </div>

              <div className="field">
                <label className="field-label" htmlFor="register-name">
                  نام و نام خانوادگی
                </label>
                <div className="field-wrap neu-in fld">
                  <IdCardIcon />
                  <input
                    id="register-name"
                    className="field-input"
                    name="displayName"
                    value={displayName}
                    onChange={(event) => {
                      setDisplayName(event.target.value);
                    }}
                    autoComplete="name"
                    placeholder="مثلاً سارا محمدی"
                  />
                </div>
              </div>

              <div className="field">
                <label className="field-label" htmlFor="register-clinic">
                  نام مطب یا کلینیک
                </label>
                <div className="field-wrap neu-in fld">
                  <ClinicIcon />
                  <input
                    id="register-clinic"
                    className="field-input"
                    name="tenantName"
                    value={tenantName}
                    onChange={(event) => {
                      setTenantName(event.target.value);
                    }}
                    autoComplete="organization"
                    placeholder="مثلاً کلینیک سلامت پارس"
                  />
                </div>
              </div>

              <div className="field">
                <label className="field-label" htmlFor="register-address">
                  آدرس مطب یا کلینیک
                </label>
                <div className="field-wrap neu-in fld">
                  <PinIcon />
                  <textarea
                    id="register-address"
                    className="field-input field-input-area"
                    name="address"
                    value={address}
                    onChange={(event) => {
                      setAddress(event.target.value);
                    }}
                    autoComplete="street-address"
                    rows={2}
                    placeholder="مثلاً تهران، خیابان ولیعصر، پلاک ۱، طبقهٔ ۲"
                  />
                </div>
              </div>

              <div className="field">
                <label className="field-label" htmlFor="register-city">
                  شهر (اختیاری)
                </label>
                <div className="field-wrap neu-in fld">
                  <CityIcon />
                  <input
                    id="register-city"
                    className="field-input"
                    name="city"
                    value={city}
                    onChange={(event) => {
                      setCity(event.target.value);
                    }}
                    autoComplete="address-level2"
                    placeholder="مثلاً تهران"
                  />
                </div>
              </div>

              <button
                type="button"
                className="link-btn"
                onClick={() => {
                  void requestCode();
                }}
              >
                ارسال دوبارهٔ کد
              </button>
            </div>
          )}

          <button className="btn-cta cta" type="submit" disabled={state.kind === 'sending'}>
            {step === 'mobile'
              ? state.kind === 'sending'
                ? 'در حال ارسال کد…'
                : 'دریافت کد تأیید'
              : state.kind === 'sending'
                ? 'در حال ساخت حساب…'
                : 'ساخت حساب و ورود'}
          </button>

          <p className="auth-note">دورهٔ آزمایشی — بدون کارت بانکی</p>
        </form>

        <p className="footer-note">
          حساب دارید؟{' '}
          <button type="button" className="link-btn" onClick={onBackToLogin}>
            ورود به پنل
          </button>
        </p>
      </main>
    </div>
  );
}
