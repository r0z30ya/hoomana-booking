import { useEffect, useState, type FormEvent, type JSX } from 'react';
import './platform.css';

const PASSWORD_FIELD = 'password';

interface AccountSummary {
  readonly id: string;
  readonly name: string;
  readonly slug: string;
  readonly ownerName: string | null;
  readonly ownerMobile: string | null;
  readonly city: string | null;
  readonly state: string;
  readonly planTier: string | null;
  readonly planName: string | null;
  readonly subscriptionStatus: string | null;
  readonly currentPeriodEnd: string | null;
  readonly domainCount: number;
  readonly verifiedDomainCount: number;
  readonly smsConfigured: boolean;
  readonly smsActive: boolean;
}

interface AccountDetail {
  readonly account: AccountSummary;
  readonly domains: readonly {
    hostname: string;
    isVerified: boolean;
    isPrimary: boolean;
    verificationStatus: string;
  }[];
  readonly sms: {
    provider: string;
    sender: string;
    isActive: boolean;
    lastError?: string | null;
  } | null;
  readonly subscription: {
    plan?: { name: string; tier: string };
    status: string;
    currentPeriodEnd: string;
  } | null;
  readonly activity: readonly {
    action: string;
    targetType?: string;
    createdAt: string;
    details?: unknown;
  }[];
}

type Notice = { readonly kind: 'ok' | 'error'; readonly text: string } | null;
type AccountState = 'ALL' | 'ACTIVE' | 'SUSPENDED' | 'BLOCKED';

async function bodyOf(response: Response): Promise<Record<string, unknown>> {
  const body: unknown = await response.json().catch(() => ({}));
  return typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {};
}

function errorText(body: Record<string, unknown>, fallback: string): string {
  const error = body.error as { message?: string } | undefined;
  return error?.message ?? fallback;
}

export function PlatformAdminPage(): JSX.Element {
  const [authenticated, setAuthenticated] = useState(false);
  const [mobile, setMobile] = useState('');
  const [passphrase, setPassphrase] = useState('');
  const [code, setCode] = useState('');
  const [challengeToken, setChallengeToken] = useState('');
  const [enrollment, setEnrollment] = useState<{
    token: string;
    secret: string;
    uri: string;
    recovery: readonly string[];
  } | null>(null);
  const [accounts, setAccounts] = useState<readonly AccountSummary[]>([]);
  const [selected, setSelected] = useState<AccountDetail | null>(null);
  const [notice, setNotice] = useState<Notice>(null);
  const [search, setSearch] = useState('');
  const [stateFilter, setStateFilter] = useState<AccountState>('ALL');
  const [planFilter, setPlanFilter] = useState('ALL');
  const [copiedValue, setCopiedValue] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [form, setForm] = useState({
    name: '',
    slug: '',
    ownerName: '',
    ownerMobile: '',
    planTier: 'FREE',
  });
  const [subscription, setSubscription] = useState({ planTier: 'FREE', months: '1' });

  async function loadAccounts(): Promise<void> {
    const params = new URLSearchParams({ search });
    if (stateFilter !== 'ALL') params.set('state', stateFilter);
    if (planFilter !== 'ALL') params.set('plan', planFilter);
    const response = await fetch(`/platform/accounts?${params.toString()}`, {
      credentials: 'same-origin',
    });
    const body = await bodyOf(response);
    if (!response.ok) {
      setNotice({ kind: 'error', text: errorText(body, 'فهرست اکانت‌ها قابل دریافت نیست') });
      return;
    }
    setAccounts((body.accounts as AccountSummary[] | undefined) ?? []);
  }

  async function loadDetail(id: string): Promise<void> {
    const response = await fetch(`/platform/accounts/${id}`, { credentials: 'same-origin' });
    const body = await bodyOf(response);
    if (!response.ok) {
      setNotice({ kind: 'error', text: errorText(body, 'جزئیات اکانت قابل دریافت نیست') });
      return;
    }
    setSelected(body as unknown as AccountDetail);
    const account = body.account as AccountSummary;
    setForm({
      name: account.name,
      slug: account.slug,
      ownerName: account.ownerName ?? '',
      ownerMobile: account.ownerMobile ?? '',
      planTier: account.planTier ?? 'FREE',
    });
    setSubscription({ planTier: account.planTier ?? 'FREE', months: '1' });
  }

  async function copyValue(value: string, label: string): Promise<void> {
    await navigator.clipboard?.writeText(value);
    setCopiedValue(label);
    window.setTimeout(() => setCopiedValue(null), 1800);
  }

  useEffect(() => {
    void fetch('/platform/auth/me', { credentials: 'same-origin' }).then(async (response) => {
      if (!response.ok) return;
      setAuthenticated(true);
      await loadAccounts();
    });
  }, []);

  async function login(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const response = await fetch('/platform/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ mobile, [PASSWORD_FIELD]: passphrase }),
    });
    const body = await bodyOf(response);
    if (body.mfaEnrollmentRequired === true) {
      setEnrollment({
        token: String(body.enrollmentToken),
        secret: String(body.secret),
        uri: String(body.otpauthUri),
        recovery: (body.recoveryCodes as string[]) ?? [],
      });
      setNotice({ kind: 'ok', text: 'MFA اولیه آماده است؛ کد برنامهٔ احراز هویت را وارد کنید.' });
      return;
    }
    if (body.mfaRequired === true) {
      setChallengeToken(String(body.challengeToken));
      setNotice({ kind: 'ok', text: 'کد TOTP یا کد بازیابی را وارد کنید.' });
      return;
    }
    if (!response.ok) {
      setNotice({ kind: 'error', text: errorText(body, 'ورود ناموفق بود') });
      return;
    }
    setAuthenticated(true);
    await loadAccounts();
  }

  async function enroll(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const response = await fetch('/platform/auth/enroll', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ enrollmentToken: enrollment?.token, code }),
    });
    const body = await bodyOf(response);
    if (!response.ok) {
      setNotice({ kind: 'error', text: errorText(body, 'ثبت MFA ناموفق بود') });
      return;
    }
    setEnrollment(null);
    setAuthenticated(true);
    setCode('');
    await loadAccounts();
  }

  async function verifyMfa(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const response = await fetch('/platform/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ mobile, [PASSWORD_FIELD]: passphrase, challengeToken, code }),
    });
    const body = await bodyOf(response);
    if (!response.ok) {
      setNotice({ kind: 'error', text: errorText(body, 'کد MFA نامعتبر است') });
      return;
    }
    setAuthenticated(true);
    setChallengeToken('');
    setCode('');
    await loadAccounts();
  }

  async function createAccount(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const response = await fetch('/platform/accounts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify(form),
    });
    const body = await bodyOf(response);
    if (!response.ok) {
      setNotice({ kind: 'error', text: errorText(body, 'ساخت اکانت ناموفق بود') });
      return;
    }
    setCreateOpen(false);
    setForm({ name: '', slug: '', ownerName: '', ownerMobile: '', planTier: 'FREE' });
    setNotice({ kind: 'ok', text: 'اکانت جدید ساخته شد.' });
    await loadAccounts();
  }

  async function setState(state: 'ACTIVE' | 'SUSPENDED' | 'BLOCKED'): Promise<void> {
    if (!selected) return;
    const response = await fetch(`/platform/accounts/${selected.account.id}/state`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ state }),
    });
    if (!response.ok) {
      setNotice({ kind: 'error', text: 'تغییر وضعیت اکانت ناموفق بود' });
      return;
    }
    setNotice({ kind: 'ok', text: `وضعیت اکانت به ${state} تغییر کرد.` });
    await loadAccounts();
    await loadDetail(selected.account.id);
  }

  async function updateAccount(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!selected) return;
    const response = await fetch(`/platform/accounts/${selected.account.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify(form),
    });
    if (!response.ok) {
      setNotice({ kind: 'error', text: 'ویرایش اکانت ناموفق بود' });
      return;
    }
    setEditOpen(false);
    setNotice({ kind: 'ok', text: 'مشخصات اکانت به‌روزرسانی شد.' });
    await loadAccounts();
    await loadDetail(selected.account.id);
  }

  async function changeSubscription(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!selected) return;
    const response = await fetch(`/platform/accounts/${selected.account.id}/subscription`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({
        planTier: subscription.planTier,
        months: Number(subscription.months),
      }),
    });
    if (!response.ok) {
      setNotice({ kind: 'error', text: 'تغییر پلن یا تمدید اشتراک ناموفق بود' });
      return;
    }
    setNotice({ kind: 'ok', text: 'پلن و تاریخ انقضا به‌روزرسانی شد.' });
    await loadAccounts();
    await loadDetail(selected.account.id);
  }

  async function signOut(): Promise<void> {
    await fetch('/platform/auth/logout', { method: 'POST', credentials: 'same-origin' });
    setAuthenticated(false);
    setSelected(null);
  }

  const activeAccounts = accounts.filter((account) => account.state === 'ACTIVE').length;
  const pausedAccounts = accounts.filter((account) => account.state !== 'ACTIVE').length;
  const connectedSms = accounts.filter((account) => account.smsActive).length;

  if (!authenticated) {
    return (
      <main className="platform-auth-page" dir="rtl">
        <section className="platform-auth-card neu">
          <div className="platform-auth-mark">H</div>
          <span className="platform-auth-eyebrow">HMN PLATFORM</span>
          <h1>ورود مدیر پلتفرم</h1>
          <p className="pnl-card-help">ورود فقط برای مدیران پلتفرم و با MFA فعال انجام می‌شود.</p>
          {enrollment !== null ? (
            <form className="pnl-settings-form" onSubmit={(event) => void enroll(event)}>
              <div className="platform-auth-step">
                <span className="platform-auth-step-number">۱</span>
                <div>
                  <strong>اتصال اپلیکیشن احراز هویت</strong>
                  <small>
                    کلید زیر را در Google Authenticator یا Microsoft Authenticator وارد کنید.
                  </small>
                </div>
              </div>
              <p>
                Secret: <code>{enrollment.secret}</code>
                <button
                  className="platform-copy-button"
                  type="button"
                  onClick={() => void copyValue(enrollment.secret, 'secret')}
                >
                  {copiedValue === 'secret' ? 'کپی شد' : 'کپی'}
                </button>
              </p>
              <p>
                <small>{enrollment.uri}</small>
              </p>
              <p>کدهای بازیابی را امن نگه دارید: {enrollment.recovery.join('، ')}</p>
              <input
                className="platform-auth-code"
                value={code}
                onChange={(event) => setCode(event.target.value)}
                placeholder="کد ۶ رقمی"
              />
              <button className="pnl-cta cta" type="submit">
                تکمیل MFA
              </button>
            </form>
          ) : challengeToken !== '' ? (
            <form className="pnl-settings-form" onSubmit={(event) => void verifyMfa(event)}>
              <input
                value={code}
                onChange={(event) => setCode(event.target.value)}
                placeholder="کد TOTP یا بازیابی"
              />
              <button className="pnl-cta cta" type="submit">
                تأیید و ورود
              </button>
            </form>
          ) : (
            <form className="pnl-settings-form" onSubmit={(event) => void login(event)}>
              <label>
                موبایل
                <input value={mobile} onChange={(event) => setMobile(event.target.value)} />
              </label>
              <label>
                رمز ورود
                <input
                  type="password"
                  value={passphrase}
                  onChange={(event) => setPassphrase(event.target.value)}
                />
              </label>
              <button className="pnl-cta cta" type="submit">
                ورود امن
              </button>
            </form>
          )}
          {notice !== null && (
            <p className={notice.kind === 'error' ? 'pnl-notice pnl-notice-error' : 'pnl-notice'}>
              {notice.text}
            </p>
          )}
        </section>
      </main>
    );
  }

  return (
    <main className="platform-app" dir="rtl">
      <section className="platform-main">
        <header className="pnl-topbar platform-topbar">
          <h1 className="pnl-page-title">مدیریت اکانت‌ها و کلینیک‌ها</h1>
          <button className="icon-btn neu-sm" onClick={() => void signOut()}>
            خروج
          </button>
        </header>
        <div className="pnl-page platform-page">
          {notice !== null && (
            <p className={notice.kind === 'error' ? 'pnl-notice pnl-notice-error' : 'pnl-notice'}>
              {notice.text}
            </p>
          )}
          <div className="platform-summary" aria-label="خلاصه وضعیت اکانت‌ها">
            <article className="platform-stat neu">
              <span className="platform-stat-icon">⌘</span>
              <div>
                <strong>{accounts.length}</strong>
                <span>کل اکانت‌ها</span>
              </div>
            </article>
            <article className="platform-stat neu">
              <span className="platform-stat-icon platform-stat-icon-success">✓</span>
              <div>
                <strong>{activeAccounts}</strong>
                <span>اکانت فعال</span>
              </div>
            </article>
            <article className="platform-stat neu">
              <span className="platform-stat-icon platform-stat-icon-warning">◷</span>
              <div>
                <strong>{pausedAccounts}</strong>
                <span>نیازمند پیگیری</span>
              </div>
            </article>
            <article className="platform-stat neu">
              <span className="platform-stat-icon platform-stat-icon-info">✦</span>
              <div>
                <strong>{connectedSms}</strong>
                <span>اتصال پیامک فعال</span>
              </div>
            </article>
          </div>
          <div className="platform-grid">
            <section className="pnl-card neu platform-card">
              <div className="platform-card-heading">
                <div>
                  <h2>اکانت‌ها و کلینیک‌ها</h2>
                  <p>مدیریت دامنه، اشتراک، پیامک و وضعیت دسترسی مشتریان</p>
                </div>
                <span className="platform-count-badge">{accounts.length} مورد</span>
              </div>
              <div className="pnl-inline-form">
                <input
                  placeholder="جست‌وجوی کلینیک، مالک یا موبایل"
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                />
                <button className="pnl-cta cta" onClick={() => void loadAccounts()}>
                  جست‌وجو
                </button>
                <button
                  className="icon-btn neu-sm"
                  onClick={() => setCreateOpen((value) => !value)}
                >
                  اکانت جدید
                </button>
              </div>
              <div className="platform-filters">
                <select
                  aria-label="فیلتر وضعیت"
                  value={stateFilter}
                  onChange={(event) => setStateFilter(event.target.value as AccountState)}
                >
                  <option value="ALL">همه وضعیت‌ها</option>
                  <option value="ACTIVE">فعال</option>
                  <option value="SUSPENDED">تعلیق‌شده</option>
                  <option value="BLOCKED">مسدودشده</option>
                </select>
                <select
                  aria-label="فیلتر پلن"
                  value={planFilter}
                  onChange={(event) => setPlanFilter(event.target.value)}
                >
                  <option value="ALL">همه پلن‌ها</option>
                  <option value="FREE">رایگان</option>
                  <option value="STARTER">شروع</option>
                  <option value="PRO">حرفه‌ای</option>
                  <option value="BUSINESS">سازمانی</option>
                  <option value="ENTERPRISE">سازمانی پلاس</option>
                </select>
              </div>
              {createOpen && (
                <form className="pnl-settings-form" onSubmit={(event) => void createAccount(event)}>
                  <input
                    placeholder="نام کلینیک"
                    value={form.name}
                    onChange={(event) => setForm({ ...form, name: event.target.value })}
                  />
                  <input
                    placeholder="slug"
                    value={form.slug}
                    onChange={(event) => setForm({ ...form, slug: event.target.value })}
                  />
                  <input
                    placeholder="نام مالک"
                    value={form.ownerName}
                    onChange={(event) => setForm({ ...form, ownerName: event.target.value })}
                  />
                  <input
                    placeholder="موبایل مالک"
                    value={form.ownerMobile}
                    onChange={(event) => setForm({ ...form, ownerMobile: event.target.value })}
                  />
                  <select
                    value={form.planTier}
                    onChange={(event) => setForm({ ...form, planTier: event.target.value })}
                  >
                    <option>FREE</option>
                    <option>STARTER</option>
                    <option>PRO</option>
                    <option>BUSINESS</option>
                    <option>ENTERPRISE</option>
                  </select>
                  <button className="pnl-cta cta">ساخت اکانت</button>
                </form>
              )}
              <div className="pnl-settings-list">
                {accounts.length === 0 && (
                  <div className="platform-empty">اکانتی با این فیلتر پیدا نشد.</div>
                )}
                {accounts.map((account) => (
                  <button
                    className="pnl-settings-row platform-account-row"
                    key={account.id}
                    type="button"
                    onClick={() => void loadDetail(account.id)}
                  >
                    <span>
                      <strong>{account.name}</strong>
                      <small>
                        {account.ownerName} · {account.planName ?? 'بدون پلن'} · {account.state}
                      </small>
                    </span>
                    <span>{account.subscriptionStatus ?? '—'}</span>
                  </button>
                ))}
              </div>
            </section>
            {selected !== null && (
              <section className="pnl-card neu platform-card">
                <h2>{selected.account.name}</h2>
                <p className="pnl-card-help">
                  مالک: {selected.account.ownerName} · دامنه‌ها: {selected.account.domainCount} (
                  {selected.account.verifiedDomainCount} تأییدشده) · پیامک:{' '}
                  {selected.sms?.isActive ? 'فعال' : selected.sms ? 'غیرفعال' : 'تنظیم نشده'}
                  {' · پرداخت: '}
                  {selected.subscription?.status ?? selected.account.subscriptionStatus ?? '—'}
                  {' · انقضا: '}
                  {selected.subscription?.currentPeriodEnd
                    ? new Date(selected.subscription.currentPeriodEnd).toLocaleDateString('fa-IR')
                    : '—'}
                </p>
                <div className="pnl-inline-form">
                  <button className="icon-btn neu-sm" onClick={() => void setState('ACTIVE')}>
                    فعال
                  </button>
                  <button className="icon-btn neu-sm" onClick={() => void setState('SUSPENDED')}>
                    تعلیق
                  </button>
                  <button className="icon-btn neu-sm" onClick={() => void setState('BLOCKED')}>
                    مسدودسازی
                  </button>
                  <button
                    className="icon-btn neu-sm"
                    onClick={() => setEditOpen((value) => !value)}
                  >
                    ویرایش
                  </button>
                  <button className="icon-btn neu-sm" onClick={() => void setState('BLOCKED')}>
                    حذف نرم
                  </button>
                </div>
                {editOpen && (
                  <form
                    className="pnl-settings-form"
                    onSubmit={(event) => void updateAccount(event)}
                  >
                    <input
                      value={form.name}
                      onChange={(event) => setForm({ ...form, name: event.target.value })}
                      placeholder="نام کلینیک"
                    />
                    <input
                      value={form.slug}
                      onChange={(event) => setForm({ ...form, slug: event.target.value })}
                      placeholder="slug"
                    />
                    <input
                      value={form.ownerName}
                      onChange={(event) => setForm({ ...form, ownerName: event.target.value })}
                      placeholder="نام مالک"
                    />
                    <input
                      value={form.ownerMobile}
                      onChange={(event) => setForm({ ...form, ownerMobile: event.target.value })}
                      placeholder="موبایل مالک"
                    />
                    <button className="pnl-cta cta">ذخیره ویرایش</button>
                  </form>
                )}
                <form
                  className="pnl-inline-form"
                  onSubmit={(event) => void changeSubscription(event)}
                >
                  <select
                    value={subscription.planTier}
                    onChange={(event) =>
                      setSubscription({ ...subscription, planTier: event.target.value })
                    }
                  >
                    <option>FREE</option>
                    <option>STARTER</option>
                    <option>PRO</option>
                    <option>BUSINESS</option>
                    <option>ENTERPRISE</option>
                  </select>
                  <input
                    type="number"
                    min="1"
                    max="36"
                    value={subscription.months}
                    onChange={(event) =>
                      setSubscription({ ...subscription, months: event.target.value })
                    }
                  />
                  <button className="pnl-cta cta">تغییر پلن و تمدید</button>
                </form>
                <h3>دامنه‌ها</h3>
                <ul className="pnl-list">
                  {selected.domains.map((domain) => (
                    <li key={domain.hostname}>
                      {domain.hostname} ·{' '}
                      {domain.isVerified ? 'تأییدشده' : domain.verificationStatus}
                    </li>
                  ))}
                </ul>
                <h3>گزارش فعالیت</h3>
                <ul className="pnl-list">
                  {selected.activity.slice(0, 20).map((event, index) => (
                    <li key={`${event.createdAt}-${index}`}>
                      {event.action} · {new Date(event.createdAt).toLocaleString('fa-IR')}
                    </li>
                  ))}
                </ul>
              </section>
            )}
          </div>
        </div>
      </section>
    </main>
  );
}
