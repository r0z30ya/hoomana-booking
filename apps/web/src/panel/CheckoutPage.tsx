import { useEffect, useState, type JSX } from 'react';

interface Account {
  readonly tenant: { readonly name: string; readonly practiceType: 'SOLO' | 'CLINIC' };
  readonly subscription: { readonly status: string; readonly currentPeriodEnd: string } | null;
}

export function CheckoutPage(): JSX.Element {
  const [account, setAccount] = useState<Account | null>(null);
  const [error, setError] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    void fetch('/tenant/settings', { credentials: 'same-origin', signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error('account unavailable');
        setAccount(await response.json() as Account);
      }).catch(() => { if (!controller.signal.aborted) setError(true); });
    return () => controller.abort();
  }, []);
  const clinic = account?.tenant.practiceType === 'CLINIC';
  const price = clinic ? '۳۵٬۰۰۰٬۰۰۰' : '۲۵٬۰۰۰٬۰۰۰';
  return <div className="pnl-checkout">
    <h1 className="pnl-page-title">سبد خرید اشتراک</h1>
    <p className="pnl-page-sub">جزئیات اشتراک سالانه مجموعه خود را بررسی کنید.</p>
    {error && <p className="pnl-notice" role="alert">دریافت اطلاعات اشتراک ممکن نشد. دوباره تلاش کنید.</p>}
    {!account && !error && <p>در حال دریافت اطلاعات…</p>}
    {account && <div className="pnl-checkout-grid"><section className="pnl-card neu">
      <span className="pnl-checkout-label">اشتراک یک‌ساله</span>
      <h2>پکیج {clinic ? 'کلینیک' : 'مطب'}</h2><p>{account.tenant.name}</p>
      <p>{clinic ? 'پزشکان بدون محدودیت تعداد' : 'مناسب مدیریت یک پزشک'}</p>
      {account.subscription && <p>پایان دوره فعلی: {new Date(account.subscription.currentPeriodEnd).toLocaleDateString('fa-IR')}</p>}
      <p className="pnl-checkout-note">این سبد صرفاً برای بررسی سفارش است؛ اشتراک پس از پرداخت تأییدشده فعال می‌شود.</p>
    </section><section className="pnl-card neu">
      <h2>خلاصه سفارش</h2><div className="pnl-checkout-line"><span>اشتراک سالانه</span><b>{price} تومان</b></div>
      <div className="pnl-checkout-line total"><span>مبلغ قابل پرداخت</span><b>{price} تومان</b></div>
      <button type="button" className="pnl-cta cta" disabled>پرداخت آنلاین به‌زودی فعال می‌شود</button>
      <p className="pnl-checkout-note">درگاه پرداخت هنوز راه‌اندازی نشده است. در حال حاضر مبلغی دریافت نمی‌شود.</p>
    </section></div>}
  </div>;
}
