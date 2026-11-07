import { useState, type FormEvent, type JSX } from 'react';
import { BrandMark, type SessionProfile } from './LoginPage';

export interface RegisterPageProps {
  readonly onAuthenticated: (profile: SessionProfile) => void;
  readonly onBackToLogin?: (() => void) | undefined;
  readonly initialPracticeType?: 'SOLO' | 'CLINIC';
}
type Step = 'mobile' | 'identity' | 'contact';
function latinDigits(raw: string): string {
  return raw.replace(/[۰-۹٠-٩]/g, (digit) => String('۰۱۲۳۴۵۶۷۸۹'.includes(digit) ? '۰۱۲۳۴۵۶۷۸۹'.indexOf(digit) : '٠١٢٣٤٥٦٧٨٩'.indexOf(digit)));
}
export function normaliseMobile(raw: string): string | undefined {
  const trimmed = latinDigits(raw).replace(/[\s()-]/g, '');
  const normalised = trimmed.startsWith('+98') ? `0${trimmed.slice(3)}` : trimmed;
  return /^09\d{9}$/.test(normalised) ? normalised : undefined;
}
function normalizePhone(raw: string): string | undefined {
  const value = latinDigits(raw).replace(/[\s()-]/g, '');
  return /^0\d{9,10}$/.test(value) ? value : undefined;
}
export function RegisterPage({ onAuthenticated, onBackToLogin, initialPracticeType = 'SOLO' }: RegisterPageProps): JSX.Element {
  const [step, setStep] = useState<Step>('mobile');
  const [mobile, setMobile] = useState('');
  const [code, setCode] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [tenantName, setTenantName] = useState('');
  const [practiceType, setPracticeType] = useState(initialPracticeType);
  const [address, setAddress] = useState('');
  const [city, setCity] = useState('');
  const [phones, setPhones] = useState(['']);
  const [devCode, setDevCode] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [numberInUse, setNumberInUse] = useState(false);
  const [busy, setBusy] = useState(false);
  async function requestCode() {
    const value = normaliseMobile(mobile);
    if (!value) { setError('شمارهٔ موبایل مدیر باید با ۰۹ شروع شود و ۱۱ رقم باشد.'); return; }
    setBusy(true); setError(''); setNumberInUse(false);
    try {
      const response = await fetch('/auth/otp/send', { method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin', body: JSON.stringify({ mobile: value, purpose: 'SIGNUP' }) });
      if (!response.ok) { setError(response.status === 429 ? 'کد قبلی هنوز معتبر است؛ چند لحظه بعد دوباره امتحان کنید.' : 'ارسال کد ممکن نشد؛ دوباره امتحان کنید.'); return; }
      const body = await response.json() as { devCode?: string };
      setDevCode(body.devCode ?? null); setStep('identity');
    } catch { setError('ارتباط با سرور برقرار نشد.'); } finally { setBusy(false); }
  }
  async function verifySignup() {
    setBusy(true); setError(''); setNumberInUse(false);
    try {
      const response = await fetch('/auth/otp/verify-signup', { method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin', body: JSON.stringify({ mobile: normaliseMobile(mobile), code }) });
      if (response.status === 409) { setNumberInUse(true); setError('این شماره از قبل حساب دارد؛ وارد شوید یا شماره دیگری وارد کنید.'); return; }
      if (!response.ok) { setError(response.status === 429 ? 'تلاش‌های ناموفق زیاد بوده است؛ چند دقیقه بعد دوباره امتحان کنید.' : 'کد تأیید نامعتبر یا منقضی شده است؛ کد را بررسی کنید یا دوباره کد بگیرید.'); return; }
      setStep('contact');
    } catch { setError('ارتباط با سرور برقرار نشد.'); } finally { setBusy(false); }
  }
  async function createAccount() {
    const normalizedPhones = phones.map(normalizePhone);
    if (!address.trim() || !city.trim()) { setError('شهر و آدرس مجموعه را کامل کنید.'); return; }
    if (normalizedPhones.some((phone) => !phone)) { setError('حداقل یک شماره تلفن معتبر مجموعه وارد کنید.'); return; }
    setBusy(true); setError('');
    try {
      const response = await fetch('/auth/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin', body: JSON.stringify({ mobile: normaliseMobile(mobile), code, displayName: displayName.trim(), tenantName: tenantName.trim(), practiceType, address: address.trim(), city: city.trim(), contactPhones: normalizedPhones }) });
      if (!response.ok) {
        if (response.status === 401) { setStep('identity'); setError('کد تأیید منقضی شده است؛ دوباره کد بگیرید. اطلاعات مجموعه حفظ شده است.'); }
        else if (response.status === 409) { setNumberInUse(true); setError('این شماره اکنون حساب دارد؛ وارد شوید یا شماره دیگری وارد کنید.'); }
        else setError(response.status === 429 ? 'تلاش‌های ناموفق زیاد بوده است؛ چند دقیقه بعد دوباره امتحان کنید.' : 'ثبت‌نام انجام نشد؛ اطلاعات را بررسی کنید.');
        return;
      }
      onAuthenticated(await response.json() as SessionProfile);
    } catch { setError('ارتباط با سرور برقرار نشد.'); } finally { setBusy(false); }
  }
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setError('');
    if (step === 'mobile') { void requestCode(); return; }
    if (step === 'identity') {
      if (!/^\d{5}$/.test(code)) { setError('کد تأیید پنج‌رقمی پیامک‌شده را وارد کنید.'); return; }
      if (!displayName.trim() || !tenantName.trim()) { setError('نام مالک و نام مجموعه را کامل کنید.'); return; }
      void verifySignup(); return;
    }
    void createAccount();
  }
  return <div className="auth-shell"><div className="glow glow-teal" /><div className="glow glow-amber" />
    <main className="auth-wrap"><form className="auth-card neu-sm" onSubmit={submit}>
      <header className="brand"><div className="beat-host"><BrandMark /></div><p className="brand-fa">شروع با هومانا</p><p className="brand-sub">ساخت حساب رایگان · مرحله {step === 'mobile' ? '۱' : step === 'identity' ? '۲' : '۳'} از ۳</p></header>
      {error && <p className="alert" role="alert">{error}</p>}
      {numberInUse && <div><button type="button" className="link-btn" onClick={onBackToLogin}>ورود به حساب</button>{' · '}<button type="button" className="link-btn" onClick={() => { setNumberInUse(false); setError(''); setCode(''); setStep('mobile'); }}>تغییر شماره موبایل</button></div>}
      <div className="fields">
        {step === 'mobile' && <><div className="field"><label className="field-label" htmlFor="register-mobile">شمارهٔ موبایل مدیر مجموعه</label><div className="field-wrap neu-in fld"><input id="register-mobile" className="field-input ltr" type="tel" value={mobile} onChange={(e) => setMobile(e.target.value)} autoComplete="tel" dir="ltr" placeholder="09123456789" /></div></div><p className="auth-note">کد تأیید به شماره مدیر پیامک می‌شود.</p></>}
        {step === 'identity' && <>
          <div className="field"><label className="field-label" htmlFor="register-code">کد تأیید پیامک‌شده</label><div className="field-wrap neu-in fld"><input id="register-code" className="field-input ltr" value={code} onChange={(e) => setCode(latinDigits(e.target.value).replace(/\D/g, '').slice(0, 5))} inputMode="numeric" autoComplete="one-time-code" dir="ltr" /></div>{devCode && <p className="auth-note">کد آزمایشی (فقط محیط توسعه): {devCode}</p>}</div>
          <div className="field"><label className="field-label" htmlFor="register-name">نام و نام خانوادگی مالک</label><div className="field-wrap neu-in fld"><input id="register-name" className="field-input" value={displayName} onChange={(e) => setDisplayName(e.target.value)} autoComplete="name" maxLength={200} /></div></div>
          <div className="field"><label className="field-label" htmlFor="register-type">نوع پکیج</label><div className="field-wrap neu-in fld"><select id="register-type" className="field-input" value={practiceType} onChange={(e) => setPracticeType(e.target.value as 'SOLO' | 'CLINIC')}><option value="SOLO">مطب (یک پزشک)</option><option value="CLINIC">کلینیک (چند پزشک)</option></select></div></div>
          <div className="field"><label className="field-label" htmlFor="register-clinic">نام مجموعه</label><div className="field-wrap neu-in fld"><input id="register-clinic" className="field-input" value={tenantName} onChange={(e) => setTenantName(e.target.value)} autoComplete="organization" maxLength={200} /></div></div>
          <button type="button" className="link-btn" disabled={busy} onClick={() => void requestCode()}>ارسال دوبارهٔ کد</button>
        </>}
        {step === 'contact' && <>
          <div className="field"><label className="field-label" htmlFor="register-city">شهر مجموعه</label><div className="field-wrap neu-in fld"><input id="register-city" className="field-input" value={city} onChange={(e) => setCity(e.target.value)} autoComplete="address-level2" maxLength={120} /></div></div>
          <div className="field"><label className="field-label" htmlFor="register-address">آدرس مجموعه</label><div className="field-wrap neu-in fld"><textarea id="register-address" className="field-input field-input-area" value={address} onChange={(e) => setAddress(e.target.value)} autoComplete="street-address" maxLength={500} rows={2} /></div></div>
          {phones.map((phone, index) => <div className="field" key={index}><label className="field-label" htmlFor={`register-phone-${index}`}>شماره تلفن مجموعه {index + 1}</label><div className="field-wrap neu-in fld"><input id={`register-phone-${index}`} className="field-input ltr" type="tel" dir="ltr" placeholder="02112345678" value={phone} onChange={(e) => setPhones(phones.map((p, i) => i === index ? e.target.value : p))} /></div>{index > 0 && <button type="button" className="link-btn" onClick={() => setPhones(phones.filter((_, i) => i !== index))}>حذف شماره</button>}</div>)}
          {phones.length < 5 && <button type="button" className="link-btn" onClick={() => setPhones([...phones, ''])}>+ افزودن شماره تلفن دیگر</button>}
        </>}
      </div>
      <button className="btn-cta cta" type="submit" disabled={busy}>{busy ? 'لطفاً صبر کنید…' : step === 'mobile' ? 'دریافت کد تأیید' : step === 'identity' ? 'ادامه' : 'ساخت حساب و شروع رایگان'}</button>
      {step !== 'mobile' && <button type="button" className="link-btn" onClick={() => { setError(''); setStep(step === 'identity' ? 'mobile' : 'identity'); }}>بازگشت به مرحله قبل</button>}
      <p className="auth-note">دوره آزمایشی رایگان · بدون کارت بانکی</p>
    </form><p className="footer-note">حساب دارید؟ <button type="button" className="link-btn" onClick={onBackToLogin}>ورود به پنل</button></p></main>
  </div>;
}
