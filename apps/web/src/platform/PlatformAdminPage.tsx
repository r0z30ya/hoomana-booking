import { useEffect, useState, type FormEvent, type JSX } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import { persianError } from '../errors';
import { BrandMark } from '../auth/LoginPage';
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
    id: string;
    hostname: string;
    isVerified: boolean;
    isPrimary: boolean;
    verificationStatus: string;
    verificationToken: string | null;
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
type PlatformSection = 'accounts' | 'packages' | 'domains' | 'sms' | 'settings';
type DetailTab = 'account' | 'subscription' | 'domains' | 'sms' | 'activity';
type PracticeType = 'SOLO' | 'CLINIC';

function StatIcon({ kind }: { readonly kind: 'total' | 'free' | 'pro' | 'expired' }): JSX.Element {
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {kind === 'total' && <><circle cx="9" cy="8" r="3" /><path d="M3 20v-1a6 6 0 0 1 12 0v1M16 5a3 3 0 0 1 0 6M17 14a5 5 0 0 1 4 5v1" /></>}
    {kind === 'free' && <><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></>}
    {kind === 'pro' && <><path d="m12 3 2.8 5.7 6.2.9-4.5 4.4 1.1 6.2-5.6-3-5.6 3 1.1-6.2L3 9.6l6.2-.9z" /></>}
    {kind === 'expired' && <><circle cx="12" cy="12" r="9" /><path d="M9 8v8M15 8v8" /></>}
  </svg>;
}

const platformSections: readonly { id: PlatformSection; label: string; icon: string }[] = [
  { id: 'accounts', label: 'اکانت‌ها و کلینیک‌ها', icon: '▦' },
  { id: 'packages', label: 'پکیج‌ها و اشتراک', icon: '◇' },
  { id: 'domains', label: 'دامنه‌ها', icon: '◎' },
  { id: 'sms', label: 'پنل پیامکی', icon: '✉' },
  { id: 'settings', label: 'تنظیمات پلتفرم', icon: '⚙' },
];

async function bodyOf(response: Response): Promise<Record<string, unknown>> {
  const body: unknown = await response.json().catch(() => ({}));
  return typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {};
}

function errorText(body: Record<string, unknown>, fallback: string): string {
  return persianError(body, fallback);
}

function isPro(account: AccountSummary): boolean {
  return account.planTier === 'PRO' &&
    account.subscriptionStatus === 'ACTIVE' && account.currentPeriodEnd !== null &&
    new Date(account.currentPeriodEnd).getTime() > Date.now();
}

function isExpiredTrial(account: AccountSummary): boolean {
  return account.planTier === 'FREE' && account.subscriptionStatus === 'TRIALING' &&
    account.currentPeriodEnd !== null && new Date(account.currentPeriodEnd).getTime() <= Date.now();
}

function isActiveTrial(account: AccountSummary): boolean {
  return account.planTier === 'FREE' && account.subscriptionStatus === 'TRIALING' &&
    account.currentPeriodEnd !== null && new Date(account.currentPeriodEnd).getTime() > Date.now();
}

function displayState(account: AccountSummary): string {
  return account.state === 'ACTIVE' && isExpiredTrial(account) ? 'SUSPENDED' : account.state;
}

function stateLabel(state: string): string {
  return ({ ACTIVE: 'فعال', SUSPENDED: 'تعلیق‌شده', BLOCKED: 'مسدودشده' } as Record<string, string>)[state] ?? 'نامشخص';
}

function subscriptionLabel(account: AccountSummary): string {
  if (!account.currentPeriodEnd || new Date(account.currentPeriodEnd).getTime() <= Date.now()) return 'اشتراک منقضی';
  if (isPro(account)) return 'اشتراک فعال';
  if (account.subscriptionStatus === 'TRIALING') return 'آزمایشی';
  return 'اشتراک غیرفعال';
}

export function PlatformAdminPage(): JSX.Element {
  const [authenticated, setAuthenticated] = useState(false);
  const [section, setSection] = useState<PlatformSection>('accounts');
  const [menuOpen, setMenuOpen] = useState(false);
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
  const [detailTab, setDetailTab] = useState<DetailTab>('account');
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
  const [domainForm, setDomainForm] = useState({ hostname: '', domainId: '' });
  const [smsForm, setSmsForm] = useState({ panelRef: '', sender: '' });
  const [trialDays, setTrialDays] = useState<Record<PracticeType, string>>({ SOLO: '', CLINIC: '' });
  const [prices, setPrices] = useState<Record<PracticeType, Record<number, string>>>({ SOLO: {}, CLINIC: {} });
  const [configuredPrices, setConfiguredPrices] = useState<Record<PracticeType, readonly number[]>>({ SOLO: [], CLINIC: [] });
  const [savingPrices, setSavingPrices] = useState<PracticeType | null>(null);
  const [centralSms, setCentralSms] = useState<{ configured: boolean; sender: string | null; otpConfigured: boolean; otpBodyId: number | null; canEdit: boolean } | null>(null);
  const [centralSmsForm, setCentralSmsForm] = useState({ sender: '', panelRef: '', otpBodyId: '' });
  const [savingCentralSms, setSavingCentralSms] = useState(false);
  const [centralSmsError, setCentralSmsError] = useState(false);
  const [centralSmsCredit, setCentralSmsCredit] = useState<number | null>(null);
  const [checkingCentralSms, setCheckingCentralSms] = useState(false);
  const [centralSmsCheckFailed, setCentralSmsCheckFailed] = useState(false);
  const [smsTemplates, setSmsTemplates] = useState<Record<string, string>>({});
  const [savingTemplates, setSavingTemplates] = useState(false);
  const [showCentralSettings, setShowCentralSettings] = useState(false);
  const [smsTemplatesError, setSmsTemplatesError] = useState(false);
  const [subscriptionMonths, setSubscriptionMonths] = useState(12);
  const [pricesLoaded, setPricesLoaded] = useState(false);

  useEffect(() => {
    if (!authenticated || section !== 'sms') return;
    const controller = new AbortController();
    setCentralSms(null);
    setCentralSmsError(false);
    setCentralSmsCredit(null);
    setCentralSmsCheckFailed(false);
    setSmsTemplatesError(false);
    setSmsTemplates({});
    void fetch('/platform/sms/templates', { credentials: 'same-origin', signal: controller.signal }).then(async (response) => {
      if (!response.ok) throw new Error();
      const body = await bodyOf(response);
      if (!Array.isArray(body.templates)) throw new Error();
      const entries = Object.fromEntries(body.templates.filter((item: { event?: unknown; bodyId?: unknown }) => typeof item.event === 'string' && (item.bodyId === null || typeof item.bodyId === 'number')).map((item: { event: string; bodyId: number | null }) => [item.event, item.bodyId === null ? '' : String(item.bodyId)]));
      setSmsTemplates((current) => ({ ...current, ...entries }));
    }).catch(() => { if (!controller.signal.aborted) setSmsTemplatesError(true); });
    void fetch('/platform/sms/central', { credentials: 'same-origin', signal: controller.signal }).then(async (response) => {
      if (!response.ok) throw new Error();
      const body = await bodyOf(response);
      if (typeof body.configured !== 'boolean' || typeof body.otpConfigured !== 'boolean') throw new Error();
      const sender = typeof body.sender === 'string' ? body.sender : null;
      const otpBodyId = typeof body.otpBodyId === 'number' ? body.otpBodyId : null;
      setCentralSms({ configured: body.configured, sender, otpConfigured: body.otpConfigured, otpBodyId, canEdit: body.canEdit === true });
      setCentralSmsForm({ sender: sender ?? '', panelRef: '', otpBodyId: otpBodyId?.toString() ?? '' });
      setSmsTemplates((current) => ({ ...current, OTP: current.OTP ?? otpBodyId?.toString() ?? '' }));
      if (body.configured) void checkCentralSms(false);
    }).catch(() => { if (!controller.signal.aborted) setCentralSmsError(true); });
    return () => controller.abort();
  }, [authenticated, section]);

  async function saveCentralSms(event: React.FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setSavingCentralSms(true);
    try {
      const response = await fetch('/platform/sms/central', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sender: centralSmsForm.sender.trim(), otpBodyId: centralSmsForm.otpBodyId.trim() ? Number(centralSmsForm.otpBodyId) : null, ...(centralSmsForm.panelRef.trim() ? { panelRef: centralSmsForm.panelRef.trim() } : {}) }) });
      if (!response.ok) throw new Error();
      const body = await bodyOf(response);
      setCentralSms({ configured: body.configured === true, sender: typeof body.sender === 'string' ? body.sender : null, otpConfigured: body.otpConfigured === true, otpBodyId: typeof body.otpBodyId === 'number' ? body.otpBodyId : null, canEdit: body.canEdit === true });
      setCentralSmsForm((current) => ({ ...current, panelRef: '' }));
      setCentralSmsCredit(null);
      setNotice({ kind: 'ok', text: 'تنظیمات پنل مرکزی ذخیره شد. برای اطمینان، اتصال را بررسی کنید.' });
    } catch { setNotice({ kind: 'error', text: 'ذخیره تنظیمات انجام نشد؛ اطلاعات و تنظیمات سرور را بررسی کنید.' }); }
    finally { setSavingCentralSms(false); }
  }

  async function saveSmsTemplates(event: React.FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setSavingTemplates(true);
    try {
      const templates = ['OTP', 'BOOKING', 'RESCHEDULE', 'CANCELLATION', 'REMINDER', 'DOCTOR_BOOKING'].map((kind) => { const value = (smsTemplates[kind] ?? '').trim(); return { event: kind, bodyId: value ? Number(value) : null }; });
      const response = await fetch('/platform/sms/templates/batch', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ templates }) });
      if (!response.ok) throw new Error();
      const otpBodyId = templates[0]?.bodyId ?? null;
      setCentralSms((current) => current ? { ...current, otpBodyId, otpConfigured: otpBodyId !== null } : current);
      setCentralSmsForm((current) => ({ ...current, otpBodyId: otpBodyId?.toString() ?? '' }));
      setNotice({ kind: 'ok', text: 'الگوهای پیامک ذخیره شدند.' });
    } catch { setNotice({ kind: 'error', text: 'ذخیره الگوها انجام نشد؛ شناسه‌ها و اتصال سرور را بررسی کنید.' }); }
    finally { setSavingTemplates(false); }
  }

  async function checkCentralSms(showNotice = true): Promise<void> {
    setCheckingCentralSms(true); setCentralSmsCredit(null); setCentralSmsCheckFailed(false);
    try {
      const response = await fetch('/platform/sms/central/check', { method: 'POST', credentials: 'same-origin' });
      const body = await bodyOf(response);
      if (!response.ok || typeof body.credit !== 'number') throw new Error();
      setCentralSmsCredit(body.credit);
      if (showNotice) setNotice({ kind: 'ok', text: 'اتصال پنل مرکزی ملی‌پیامک برقرار است.' });
    } catch { setCentralSmsCheckFailed(true); if (showNotice) setNotice({ kind: 'error', text: 'بررسی اتصال پنل مرکزی انجام نشد؛ تنظیمات و دسترسی سرویس را بررسی کنید.' }); }
    finally { setCheckingCentralSms(false); }
  }

  useEffect(() => {
    if (!authenticated) return;
    void fetch('/platform/settings/trial', { credentials: 'same-origin' })
      .then(async (response) => {
        if (!response.ok) return;
        const body = await bodyOf(response);
        if (typeof body.soloTrialDays === 'number' && typeof body.clinicTrialDays === 'number') setTrialDays({ SOLO: String(body.soloTrialDays), CLINIC: String(body.clinicTrialDays) });
      })
      .catch(() => undefined);
  }, [authenticated]);

  useEffect(() => {
    if (!authenticated) return;
    void fetch('/platform/settings/prices', { credentials: 'same-origin' }).then(async (response) => {
      if (!response.ok) return;
      const body = await bodyOf(response);
      if (!Array.isArray(body.prices)) return;
      const next: Record<PracticeType, Record<number, string>> = { SOLO: {}, CLINIC: {} };
      for (const item of body.prices as Array<{ practiceType: PracticeType; durationMonths: number; priceTomans: number }>) {
        if ((item.practiceType === 'SOLO' || item.practiceType === 'CLINIC') && [3, 6, 12].includes(item.durationMonths) && typeof item.priceTomans === 'number') next[item.practiceType][item.durationMonths] = String(item.priceTomans);
      }
      setPrices(next);
      setConfiguredPrices({ SOLO: Object.keys(next.SOLO).map(Number), CLINIC: Object.keys(next.CLINIC).map(Number) });
      setPricesLoaded(true);
    }).catch(() => undefined);
  }, [authenticated]);

  async function savePrices(event: FormEvent<HTMLFormElement>, practiceType: PracticeType): Promise<void> {
    event.preventDefault();
    const entries = ([3, 6, 12] as const).filter((months) => (prices[practiceType][months] ?? '').trim() !== '').map((durationMonths) => ({ durationMonths, priceTomans: Number(prices[practiceType][durationMonths]) }));
    if (entries.length === 0) { setNotice({ kind: 'error', text: 'حداقل یک قیمت برای ذخیره وارد کنید.' }); return; }
    setSavingPrices(practiceType);
    try {
      const response = await fetch('/platform/settings/prices/batch', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ practiceType, prices: entries }) });
      if (!response.ok) throw new Error();
      setConfiguredPrices((current) => ({ ...current, [practiceType]: entries.map((entry) => entry.durationMonths) }));
      setNotice({ kind: 'ok', text: 'قیمت‌های پکیج ذخیره شدند.' });
    } catch { setNotice({ kind: 'error', text: 'ذخیره قیمت‌های پکیج انجام نشد.' }); }
    finally { setSavingPrices(null); }
  }

  async function saveTrialDays(event: FormEvent<HTMLFormElement>, practiceType: PracticeType): Promise<void> {
    event.preventDefault();
    try {
      const response = await fetch('/platform/settings/trial', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ practiceType, trialDays: Number(trialDays[practiceType]) }),
      });
      if (!response.ok) throw new Error();
      setNotice({ kind: 'ok', text: 'مدت دوره آزمایشی برای ثبت‌نام‌های جدید ذخیره شد.' });
    } catch {
      setNotice({ kind: 'error', text: 'ذخیره مدت دوره آزمایشی انجام نشد.' });
    }
  }

  async function loadAccounts(): Promise<void> {
    const response = await fetch('/platform/accounts?', {
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
    setDomainForm({ hostname: '', domainId: '' });
    setSmsForm({ panelRef: '', sender: '' });
    const account = body.account as AccountSummary;
    setForm({
      name: account.name,
      slug: account.slug,
      ownerName: account.ownerName ?? '',
      ownerMobile: account.ownerMobile ?? '',
      planTier: account.planTier ?? 'FREE',
    });
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
    let response: Response;
    try {
      response = await fetch('/platform/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ mobile, [PASSWORD_FIELD]: passphrase }),
      });
    } catch {
      setNotice({ kind: 'error', text: 'ارتباط با سرور برقرار نشد. اتصال را بررسی کنید.' });
      return;
    }
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
    setNotice(null);
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
    setNotice(null);
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
    setNotice(null);
    setAuthenticated(true);
    setChallengeToken('');
    setCode('');
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
    setNotice({ kind: 'ok', text: `وضعیت اکانت به «${stateLabel(state)}» تغییر کرد.` });
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
        planTier: 'PRO',
        months: subscriptionMonths,
      }),
    });
    if (!response.ok) {
      setNotice({ kind: 'error', text: 'تغییر پلن یا تمدید اشتراک ناموفق بود' });
      return;
    }
    setNotice({ kind: 'ok', text: 'اشتراک ثبت شد.' });
    await loadAccounts();
    await loadDetail(selected.account.id);
  }

  async function saveDomain(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!selected) return;
    const response = await fetch(`/platform/accounts/${selected.account.id}/domains`, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        hostname: domainForm.hostname,
        ...(domainForm.domainId ? { domainId: domainForm.domainId } : {}),
      }),
    });
    const body = await bodyOf(response);
    if (!response.ok) {
      setNotice({ kind: 'error', text: errorText(body, 'ثبت دامنه ناموفق بود') });
      return;
    }
    setNotice({ kind: 'ok', text: 'دامنه ثبت شد؛ مالکیت آن باید با DNS بررسی شود.' });
    await loadAccounts();
    await loadDetail(selected.account.id);
  }

  async function saveSms(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!selected) return;
    const response = await fetch(`/platform/accounts/${selected.account.id}/sms`, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(smsForm),
    });
    const body = await bodyOf(response);
    if (!response.ok) {
      setNotice({ kind: 'error', text: errorText(body, 'ثبت پنل پیامک ناموفق بود') });
      return;
    }
    setNotice({ kind: 'ok', text: 'تنظیمات پیامک ذخیره شد؛ اتصال به سرویس هنوز بررسی نشده است.' });
    await loadAccounts();
    await loadDetail(selected.account.id);
  }

  async function checkDomain(domainId: string): Promise<void> {
    if (!selected) return;
    const response = await fetch(
      `/platform/accounts/${selected.account.id}/domains/${domainId}/verify`,
      {
        method: 'POST',
        credentials: 'same-origin',
      },
    );
    setNotice(
      response.ok
        ? { kind: 'ok', text: 'مالکیت دامنه تأیید شد؛ اتصال نهایی جداگانه انجام می‌شود.' }
        : { kind: 'error', text: 'تأیید دامنه انجام نشد؛ رکورد DNS و اتصال را بررسی کنید.' },
    );
    await loadDetail(selected.account.id);
    await loadAccounts();
  }

  async function signOut(): Promise<void> {
    await fetch('/platform/auth/logout', { method: 'POST', credentials: 'same-origin' });
    setAuthenticated(false);
    setSelected(null);
  }

  const freeAccounts = accounts.filter(isActiveTrial).length;
  const proAccounts = accounts.filter(isPro).length;
  const expiredTrialAccounts = accounts.filter(isExpiredTrial).length;
  const searchTerm = search.trim().toLowerCase();
  const visibleAccounts = accounts.filter((account) =>
    (!searchTerm || [account.name, account.slug, account.ownerName, account.ownerMobile, account.city].some((value) => (value ?? '').toLowerCase().includes(searchTerm))) &&
    (stateFilter === 'ALL' || displayState(account) === stateFilter) &&
    (planFilter === 'ALL' || (planFilter === 'PRO' ? isPro(account) : !isPro(account))),
  );

  if (!authenticated) {
    return (
      <main className="platform-auth-page" dir="rtl">
        <section className="platform-auth-card neu">
          <div className="platform-auth-brand"><BrandMark /></div>
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
                    در برنامه احراز هویت، افزودن حساب و اسکن کد QR را انتخاب کنید. می‌توانید کلید
                    راه‌اندازی را هم به‌صورت دستی وارد کنید.
                  </small>
                </div>
              </div>
              <div className="platform-auth-qr">
                <QRCodeSVG
                  value={enrollment.uri}
                  size={200}
                  marginSize={4}
                  level="M"
                  role="img"
                  aria-label="کد QR برای اتصال برنامه احراز هویت"
                />
                <small>کد را با برنامه احراز هویت در گوشی اسکن کنید.</small>
              </div>
              <p>
                کلید راه‌اندازی: <code>{enrollment.secret}</code>
                <button
                  className="platform-copy-button"
                  type="button"
                  onClick={() => void copyValue(enrollment.secret, 'secret')}
                >
                  {copiedValue === 'secret' ? 'کپی شد' : 'کپی'}
                </button>
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
              <button
                className="icon-btn neu-sm"
                type="button"
                onClick={() => {
                  setEnrollment(null);
                  setCode('');
                  setNotice(null);
                }}
              >
                بازگشت و ساخت کلید جدید
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
            <p className={notice.kind === 'error' ? 'pnl-notice pnl-notice-error' : 'pnl-notice platform-notice-success'} role={notice.kind === 'error' ? 'alert' : 'status'}>
              {notice.text}
            </p>
          )}
        </section>
      </main>
    );
  }

  return (
    <main className="platform-app" dir="rtl">
      <aside
        className={`platform-sidebar${menuOpen ? ' is-open' : ''}`}
        aria-label="منوی مدیریت پلتفرم"
      >
        <div className="pnl-brand">
          <span className="platform-brand-mark"><BrandMark /></span>
          <div>
            <p className="pnl-brand-name">هومانا</p>
            <p className="pnl-brand-sub">مدیریت پلتفرم</p>
          </div>
        </div>
        <p className="platform-nav-caption">مدیریت</p>
        <nav className="platform-nav" aria-label="بخش‌های پلتفرم">
          {platformSections.map((item) => (
            <button
              key={item.id}
              type="button"
              className={section === item.id ? 'is-active' : ''}
              aria-current={section === item.id ? 'page' : undefined}
              onClick={() => {
                setSection(item.id);
                setMenuOpen(false);
                setNotice(null);
              }}
            >
              <span className="platform-nav-icon" aria-hidden="true">
                {item.icon}
              </span>
              {item.label}
            </button>
          ))}
        </nav>
        <div className="platform-sidebar-footer">پنل مدیریت هومانا</div>
      </aside>
      <section className="platform-main">
        <header className="pnl-topbar platform-topbar">
          <div className="platform-heading">
            <button
              type="button"
              className="platform-menu-toggle icon-btn neu-sm"
              aria-label="باز یا بستن منوی مدیریت"
              aria-expanded={menuOpen}
              onClick={() => setMenuOpen(!menuOpen)}
            >
              ☰
            </button>
            <div>
              <span className="platform-heading-kicker">پنل مدیریت پلتفرم</span>
              <h1 className="pnl-page-title">
                {platformSections.find((item) => item.id === section)?.label}
              </h1>
            </div>
          </div>
          <button className="icon-btn neu-sm" onClick={() => void signOut()}>
            خروج
          </button>
        </header>
        <div className="pnl-page platform-page">
          {notice !== null && (
            <p className={notice.kind === 'error' ? 'pnl-notice pnl-notice-error' : 'pnl-notice platform-notice-success'} role={notice.kind === 'error' ? 'alert' : 'status'}>
              {notice.text}
            </p>
          )}
          {section === 'sms' && <><section className="pnl-card neu platform-central-sms">
            <div className="platform-card-heading"><div><span className="platform-sms-eyebrow">تنظیمات سرویس پیامکی</span><h2>پنل مرکزی ملی‌پیامک</h2><p>اتصال و اعتبار پنل مورد استفاده هومانا</p></div><span className={`platform-state ${centralSmsCredit !== null ? 'platform-state-active' : 'platform-state-suspended'}`}>{centralSmsError ? 'دریافت وضعیت ناموفق' : centralSms === null || checkingCentralSms ? 'در حال بررسی' : centralSmsCredit !== null ? 'اتصال برقرار' : centralSmsCheckFailed ? 'اتصال ناموفق' : centralSms.configured ? 'آماده بررسی' : 'تنظیم نشده'}</span></div>
            {centralSms && <><button type="button" className="platform-sms-settings-toggle" aria-expanded={showCentralSettings} onClick={() => setShowCentralSettings(!showCentralSettings)}>{showCentralSettings ? 'بستن تنظیمات اتصال' : 'تنظیمات اتصال'}</button>{showCentralSettings && <form className="platform-central-form" onSubmit={(event) => void saveCentralSms(event)}>
              <label>کلید API پنل مرکزی<input type="password" autoComplete="new-password" dir="ltr" value={centralSmsForm.panelRef} required={!centralSms.configured} disabled={!centralSms.canEdit} placeholder={centralSms.configured ? 'برای حفظ کلید فعلی خالی بگذارید' : 'کلید API ملی‌پیامک'} onChange={(event) => setCentralSmsForm({ ...centralSmsForm, panelRef: event.target.value })} /></label>
              <label>شماره خط ارسال<input dir="ltr" inputMode="numeric" required disabled={!centralSms.canEdit} value={centralSmsForm.sender} onChange={(event) => setCentralSmsForm({ ...centralSmsForm, sender: event.target.value })} /></label>
              <button className="pnl-cta cta" type="submit" disabled={!centralSms.canEdit || savingCentralSms}>{savingCentralSms ? 'در حال ذخیره…' : 'ذخیره تنظیمات'}</button>
            </form>}
              {!centralSms.canEdit && <p className="pnl-card-help">برای امکان ذخیره تنظیمات، کلید رمزنگاری پیامک باید در تنظیمات سرور فعال شود.</p>}
              <div className="platform-central-credit"><div><span>اعتبار پنل</span><strong>{centralSmsCredit === null ? 'برای مشاهده، اتصال را بررسی کنید' : Math.trunc(centralSmsCredit).toLocaleString('fa-IR')}</strong></div>
              <button type="button" className="pnl-cta cta" disabled={!centralSms.configured || checkingCentralSms} onClick={() => void checkCentralSms()}>{checkingCentralSms ? 'در حال بررسی…' : 'بررسی اتصال و اعتبار'}</button></div></>}
          </section><section className="pnl-card neu platform-sms-templates">
            <div className="platform-card-heading"><div><span className="platform-sms-eyebrow">پیام‌های سرویس</span><h2>الگوهای پیامک</h2><p>شناسه الگوهای تأییدشده در ملی‌پیامک را برای هر پیام ثبت کنید.</p></div></div>
            <p className="platform-sms-note">شناسه الگو شماره‌ای است که ملی‌پیامک پس از ساخت و تأیید متن الگو به آن می‌دهد. برای کد یک‌بارمصرف، الگوی مشترکی با یک متغیر کد لازم است.</p>
            <p className="platform-sms-note">این بخش شناسه الگوها را نگهداری می‌کند؛ ارسال خودکار پیام‌های نوبت هنوز فعال نیست.</p>
            {smsTemplatesError && <p className="pnl-notice pnl-notice-error" role="alert">دریافت الگوها انجام نشد.</p>}
            <form onSubmit={(event) => void saveSmsTemplates(event)}><div className="platform-sms-template-grid">{([['OTP', 'کد یک‌بارمصرف', 'تأیید شماره و ورود'], ['BOOKING', 'ثبت نوبت', 'پیام تأیید برای بیمار'], ['DOCTOR_BOOKING', 'اعلان نوبت به پزشک', 'اطلاع‌رسانی نوبت جدید به پزشک'], ['RESCHEDULE', 'تغییر نوبت', 'اطلاع‌رسانی زمان جدید'], ['CANCELLATION', 'لغو نوبت', 'اطلاع‌رسانی لغو'], ['REMINDER', 'یادآوری نوبت', 'یادآوری پیش از مراجعه']] as const).map(([kind, title, description]) => <div className="platform-sms-template" key={kind}>
              <div className="platform-sms-template-head"><span className="platform-sms-template-icon" aria-hidden="true">✉</span><div><h3>{title}</h3><p>{description}</p></div></div>
              <label>شناسه الگو<input type="number" min="1" dir="ltr" aria-label={`شناسه الگوی ${title}`} placeholder="مثلاً ۱۲۳۴۵" value={smsTemplates[kind] ?? ''} onChange={(event) => setSmsTemplates({ ...smsTemplates, [kind]: event.target.value })} /></label>
            </div>)}</div><button type="submit" className="pnl-cta cta platform-sms-save-all" disabled={savingTemplates || smsTemplatesError}>{savingTemplates ? 'در حال ذخیره…' : 'ذخیره همه الگوها'}</button></form>
          </section></>}
          {section === 'accounts' && (
            <div className="platform-summary" aria-label="خلاصه وضعیت اکانت‌ها">
              <article className="platform-stat neu">
                <span className="platform-stat-icon"><StatIcon kind="total" /></span>
                <div>
                  <strong>{accounts.length}</strong>
                  <span>کل اکانت‌ها</span>
                </div>
              </article>
              <article className="platform-stat neu">
                <span className="platform-stat-icon platform-stat-icon-success"><StatIcon kind="free" /></span>
                <div>
                  <strong>{freeAccounts}</strong>
                  <span>اکانت رایگان</span>
                </div>
              </article>
              <article className="platform-stat neu">
                <span className="platform-stat-icon platform-stat-icon-info"><StatIcon kind="pro" /></span>
                <div>
                  <strong>{proAccounts}</strong>
                  <span>اکانت پرو</span>
                </div>
              </article>
              <article className="platform-stat neu">
                <span className="platform-stat-icon platform-stat-icon-warning"><StatIcon kind="expired" /></span>
                <div>
                  <strong>{expiredTrialAccounts}</strong>
                  <span title="پایان دوره رایگان">اکانت تعلیق‌شده</span>
                </div>
              </article>
            </div>
          )}
          {section === 'settings' ? (
            <section className="pnl-card neu platform-settings-card">
              <div className="platform-card-heading">
                <div>
                  <h2>تنظیمات ثبت‌نام</h2>
                  <p>تنظیمات پیش‌فرض برای کلینیک‌های جدید</p>
                </div>
              </div>
              <p className="pnl-card-help">مدت دوره رایگان هر پکیج در بخش پکیج‌ها و اشتراک تنظیم می‌شود.</p>
            </section>
          ) : section === 'packages' ? (
            <section className="platform-packages">
              <div className="platform-packages-intro"><div><span className="platform-packages-eyebrow">مدیریت تعرفه‌ها</span><h2>پکیج‌ها و اشتراک‌ها</h2><p>مدت دوره رایگان و قیمت اشتراک پرو را برای هر نوع مجموعه مشخص کنید.</p></div><span className="platform-packages-unit">همه قیمت‌ها به تومان</span></div>
              {!pricesLoaded && <p className="pnl-card-help">قیمت‌ها دریافت نشدند یا در حال بارگذاری هستند.</p>}
              <div className="platform-package-list">
                {(['SOLO', 'CLINIC'] as const).map((type) => <article key={type} className="platform-package-group">
                  <header className="platform-package-header"><span className="platform-package-icon" aria-hidden="true">{type === 'SOLO' ? '✚' : '▦'}</span><div><h3>{type === 'SOLO' ? 'پکیج مطب' : 'پکیج کلینیک'}</h3><p>{type === 'SOLO' ? 'مناسب برای یک پزشک' : 'مناسب برای مجموعه‌های چندپزشکی'}</p></div></header>
                  <form className="platform-package-card platform-free-card" onSubmit={(event) => void saveTrialDays(event, type)}>
                    <div className="platform-package-card-heading"><div><h4>{type === 'SOLO' ? 'مطب رایگان' : 'کلینیک رایگان'}</h4><p>برای شروع و آشنایی با سرویس</p></div><span className="platform-plan-badge">رایگان</span></div>
                    <div className="platform-free-controls"><label><span className="platform-free-label">مدت دوره آزمایشی <span>(روز)</span></span><input aria-label={`مدت دوره ${type === 'SOLO' ? 'مطب' : 'کلینیک'} رایگان (روز)`} type="number" min="1" max="365" required value={trialDays[type]} onChange={(event) => setTrialDays({ ...trialDays, [type]: event.target.value })} /></label><button type="submit" className="platform-package-save">ذخیره مدت</button></div>
                    <p className="platform-package-hint">این مدت برای ثبت‌نام‌های جدید اعمال می‌شود.</p>
                  </form>
                  <form className="platform-package-card platform-pro-card" onSubmit={(event) => void savePrices(event, type)}><div className="platform-package-card-heading"><div><h4>{type === 'SOLO' ? 'مطب پرو' : 'کلینیک پرو'}</h4><p>با دامنه و پنل پیامکی اختصاصی</p></div><span className="platform-plan-badge is-pro">✦ پرو</span></div>
                    <div className="platform-price-table"><div className="platform-price-table-heading"><span>مدت اشتراک</span><span>قیمت <small>(تومان)</small></span></div>
                    {pricesLoaded && ([3, 6, 12] as const).map((months) => <div key={months} className="platform-term-form">
                      <span className="platform-term-label">{months.toLocaleString('fa-IR')} ماهه</span>
                      <input aria-label={`قیمت ${type === 'SOLO' ? 'مطب' : 'کلینیک'} پرو ${months} ماهه (تومان)`} type="number" min="0" max="2000000000" step="1" required={configuredPrices[type].includes(months)} placeholder="تعیین نشده" value={prices[type][months] ?? ''} onChange={(event) => setPrices({ ...prices, [type]: { ...prices[type], [months]: event.target.value } })} />
                    </div>)}</div>
                    <p className="platform-package-hint">دوره‌های بدون قیمت، تعیین‌نشده می‌مانند.</p>
                    <button type="submit" className="platform-package-save platform-package-save-prices" disabled={!pricesLoaded || savingPrices !== null}>{savingPrices === type ? 'در حال ذخیره…' : 'ذخیره قیمت‌ها'}</button>
                  </form>
                </article>)}
              </div>
            </section>
          ) : section === 'sms' ? null : (
            <div className="platform-grid">
              <section className="pnl-card neu platform-card">
                <div className="platform-card-heading">
                  <div>
                    <h2>اکانت‌ها و کلینیک‌ها</h2>
                    <p>مدیریت دامنه، اشتراک، پیامک و وضعیت دسترسی مشتریان</p>
                  </div>
                  <span className="platform-count-badge">{visibleAccounts.length} مورد</span>
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
                    aria-label="فیلتر وضعیت مدیریتی"
                    value={stateFilter}
                    onChange={(event) => setStateFilter(event.target.value as AccountState)}
                  >
                    <option value="ALL">همه وضعیت‌های مدیریتی</option>
                    <option value="ACTIVE">فعال</option>
                    <option value="SUSPENDED">تعلیق‌شده</option>
                    <option value="BLOCKED">مسدودشده</option>
                  </select>
                  <select
                    aria-label="فیلتر پلن"
                    value={planFilter}
                    onChange={(event) => setPlanFilter(event.target.value)}
                  >
                    <option value="ALL">همه اشتراک‌ها</option>
                    <option value="FREE">بدون اشتراک فعال</option>
                    <option value="PRO">پرو با اشتراک فعال</option>
                  </select>
                </div>
                {createOpen && (
                  <div className="platform-registration-guide" role="region" aria-label="راهنمای ساخت اکانت">
                    <h3>ثبت‌نام اکانت جدید</h3>
                    <p>مالک مجموعه از صفحه ثبت‌نام، نوع مطب یا کلینیک را انتخاب و شماره موبایل خود را با کد پیامکی تأیید می‌کند. سپس اکانت با دوره آزمایشی همان پکیج ساخته می‌شود و در این فهرست قابل مدیریت است.</p>
                    <p>هر شماره فقط برای یک کاربر قابل ثبت است. برای ورود، مالک از همان شماره استفاده می‌کند.</p>
                    <p>برای ارسال واقعی کد، اتصال پنل مرکزی و الگوی کد یک‌بارمصرف باید در بخش پنل پیامکی تنظیم شده باشند.</p>
                    <a className="pnl-cta cta platform-registration-link" href={(() => { const url = new URL('/', window.location.href); url.hostname = url.hostname.replace(/^admin\./, ''); return url.href; })()} target="_blank" rel="noopener noreferrer">باز کردن صفحه ثبت‌نام</a>
                  </div>
                )}
                <div className="pnl-settings-list">
                  {visibleAccounts.length === 0 && (
                    <div className="platform-empty">اکانتی با این فیلتر پیدا نشد.</div>
                  )}
                  {visibleAccounts.map((account) => (
                    <button
                      className="pnl-settings-row platform-account-row"
                      key={account.id}
                      type="button"
                      onClick={() => { setDetailTab('account'); void loadDetail(account.id); }}
                    >
                      <span>
                        <strong>{account.name} {isPro(account) && <span className="platform-pro-star" title="اشتراک پرو فعال" aria-label="اشتراک پرو فعال">★</span>}</strong>
                        <small>
                          {account.ownerName || 'مالک ثبت نشده'} · {subscriptionLabel(account)}
                        </small>
                      </span>
                      <span className={`platform-state platform-state-${displayState(account).toLowerCase()}`} title={isExpiredTrial(account) && account.state === 'ACTIVE' ? 'پایان دوره آزمایشی' : 'وضعیت مدیریتی'}>{stateLabel(displayState(account))}</span>
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
                    {' · اشتراک: '}
                    {subscriptionLabel(selected.account)}
                    {' · انقضا: '}
                    {selected.subscription?.currentPeriodEnd
                      ? new Date(selected.subscription.currentPeriodEnd).toLocaleDateString('fa-IR')
                      : '—'}
                  </p>
                  {section === 'accounts' && <nav className="platform-detail-tabs" aria-label="بخش‌های اکانت">
                    {([
                      ['account', 'مشخصات'], ['subscription', 'اشتراک'], ['domains', 'دامنه'], ['sms', 'پیامک'], ['activity', 'فعالیت'],
                    ] as const).map(([id, label]) => <button type="button" key={id} className={detailTab === id ? 'is-active' : ''} aria-current={detailTab === id ? 'page' : undefined} onClick={() => setDetailTab(id)}>{label}</button>)}
                  </nav>}
                  {section === 'accounts' && detailTab === 'account' && (
                    <>
                      <div className="pnl-inline-form">
                        <button className="icon-btn neu-sm" onClick={() => void setState('ACTIVE')}>
                          فعال
                        </button>
                        <button
                          className="icon-btn neu-sm"
                          onClick={() => void setState('SUSPENDED')}
                        >
                          تعلیق
                        </button>
                        <button
                          className="icon-btn neu-sm"
                          onClick={() => void setState('BLOCKED')}
                        >
                          مسدودسازی
                        </button>
                        <button
                          className="icon-btn neu-sm"
                          onClick={() => setEditOpen((value) => !value)}
                        >
                          ویرایش
                        </button>
                      </div>
                      {isExpiredTrial(selected.account) && <p className="pnl-card-help">دوره آزمایشی پایان یافته است؛ ثبت اشتراک برای دسترسی دوباره به نوبت‌دهی لازم است.</p>}
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
                            onChange={(event) =>
                              setForm({ ...form, ownerName: event.target.value })
                            }
                            placeholder="نام مالک"
                          />
                          <input
                            value={form.ownerMobile}
                            onChange={(event) =>
                              setForm({ ...form, ownerMobile: event.target.value })
                            }
                            placeholder="موبایل مالک"
                          />
                          <button className="pnl-cta cta">ذخیره ویرایش</button>
                        </form>
                      )}
                    </>
                  )}
                  {section === 'accounts' && detailTab === 'subscription' && (
                    <>
                      <h3>اشتراک اکانت</h3>
                      <form
                        className="pnl-inline-form"
                        onSubmit={(event) => void changeSubscription(event)}
                      >
                        <label>مدت اشتراک پرو <select value={subscriptionMonths} onChange={(event) => setSubscriptionMonths(Number(event.target.value))}><option value={3}>۳ ماهه</option><option value={6}>۶ ماهه</option><option value={12}>۱۲ ماهه</option></select></label>
                        <button className="pnl-cta cta">ثبت اشتراک</button>
                      </form>
                    </>
                  )}
                  {((section === 'accounts' && detailTab === 'domains') || section === 'domains') && (
                    <>
                      <h3>دامنه‌ها</h3>
                      <p className="pnl-card-help">
                        دامنه جدید پس از ثبت، در انتظار تأیید مالکیت است. تغییر دامنه تأیید قبلی را
                        لغو می‌کند.
                      </p>
                      <ul className="pnl-list">
                        {selected.domains.map((domain) => (
                          <li key={domain.hostname}>
                            <span dir="ltr">{domain.hostname}</span> ·{' '}
                            {domain.isVerified ? 'مالکیت تأیید شده' : 'در انتظار تأیید'}{' '}
                            <button
                              type="button"
                              className="platform-copy-button"
                              onClick={() =>
                                setDomainForm({ hostname: domain.hostname, domainId: domain.id })
                              }
                            >
                              ویرایش
                            </button>
                            {!domain.isVerified && (
                              <button
                                type="button"
                                className="platform-copy-button"
                                onClick={() => void checkDomain(domain.id)}
                              >
                                بررسی DNS
                              </button>
                            )}
                            {!domain.isVerified && domain.verificationToken && (
                              <small className="platform-dns-record" dir="ltr">
                                TXT _hoomana-verification.{domain.hostname}:{' '}
                                {domain.verificationToken}
                              </small>
                            )}
                          </li>
                        ))}
                      </ul>
                      <form
                        className="pnl-inline-form"
                        onSubmit={(event) => void saveDomain(event)}
                      >
                        <input
                          dir="ltr"
                          aria-label="دامنه اختصاصی"
                          placeholder="clinic.example.com"
                          required
                          value={domainForm.hostname}
                          onChange={(event) =>
                            setDomainForm({ ...domainForm, hostname: event.target.value })
                          }
                        />
                        <button className="pnl-cta cta" type="submit">
                          {domainForm.domainId ? 'ذخیره دامنه' : 'افزودن دامنه'}
                        </button>
                        {domainForm.domainId && (
                          <button
                            className="icon-btn neu-sm"
                            type="button"
                            onClick={() => setDomainForm({ hostname: '', domainId: '' })}
                          >
                            انصراف
                          </button>
                        )}
                      </form>
                    </>
                  )}
                  {section === 'accounts' && detailTab === 'sms' && (
                    <>
                      <h3>پنل پیامک اختصاصی</h3>
                      <p className="pnl-card-help">
                        {selected.sms
                          ? `خط ارسال: ${selected.sms.sender}`
                          : 'برای این کلینیک پنلی ثبت نشده است.'}{' '}
                        اطلاعات اتصال فقط توسط مدیریت پلتفرم تنظیم می‌شود.
                      </p>
                      <form className="pnl-settings-form" onSubmit={(event) => void saveSms(event)}>
                        <label>
                          شناسه پنل ملی‌پیامک
                          <input
                            type="password"
                            autoComplete="new-password"
                            required
                            minLength={16}
                            value={smsForm.panelRef}
                            onChange={(event) =>
                              setSmsForm({ ...smsForm, panelRef: event.target.value })
                            }
                          />
                        </label>
                        <label>
                          خط ارسال
                          <input
                            dir="ltr"
                            inputMode="numeric"
                            required
                            pattern="[0-9]{5,20}"
                            value={smsForm.sender}
                            onChange={(event) =>
                              setSmsForm({ ...smsForm, sender: event.target.value })
                            }
                          />
                        </label>
                        <button className="pnl-cta cta" type="submit">
                          ذخیره تنظیمات پیامک
                        </button>
                      </form>
                    </>
                  )}
                  {section === 'accounts' && detailTab === 'activity' && (
                    <>
                      <h3>گزارش فعالیت</h3>
                      <ul className="pnl-list">
                        {selected.activity.slice(0, 20).map((event, index) => (
                          <li key={`${event.createdAt}-${index}`}>
                            {event.action} · {new Date(event.createdAt).toLocaleString('fa-IR')}
                          </li>
                        ))}
                      </ul>
                    </>
                  )}
                </section>
              )}
              {selected === null && (
                <section className="pnl-card neu platform-card platform-select-prompt">
                  <span aria-hidden="true">↗</span>
                  <h2>یک کلینیک انتخاب کنید</h2>
                  <p>برای مشاهده و مدیریت اطلاعات، یک اکانت را از فهرست انتخاب کنید.</p>
                </section>
              )}
            </div>
          )}
        </div>
      </section>
    </main>
  );
}
