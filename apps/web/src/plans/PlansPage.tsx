import { useEffect, useState, type JSX } from 'react';
import './plans.css';
import { BrandMark } from '../auth/LoginPage';

type PracticeType = 'SOLO' | 'CLINIC';
export interface PlansPageProps {
  readonly onStartFree: (type: PracticeType) => void;
  readonly onBackToLogin?: (() => void) | undefined;
}

const plans = [
  { type: 'SOLO' as const, name: 'مطب', tag: 'برای مطب‌های مستقل', price: '۲۵٬۰۰۰٬۰۰۰', description: 'همه چیز برای مدیریت برنامه کاری یک پزشک در یک فضای ساده و منظم.', features: ['مدیریت یک پزشک', 'تعریف خدمات و مدت هر نوبت', 'تنظیم ساعت کاری و گام نوبت‌دهی', 'ثبت و مدیریت نوبت‌ها', 'تعیین ظرفیت هم‌زمان هر خدمت'] },
  { type: 'CLINIC' as const, name: 'کلینیک', tag: 'برای مجموعه‌های چندپزشکی', price: '۳۵٬۰۰۰٬۰۰۰', description: 'برنامه پزشکان و خدمات مجموعه را از یک پنل مدیریت کنید.', features: ['تعریف پزشکان بدون محدودیت تعداد', 'برنامه و خدمات جداگانه برای هر پزشک', 'تنظیم ساعت کاری و ظرفیت نوبت‌ها', 'ثبت و مدیریت نوبت‌های پزشکان', 'دسترسی مدیر و پذیرش به نوبت‌ها'] },
];

export function PlansPage({ onStartFree, onBackToLogin }: PlansPageProps): JSX.Element {
  const [days, setDays] = useState<number | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    void fetch('/auth/trial', { signal: controller.signal }).then(async (r) => r.ok ? r.json() as Promise<{ trialDays?: unknown }> : null)
      .then((data) => { if (typeof data?.trialDays === 'number') setDays(data.trialDays); })
      .catch(() => {});
    return () => controller.abort();
  }, []);
  const trial = days === null ? 'دوره آزمایشی رایگان' : `آزمایش رایگان ${days.toLocaleString('fa-IR')} روزه`;
  return <div className="market" dir="rtl">
    <header className="market-nav">
      <a className="market-logo" href="#top"><BrandMark /><strong>هومانا</strong></a>
      <nav aria-label="راهنمای صفحه"><a href="#features">امکانات</a><a href="#plans">تعرفه‌ها</a><a href="#questions">پرسش‌های متداول</a></nav>
      <div className="market-nav-actions"><button type="button" className="market-login" onClick={onBackToLogin}>ورود</button><button type="button" className="market-button small" onClick={() => onStartFree('SOLO')}>شروع رایگان <span>←</span></button></div>
    </header>
    <main id="top">
      <section className="market-hero">
        <div className="market-hero-copy">
          <span className="market-eyebrow"><i /> مدیریت ساده‌تر، رسیدگی بهتر</span>
          <h1>زمان شما برای<br /><em>مراقبت از بیماران</em> است.</h1>
          <p>از برنامه‌ریزی ساعت کاری تا ثبت نوبت بیماران، همه‌چیز را در یک پنل منظم و قابل فهم مدیریت کنید.</p>
          <div className="market-hero-actions"><button type="button" className="market-button" onClick={() => onStartFree('SOLO')}>همین حالا رایگان امتحان کنید <span>←</span></button><a className="market-text-link" href="#plans">مشاهده تعرفه‌ها <span>↓</span></a></div>
          <p className="market-assurance">✓ {trial} <span>·</span> ✓ بدون نیاز به کارت بانکی</p>
        </div>
        <div className="market-visual" aria-hidden="true">
          <div className="market-visual-top"><span className="visual-logo"><BrandMark /></span><div><strong>نمای کلی برنامه</strong><small>پنل مدیریت هومانا</small></div><span className="visual-dots">•••</span></div>
          <div className="visual-heading"><div><small>برنامه کاری شما</small><strong>یک روز منظم‌تر</strong></div><span className="visual-badge">نوبت‌دهی</span></div>
          <div className="visual-row"><span className="visual-time">۰۹:۰۰</span><span className="visual-line teal" /><div><strong>ویزیت و مشاوره</strong><small>برنامه پزشک</small></div><span className="visual-check">✓</span></div>
          <div className="visual-row"><span className="visual-time">۱۰:۳۰</span><span className="visual-line amber" /><div><strong>خدمات مجموعه</strong><small>ظرفیت و مدت دلخواه</small></div><span className="visual-check">✓</span></div>
          <div className="visual-row"><span className="visual-time">۱۱:۰۰</span><span className="visual-line teal" /><div><strong>مدیریت نوبت‌ها</strong><small>همه چیز در یک نگاه</small></div><span className="visual-check">✓</span></div>
          <div className="visual-foot"><span>✦</span> برنامه‌ای هماهنگ با روش کار شما</div>
        </div>
      </section>
      <section className="market-strip"><span>برای مطب‌ها و کلینیک‌ها طراحی شده</span><b>●</b><span>تنظیمات منعطف نوبت‌دهی</span><b>●</b><span>دسترسی آسان از مرورگر</span></section>
      <section id="features" className="market-section">
        <div className="market-section-head"><span className="market-kicker">امکانات هومانا</span><h2>تمرکز بیشتر روی آنچه مهم است.</h2><p>ابزارهای کاربردی برای نظم دادن به برنامه پزشکان و پذیرش بیماران.</p></div>
        <div className="market-features">
          <article><span className="feature-icon">◷</span><h3>نوبت‌دهی منعطف</h3><p>ساعت کاری، مدت و فاصله نوبت‌ها را متناسب با برنامه مجموعه تنظیم کنید.</p></article>
          <article><span className="feature-icon">✚</span><h3>پزشکان و خدمات</h3><p>خدمات را تعریف کنید و برای هر پزشک برنامه و خدمات خودش را داشته باشید.</p></article>
          <article><span className="feature-icon">◎</span><h3>ظرفیت هم‌زمان</h3><p>تعداد نوبت قابل پذیرش در هر زمان را برای هر خدمت مشخص کنید.</p></article>
          <article><span className="feature-icon">▤</span><h3>مدیریت نوبت‌ها</h3><p>زمان‌های آزاد را ببینید، نوبت ثبت کنید و برنامه پیش رو را پیگیری کنید.</p></article>
        </div>
      </section>
      <section id="plans" className="market-section market-pricing">
        <div className="market-section-head"><span className="market-kicker">تعرفه‌های شفاف</span><h2>پکیجی متناسب با مجموعه شما</h2><p>هر دو پکیج با {trial} شروع می‌شوند. پس از آن، برای ادامه اشتراک تهیه کنید.</p></div>
        <div className="market-plans">{plans.map((plan) => <article className={plan.type === 'CLINIC' ? 'market-plan featured' : 'market-plan'} key={plan.type}>
          <div className="market-plan-top"><div><span>{plan.tag}</span><h3>پکیج {plan.name}</h3></div>{plan.type === 'CLINIC' && <b>چندپزشکی</b>}</div>
          <p>{plan.description}</p><div className="market-price"><strong>{plan.price}</strong> <span>تومان / سال</span></div>
          <button className={plan.type === 'CLINIC' ? 'market-button' : 'market-outline'} type="button" onClick={() => onStartFree(plan.type)}>شروع رایگان {plan.name} <span>←</span></button>
          <div className="market-includes">امکانات پکیج</div><ul>{plan.features.map((feature) => <li key={feature}><span>✓</span>{feature}</li>)}</ul>
        </article>)}</div>
        <p className="market-price-note">قیمت‌ها برای اشتراک یک‌ساله و به تومان هستند. پرداخت آنلاین پس از راه‌اندازی درگاه فعال می‌شود.</p>
      </section>
      <section id="questions" className="market-section market-faq"><div><span className="market-kicker">سوالات متداول</span><h2>پیش از شروع بیشتر بدانید.</h2></div><div>
        <details><summary>دوره آزمایشی چگونه شروع می‌شود؟</summary><p>با ثبت‌نام و تأیید شماره مدیر، حساب آزمایشی مجموعه ساخته می‌شود. برای شروع به کارت بانکی نیازی نیست.</p></details>
        <details><summary>تفاوت مطب و کلینیک چیست؟</summary><p>مطب برای یک پزشک است؛ در کلینیک می‌توانید چند پزشک تعریف کنید و برنامه هرکدام را جداگانه مدیریت کنید.</p></details>
        <details><summary>بعد از پایان دوره آزمایشی چه می‌شود؟</summary><p>برای ادامه استفاده از نوبت‌دهی باید اشتراک فعال داشته باشید. اطلاعات برای بررسی در پنل باقی می‌ماند.</p></details>
      </div></section>
      <section className="market-final"><div><span>از همین امروز شروع کنید</span><h2>نوبت‌دهی منظم‌تر، با هومانا</h2><p>{trial} را برای مجموعه خود شروع کنید.</p></div><button type="button" className="market-button light" onClick={() => onStartFree('SOLO')}>ساخت حساب رایگان ←</button></section>
    </main>
    <footer className="market-footer"><span>هومانا · مدیریت هوشمند مطب و کلینیک</span><button type="button" onClick={onBackToLogin}>ورود به حساب</button></footer>
  </div>;
}
