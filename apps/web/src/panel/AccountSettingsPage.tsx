import { useEffect, useState, type FormEvent, type JSX } from 'react';

interface DomainItem {
  readonly id: string;
  readonly hostname: string;
  readonly isPrimary: boolean;
  readonly isVerified: boolean;
  readonly verificationStatus: string;
  readonly verificationMethod: string;
  readonly verificationToken?: string;
}

interface PlanItem {
  readonly tier: string;
  readonly name: string;
  readonly maxUsers: number;
  readonly monthlyMessageUnits: number;
}

interface SettingsData {
  readonly tenant: { readonly name: string; readonly slug: string; readonly city?: string | null };
  readonly domains: readonly DomainItem[];
  readonly sms: {
    readonly provider: string;
    readonly sender: string;
    readonly isActive: boolean;
  } | null;
  readonly subscription: {
    readonly tier: string;
    readonly name: string;
    readonly status: string;
    readonly currentPeriodEnd: string;
  } | null;
}

type Notice = { readonly kind: 'ok' | 'error'; readonly text: string } | null;

async function jsonResponse(response: Response): Promise<Record<string, unknown>> {
  const body: unknown = await response.json().catch(() => ({}));
  return typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {};
}

export function AccountSettingsPage(): JSX.Element {
  const [data, setData] = useState<SettingsData | null>(null);
  const [plans, setPlans] = useState<readonly PlanItem[]>([]);
  const [domain, setDomain] = useState('');
  const [domainTokens, setDomainTokens] = useState<Record<string, string>>({});
  const [panelRef, setPanelRef] = useState('');
  const [sender, setSender] = useState('');
  const [selectedPlan, setSelectedPlan] = useState('FREE');
  const [months, setMonths] = useState('1');
  const [notice, setNotice] = useState<Notice>(null);
  const [loading, setLoading] = useState(true);

  async function load(): Promise<void> {
    setLoading(true);
    try {
      const [settingsResponse, plansResponse] = await Promise.all([
        fetch('/tenant/settings', { credentials: 'same-origin' }),
        fetch('/tenant/subscription/plans', { credentials: 'same-origin' }),
      ]);
      const settingsBody = await jsonResponse(settingsResponse);
      const plansBody = await jsonResponse(plansResponse);
      if (!settingsResponse.ok)
        throw new Error(
          String(
            (settingsBody.error as { message?: string } | undefined)?.message ??
              'بارگذاری تنظیمات ناموفق بود',
          ),
        );

      const settings = settingsBody as unknown as SettingsData;
      setData(settings);
      setPlans((plansBody.plans as PlanItem[] | undefined) ?? []);
      setSelectedPlan(settings.subscription?.tier ?? 'FREE');
      setSender(settings.sms?.sender ?? '');
    } catch (error) {
      setNotice({
        kind: 'error',
        text: error instanceof Error ? error.message : 'خطا در ارتباط با سرور',
      });
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  async function submitDomain(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const response = await fetch('/tenant/domains', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ hostname: domain }),
    });
    const body = await jsonResponse(response);
    if (!response.ok) {
      setNotice({
        kind: 'error',
        text: String(
          (body.error as { message?: string } | undefined)?.message ?? 'ثبت دامنه ناموفق بود',
        ),
      });
      return;
    }
    const created = body.domain as DomainItem;
    setDomainTokens((current) => ({ ...current, [created.id]: created.verificationToken ?? '' }));
    setDomain('');
    setNotice({ kind: 'ok', text: 'دامنه ثبت شد؛ رکورد TXT را بسازید و سپس تأیید را بزنید.' });
    await load();
  }

  async function verifyDomain(id: string): Promise<void> {
    const response = await fetch(`/tenant/domains/${id}/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ token: domainTokens[id] ?? '' }),
    });
    const body = await jsonResponse(response);
    setNotice({
      kind: response.ok ? 'ok' : 'error',
      text: response.ok
        ? 'دامنه تأیید شد.'
        : String(
            (body.error as { message?: string } | undefined)?.message ?? 'تأیید دامنه ناموفق بود',
          ),
    });
    await load();
  }

  async function saveSms(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const response = await fetch('/tenant/sms', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ provider: 'melipayamak', panelRef, sender }),
    });
    const body = await jsonResponse(response);
    setNotice({
      kind: response.ok ? 'ok' : 'error',
      text: response.ok
        ? 'پنل پیامک مستقل ذخیره شد.'
        : String(
            (body.error as { message?: string } | undefined)?.message ??
              'ذخیره پنل پیامک ناموفق بود',
          ),
    });
    if (response.ok) {
      setPanelRef('');
      await load();
    }
  }

  async function saveSubscription(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const response = await fetch('/tenant/subscription', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ tier: selectedPlan, months: Number(months) }),
    });
    const body = await jsonResponse(response);
    setNotice({
      kind: response.ok ? 'ok' : 'error',
      text: response.ok
        ? 'اشتراک حساب به‌روزرسانی شد.'
        : String(
            (body.error as { message?: string } | undefined)?.message ?? 'تغییر اشتراک ناموفق بود',
          ),
    });
    if (response.ok) await load();
  }

  if (loading && data === null) return <p className="pnl-empty">در حال بارگذاری تنظیمات حساب…</p>;
  if (data === null) return <p className="pnl-empty">تنظیمات حساب قابل بارگذاری نیست.</p>;

  return (
    <>
      <h1 className="pnl-page-title">تنظیمات حساب</h1>
      <p className="pnl-page-sub">مدیریت دامنه، پنل پیامک مستقل و اشتراک {data.tenant.name}</p>

      {notice !== null && (
        <p className={notice.kind === 'ok' ? 'pnl-notice' : 'pnl-notice pnl-notice-error'}>
          {notice.text}
        </p>
      )}

      <section className="pnl-card neu">
        <h2>دامنهٔ مستقل</h2>
        <p className="pnl-card-help">
          دامنه پس از تأیید DNS به صفحهٔ عمومی و پنل این حساب متصل می‌شود.
        </p>
        <form className="pnl-inline-form" onSubmit={(event) => void submitDomain(event)}>
          <input
            value={domain}
            onChange={(event) => setDomain(event.target.value)}
            placeholder="clinic.example.com"
            aria-label="دامنهٔ مستقل"
          />
          <button type="submit" className="pnl-cta cta">
            ثبت دامنه
          </button>
        </form>
        <div className="pnl-settings-list">
          {data.domains.map((item) => (
            <div className="pnl-settings-row" key={item.id}>
              <div>
                <strong>{item.hostname}</strong>
                <small>
                  {item.isPrimary ? 'دامنهٔ اصلی · ' : ''}
                  {item.isVerified ? 'تأییدشده' : 'در انتظار تأیید'}
                </small>
              </div>
              {!item.isVerified && (
                <div className="pnl-inline-form">
                  <input
                    value={domainTokens[item.id] ?? ''}
                    onChange={(event) =>
                      setDomainTokens((current) => ({ ...current, [item.id]: event.target.value }))
                    }
                    placeholder="توکن TXT"
                    aria-label={`توکن تأیید ${item.hostname}`}
                  />
                  <button
                    type="button"
                    className="icon-btn neu-sm"
                    onClick={() => void verifyDomain(item.id)}
                  >
                    تأیید
                  </button>
                </div>
              )}
            </div>
          ))}
        </div>
      </section>

      <section className="pnl-card neu">
        <h2>پنل پیامک مستقل</h2>
        <p className="pnl-card-help">
          اعتبار پنل در پایگاه‌داده رمزنگاری می‌شود و در پاسخ‌ها نمایش داده نمی‌شود.
        </p>
        <form className="pnl-settings-form" onSubmit={(event) => void saveSms(event)}>
          <label>
            شناسهٔ پنل
            <input
              value={panelRef}
              onChange={(event) => setPanelRef(event.target.value)}
              placeholder="شناسه پنل ملی‌پیامک"
            />
          </label>
          <label>
            خط ارسال
            <input
              value={sender}
              onChange={(event) => setSender(event.target.value)}
              placeholder="5000xxxx"
            />
          </label>
          <button type="submit" className="pnl-cta cta">
            ذخیره و فعال‌سازی
          </button>
        </form>
        <p className="pnl-card-help">
          وضعیت: {data.sms?.isActive ? 'فعال' : data.sms === null ? 'تنظیم نشده' : 'غیرفعال'}
        </p>
      </section>

      <section className="pnl-card neu">
        <h2>اشتراک حساب</h2>
        <p className="pnl-card-help">
          پلن فعلی: {data.subscription?.name ?? 'ثبت نشده'} · وضعیت:{' '}
          {data.subscription?.status ?? '—'}
        </p>
        <form className="pnl-settings-form" onSubmit={(event) => void saveSubscription(event)}>
          <label>
            پلن
            <select value={selectedPlan} onChange={(event) => setSelectedPlan(event.target.value)}>
              {plans.map((plan) => (
                <option key={plan.tier} value={plan.tier}>
                  {plan.name} · {plan.tier}
                </option>
              ))}
            </select>
          </label>
          <label>
            مدت (ماه)
            <input
              type="number"
              min="1"
              max="12"
              value={months}
              onChange={(event) => setMonths(event.target.value)}
            />
          </label>
          <button type="submit" className="pnl-cta cta">
            ثبت اشتراک
          </button>
        </form>
      </section>
    </>
  );
}
