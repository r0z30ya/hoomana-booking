import { useEffect, useState, type JSX } from 'react';

interface Account {
  readonly tenant: { readonly name: string; readonly practiceType: 'SOLO' | 'CLINIC' };
  readonly subscription: { readonly status: string; readonly currentPeriodEnd: string } | null;
}

export function CheckoutPage(): JSX.Element {
  const [account, setAccount] = useState<Account | null>(null);
  const [prices, setPrices] = useState<Array<{ practiceType: 'SOLO' | 'CLINIC'; durationMonths: number; priceTomans: number }>>([]);
  const [months, setMonths] = useState(12);
  const [error, setError] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    void fetch('/auth/prices', { signal: controller.signal }).then(async (response) => response.ok ? response.json() as Promise<{ prices?: Array<{ practiceType: 'SOLO' | 'CLINIC'; durationMonths: number; priceTomans: number }> }> : null)
      .then((body) => { if (Array.isArray(body?.prices)) setPrices(body.prices); }).catch(() => {});
    void fetch('/tenant/settings', { credentials: 'same-origin', signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error('account unavailable');
        setAccount(await response.json() as Account);
      }).catch(() => { if (!controller.signal.aborted) setError(true); });
    return () => controller.abort();
  }, []);
  const clinic = account?.tenant.practiceType === 'CLINIC';
  const price = account ? prices.find((item) => item.practiceType === account.tenant.practiceType && item.durationMonths === months)?.priceTomans.toLocaleString('fa-IR') ?? 'تعیین نشده' : 'نامشخص';
  return <div className="pnl-checkout">
    <h1 className="pnl-page-title">سبد خرید اشتراک</h1>
    <p className="pnl-page-sub">دوره و جزئیات اشتراک مجموعه خود را بررسی کنید.</p>
    {error && <p className="pnl-notice" role="alert">دریافت اطلاعات اشتراک ممکن نشد. دوباره تلاش کنید.</p>}
    {!account && !error && <p>در حال دریافت اطلاعات…</p>}
    {account && <div className="pnl-checkout-grid"><section className="pnl-card neu">
      <span className="pnl-checkout-label">اشتراک پرو</span>
      <h2>پکیج {clinic ? 'کلینیک' : 'مطب'}</h2><p>{account.tenant.name}</p>
      <label>مدت اشتراک <select aria-label="مدت اشتراک" value={months} onChange={(event) => setMonths(Number(event.target.value))}><option value={3}>۳ ماهه</option><option value={6}>۶ ماهه</option><option value={12}>۱۲ ماهه</option></select></label>
      <p>{clinic ? 'پزشکان بدون محدودیت تعداد' : 'مناسب مدیریت یک پزشک'}</p>
      {account.subscription && <p>پایان دوره فعلی: {new Date(account.subscription.currentPeriodEnd).toLocaleDateString('fa-IR')}</p>}
      <p className="pnl-checkout-note">این سبد صرفاً برای بررسی سفارش است؛ اشتراک پس از پرداخت تأییدشده فعال می‌شود.</p>
    </section><section className="pnl-card neu">
      <h2>خلاصه سفارش</h2><div className="pnl-checkout-line"><span>اشتراک {months.toLocaleString('fa-IR')} ماهه</span><b>{price} تومان</b></div>
      <div className="pnl-checkout-line total"><span>مبلغ قابل پرداخت</span><b>{price} تومان</b></div>
      <button type="button" className="pnl-cta cta" disabled>پرداخت آنلاین به‌زودی فعال می‌شود</button>
      <p className="pnl-checkout-note">درگاه پرداخت هنوز راه‌اندازی نشده است. در حال حاضر مبلغی دریافت نمی‌شود.</p>
    </section></div>}
  </div>;
}
