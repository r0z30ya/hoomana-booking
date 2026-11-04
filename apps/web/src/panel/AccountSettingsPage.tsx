import { useEffect, useState, type FormEvent, type JSX } from 'react';
import { persianError } from '../errors';

interface DomainItem {
  readonly id: string;
  readonly hostname: string;
  readonly isPrimary: boolean;
  readonly isVerified: boolean;
  readonly verificationStatus: string;
  readonly verificationMethod: string;
  readonly verificationToken?: string;
}

interface SettingsData {
  readonly customDomainsEnabled: boolean;
  readonly customDomainsAvailable: boolean;
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
  const [domain, setDomain] = useState('');
  const [notice, setNotice] = useState<Notice>(null);
  const [loading, setLoading] = useState(true);

  async function load(): Promise<void> {
    setLoading(true);
    try {
      const settingsResponse = await fetch('/tenant/settings', { credentials: 'same-origin' });
      const settingsBody = await jsonResponse(settingsResponse);
      if (!settingsResponse.ok)
        throw new Error(persianError(settingsBody, 'بارگذاری تنظیمات ناموفق بود'));

      const settings = settingsBody as unknown as SettingsData;
      setData(settings);
    } catch (error) {
      setNotice({
        kind: 'error',
        text:
          error instanceof Error && /[\u0600-\u06ff]/.test(error.message)
            ? error.message
            : 'ارتباط با سرور برقرار نشد. اتصال را بررسی کنید.',
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
        text: persianError(body, 'ثبت دامنه ناموفق بود'),
      });
      return;
    }
    setDomain('');
    setNotice({ kind: 'ok', text: 'دامنه ثبت شد؛ رکورد TXT را بسازید و سپس تأیید را بزنید.' });
    await load();
  }

  async function verifyDomain(id: string): Promise<void> {
    const response = await fetch(`/tenant/domains/${id}/verify`, {
      method: 'POST',
      credentials: 'same-origin',
    });
    const body = await jsonResponse(response);
    setNotice({
      kind: response.ok ? 'ok' : 'error',
      text: response.ok ? 'دامنه تأیید شد.' : persianError(body, 'تأیید دامنه ناموفق بود'),
    });
    await load();
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
          تأیید مالکیت با DNS انجام می‌شود؛ اتصال نهایی و HTTPS جداگانه انجام می‌شود.
        </p>
        {!data.customDomainsEnabled && (
          <p className="pnl-card-help">ثبت دامنه اختصاصی در حال حاضر فعال نیست.</p>
        )}
        {data.customDomainsEnabled && !data.customDomainsAvailable && (
          <p className="pnl-card-help">برای ثبت دامنه اختصاصی به اشتراک پولی فعال نیاز است.</p>
        )}
        <form className="pnl-inline-form" onSubmit={(event) => void submitDomain(event)}>
          <input
            value={domain}
            onChange={(event) => setDomain(event.target.value)}
            placeholder="clinic.example.com"
            aria-label="دامنهٔ مستقل"
            disabled={!data.customDomainsAvailable}
          />
          <button type="submit" className="pnl-cta cta" disabled={!data.customDomainsAvailable}>
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
              {!item.isVerified && data.customDomainsAvailable && (
                <div className="pnl-inline-form">
                  <small dir="ltr">
                    TXT _hoomana-verification.{item.hostname}: {item.verificationToken}
                  </small>
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
        <p className="pnl-card-help">اتصال پنل پیامک توسط مدیریت هومانا انجام می‌شود.</p>
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
        <p className="pnl-card-help">برای تغییر یا تمدید اشتراک با پشتیبانی هومانا تماس بگیرید.</p>
      </section>
    </>
  );
}
