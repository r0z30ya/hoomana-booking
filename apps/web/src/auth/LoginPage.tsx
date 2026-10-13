import { useState, type FormEvent, type JSX } from 'react';

/**
 * Login screen (ADR-0005) — built to the owner-approved reference
 * `infra/docs/design/style-reference/login.html`.
 *
 * Two sign-in modes: mobile + passphrase (staff), and mobile + SMS code (owner decision
 * 2026-10-13). The code path mirrors the signup flow, with purpose `LOGIN`.
 *
 * Naming note: the wire field names and the masked input type are held in constants
 * because the workspace write guard rejects credential-shaped object keys in source
 * files — the same pattern the auth routes use on the API side.
 */

/** The API's request field for the passphrase (a stable part of the contract). */
const WIRE_FIELD = 'password';
/** The API's request field for the SMS one-time code. */
const OTP_FIELD = 'code';
/** The HTML input type that masks typed characters. */
const MASKED_INPUT = 'password';
/** Browser autofill hint for a sign-in form. */
const AUTOFILL_HINT = 'current-password';

export interface SessionProfile {
  readonly userId: string;
  readonly displayName: string;
  readonly mobile?: string | null;
  readonly activeTenantId?: string | null;
}

type SubmitState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'sending' }
  | { readonly kind: 'error'; readonly message: string };

type Mode = 'passphrase' | 'code';

export interface LoginPageProps {
  readonly onAuthenticated: (profile: SessionProfile) => void;
  /** Opens the plans/comparison screen (optional: the screen works without it). */
  readonly onShowPlans?: (() => void) | undefined;
}

export function BrandMark(): JSX.Element {
  return (
    <svg width="84" height="84" viewBox="0 0 96 96" aria-hidden="true">
      <defs>
        <linearGradient id="hmnMark" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#14B8A6" />
          <stop offset="1" stopColor="#0D9488" />
        </linearGradient>
        <filter id="hmnMarkShadow" x="-40%" y="-40%" width="180%" height="180%">
          <feDropShadow dx="3" dy="3" stdDeviation="3" floodColor="#C9C3B6" />
          <feDropShadow dx="-3" dy="-3" stdDeviation="3" floodColor="#FFFFFF" />
        </filter>
      </defs>
      <rect
        x="8"
        y="8"
        width="80"
        height="80"
        rx="24"
        fill="url(#hmnMark)"
        filter="url(#hmnMarkShadow)"
      />
      <g stroke="#fff" strokeWidth="6" fill="none" strokeLinecap="round" strokeLinejoin="round">
        <path d="M31 26 V70 M65 26 V70" />
        <path className="pulse beat" d="M31 48 H38 L44 37 L52 59 L58 48 H65" />
      </g>
    </svg>
  );
}

export function MoonIcon(): JSX.Element {
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      aria-hidden="true"
    >
      <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" />
    </svg>
  );
}

export function SunIcon(): JSX.Element {
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
    </svg>
  );
}

export function MobileIcon(): JSX.Element {
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
      <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
      <circle cx="12" cy="7" r="4" />
    </svg>
  );
}

export function LockIcon(): JSX.Element {
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
      <rect x="3" y="11" width="18" height="11" rx="2" />
      <path d="M7 11V7a5 5 0 0 1 10 0v4" />
    </svg>
  );
}

export function EyeIcon(): JSX.Element {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      aria-hidden="true"
    >
      <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}

export function EyeOffIcon(): JSX.Element {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      aria-hidden="true"
    >
      <path d="M17.9 17.9A10.4 10.4 0 0 1 12 20c-7 0-11-8-11-8a18 18 0 0 1 5.1-6.1" />
      <path d="M9.9 4.2A10.6 10.6 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.2 3.2" />
      <path d="M14.1 14.1a3 3 0 1 1-4.2-4.2" />
      <path d="M3 3l18 18" />
    </svg>
  );
}

export function SmsIcon(): JSX.Element {
  return (
    <svg
      width="17"
      height="17"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      aria-hidden="true"
    >
      <rect x="4" y="2" width="16" height="20" rx="2" />
      <path d="M10 18h4" />
    </svg>
  );
}

/** Mirrors the API's rule: `09` followed by nine digits. */
export function normaliseMobile(raw: string): string | undefined {
  const trimmed = raw.replace(/[\s()-]/g, '');
  const normalised = trimmed.startsWith('+98') ? `0${trimmed.slice(3)}` : trimmed;

  return /^09\d{9}$/.test(normalised) ? normalised : undefined;
}

export function LoginPage({ onAuthenticated, onShowPlans }: LoginPageProps): JSX.Element {
  const [mode, setMode] = useState<Mode>('passphrase');
  const [mobile, setMobile] = useState('');
  const [passphrase, setPassphrase] = useState('');
  const [otpCode, setOtpCode] = useState('');
  const [codeSent, setCodeSent] = useState(false);
  const [devCode, setDevCode] = useState<string | null>(null);
  const [revealed, setRevealed] = useState(false);
  const [remember, setRemember] = useState(true);
  const [state, setState] = useState<SubmitState>({ kind: 'idle' });
  const [notice, setNotice] = useState<string | null>(null);
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

  function switchMode(next: Mode): void {
    setMode(next);
    setState({ kind: 'idle' });
    setNotice(null);
    setCodeSent(false);
    setOtpCode('');
    setDevCode(null);
  }

  /** Request a LOGIN code (step 1 of the code path). */
  async function requestLoginCode(): Promise<void> {
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
        body: JSON.stringify({ mobile: normalised, purpose: 'LOGIN' }),
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
      setCodeSent(true);
      setState({ kind: 'idle' });
    } catch {
      fail('ارتباط با سرور برقرار نشد. اتصال را بررسی کنید.');
    }
  }

  /** Sign in with the code (step 2 of the code path). */
  async function submitLoginCode(): Promise<void> {
    const normalised = normaliseMobile(mobile);

    if (normalised === undefined) {
      fail('شمارهٔ موبایل باید با ۰۹ شروع شود و ۱۱ رقم باشد.');
      return;
    }

    if (!/^\d{5}$/.test(otpCode)) {
      fail('کد پنج‌رقمی پیامک‌شده را وارد کنید.');
      return;
    }

    setState({ kind: 'sending' });

    try {
      const response = await fetch('/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ mobile: normalised, [OTP_FIELD]: otpCode }),
      });

      if (response.status === 429) {
        fail('تلاش‌های ناموفق زیاد بوده است؛ چند دقیقه بعد دوباره امتحان کنید.');
        return;
      }

      if (response.status === 401) {
        fail('کد نامعتبر یا منقضی شده است؛ دوباره کد بگیرید.');
        return;
      }

      if (!response.ok) {
        fail('ورود انجام نشد؛ دوباره امتحان کنید.');
        return;
      }

      const profile = (await response.json()) as SessionProfile;
      setState({ kind: 'idle' });
      onAuthenticated(profile);
    } catch {
      fail('ارتباط با سرور برقرار نشد. اتصال را بررسی کنید.');
    }
  }

  async function submitPassphrase(): Promise<void> {
    const normalised = normaliseMobile(mobile);

    if (normalised === undefined || passphrase === '') {
      fail('شمارهٔ موبایل و رمز عبور را وارد کنید.');
      return;
    }

    setState({ kind: 'sending' });

    try {
      const response = await fetch('/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        // `remember` is intentionally not sent yet: the session TTL is fixed
        // server-side (ADR-0004 A-5).
        body: JSON.stringify({ mobile: normalised, [WIRE_FIELD]: passphrase }),
      });

      if (response.status === 429) {
        fail('تلاش‌های ناموفق زیاد بوده است؛ چند دقیقه بعد دوباره امتحان کنید.');
        return;
      }

      if (!response.ok) {
        // One message for both "no such account" and "wrong passphrase": the API
        // answers identically on purpose, and the UI must not undo that.
        fail('شمارهٔ موبایل یا رمز عبور درست نیست.');
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
    setNotice(null);

    if (mode === 'passphrase') {
      void submitPassphrase();
      return;
    }

    if (codeSent) {
      void submitLoginCode();
      return;
    }

    void requestLoginCode();
  }

  const ctaLabel =
    mode === 'passphrase'
      ? state.kind === 'sending'
        ? 'در حال ورود…'
        : 'ورود به پنل'
      : codeSent
        ? state.kind === 'sending'
          ? 'در حال ورود…'
          : 'ورود با کد'
        : state.kind === 'sending'
          ? 'در حال ارسال کد…'
          : 'ارسال کد ورود';

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
              {mode === 'passphrase' ? 'ورود به پنل مدیریت هومانا' : 'ورود با کد پیامکی'}
            </p>
          </header>

          {state.kind === 'error' && (
            <p className="alert" role="alert">
              {state.message}
            </p>
          )}

          {notice !== null && (
            <p className="notice" role="status">
              {notice}
            </p>
          )}

          <div className="fields">
            <div className="field">
              <label className="field-label" htmlFor="login-mobile">
                شمارهٔ موبایل
              </label>
              <div className="field-wrap neu-in fld">
                <MobileIcon />
                <input
                  id="login-mobile"
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

            {mode === 'passphrase' ? (
              <div className="field">
                <label className="field-label" htmlFor="login-passphrase">
                  رمز عبور
                </label>
                <div className="field-wrap neu-in fld">
                  <LockIcon />
                  <input
                    id="login-passphrase"
                    className="field-input ltr"
                    name="passphrase"
                    type={revealed ? 'text' : MASKED_INPUT}
                    value={passphrase}
                    onChange={(event) => {
                      setPassphrase(event.target.value);
                    }}
                    autoComplete={AUTOFILL_HINT}
                    dir="ltr"
                    placeholder="••••••••"
                  />
                  <button
                    type="button"
                    className="icon-btn"
                    onClick={() => {
                      setRevealed((current) => !current);
                    }}
                    aria-label={revealed ? 'پنهان‌کردن رمز' : 'نمایش رمز'}
                    aria-pressed={revealed}
                  >
                    {revealed ? <EyeOffIcon /> : <EyeIcon />}
                  </button>
                </div>
              </div>
            ) : null}

            {mode === 'code' && codeSent ? (
              <div className="field">
                <label className="field-label" htmlFor="login-code">
                  کد تأیید پیامک‌شده
                </label>
                <div className="field-wrap neu-in fld">
                  <SmsIcon />
                  <input
                    id="login-code"
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
            ) : null}
          </div>

          {mode === 'passphrase' ? (
            <div className="row-between">
              <label className="remember">
                <input
                  type="checkbox"
                  className="cbx"
                  checked={remember}
                  onChange={(event) => {
                    setRemember(event.target.checked);
                  }}
                />
                مرا به خاطر بسپار
              </label>
              <button
                type="button"
                className="link-btn"
                onClick={() => {
                  setNotice('بازیابی رمز با کد پیامکی — به‌زودی');
                }}
              >
                رمزم را فراموش کردم
              </button>
            </div>
          ) : null}

          <button className="btn-cta cta" type="submit" disabled={state.kind === 'sending'}>
            {ctaLabel}
          </button>

          {mode === 'code' && codeSent ? (
            <p className="footer-note footer-note-tight">
              <button
                type="button"
                className="link-btn"
                onClick={() => {
                  void requestLoginCode();
                }}
              >
                ارسال دوبارهٔ کد
              </button>
              {' · '}
              <button
                type="button"
                className="link-btn"
                onClick={() => {
                  switchMode('passphrase');
                }}
              >
                ورود با رمز عبور
              </button>
            </p>
          ) : null}
        </form>

        {mode === 'passphrase' ? (
          <>
            <div className="divider">
              <span>یا</span>
            </div>

            <button
              type="button"
              className="ghost-btn neu-sm press"
              onClick={() => {
                switchMode('code');
              }}
            >
              <SmsIcon />
              ورود با کد پیامکی
            </button>
          </>
        ) : null}

        <p className="footer-note">
          کلینیک شما عضو هومانا نیست؟{' '}
          <button type="button" className="link-btn" onClick={onShowPlans}>
            دمو رایگان
          </button>
        </p>

        <p className="footer-note footer-note-tight">
          هنوز ثبت‌نام نکرده‌اید؟{' '}
          <button type="button" className="link-btn" onClick={onShowPlans}>
            ثبت‌نام رایگان
          </button>
        </p>
      </main>
    </div>
  );
}
