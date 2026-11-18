import { useEffect, useMemo, useRef, useState, type JSX } from 'react';
import './appointments.css';

type ClientMatch = { id: string; firstName: string; lastName: string; mobile: string };
type Doctor = { id: string; name: string };
type Service = { id: string; title: string; length: number };
type Slot = { utc: string; time: string; seatsLeft: number };
type Booking = { uid: string; title: string; serviceId: string; start: string; status: string; patientName: string; mobile: string; doctorId: string; doctorName: string };
type View = 'day' | 'week' | 'month';
type CalendarProps = { date: string; onSelect: (date: string) => void; onNavigate?: (date: string) => void; displayMonth?: string; available?: Set<string>; restrict?: boolean; selected?: boolean };

const dayMs = 86400000;
const persianDate = new Intl.DateTimeFormat('en-u-ca-persian-nu-latn', { timeZone: 'Asia/Tehran', year: 'numeric', month: 'numeric', day: 'numeric' });
const fullDay = new Intl.DateTimeFormat('fa-IR', { timeZone: 'Asia/Tehran', weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
const monthLabel = new Intl.DateTimeFormat('fa-IR', { timeZone: 'Asia/Tehran', month: 'long', year: 'numeric' });
const timeLabel = new Intl.DateTimeFormat('fa-IR', { timeZone: 'Asia/Tehran', hour: '2-digit', minute: '2-digit' });
function dateKey(date: Date): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tehran', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(date);
  const part = (type: string) => parts.find((item) => item.type === type)?.value ?? '';
  return `${part('year')}-${part('month')}-${part('day')}`;
}
function today(): string { return dateKey(new Date()); }
function noon(date: string): Date { return new Date(`${date}T12:00:00+03:30`); }
function shift(date: string, days: number): string { return dateKey(new Date(noon(date).getTime() + days * dayMs)); }
function persianDay(date: string): number { return Number(persianDate.formatToParts(noon(date)).find((part) => part.type === 'day')?.value); }
function monthStart(date: string): string { return shift(date, 1 - persianDay(date)); }
function monthEnd(date: string): string { return monthStart(shift(monthStart(date), 32)); }
function weekStart(date: string): string { return shift(date, -((noon(date).getUTCDay() + 1) % 7)); }
function interval(date: string, view: View): { start: string; end: string } {
  const first = view === 'month' ? monthStart(date) : view === 'week' ? weekStart(date) : date;
  const last = view === 'month' ? monthEnd(date) : shift(first, view === 'week' ? 7 : 1);
  return { start: new Date(`${first}T00:00:00+03:30`).toISOString(), end: new Date(`${last}T00:00:00+03:30`).toISOString() };
}
function normalizeDigits(value: string): string { return value.replace(/[۰-۹٠-٩]/g, (digit) => String('۰۱۲۳۴۵۶۷۸۹'.includes(digit) ? '۰۱۲۳۴۵۶۷۸۹'.indexOf(digit) : '٠١٢٣٤٥٦٧٨٩'.indexOf(digit))); }
async function request<T>(path: string, body?: unknown, key?: string): Promise<T> {
  const response = await fetch(`/tenant/scheduling${path}`, { credentials: 'same-origin', ...(body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json', ...(key ? { 'idempotency-key': key } : {}) }, body: JSON.stringify(body) }) });
  if (!response.ok) {
    if (response.status === 401) throw new Error('نشست شما پایان یافته است؛ دوباره وارد شوید.');
    if (response.status === 403) throw new Error('دسترسی به نوبت‌دهی ممکن نیست؛ اشتراک و دسترسی خود را بررسی کنید.');
    if (response.status === 503) throw new Error('موتور نوبت‌دهی در دسترس نیست. دوباره تلاش کنید.');
    if (response.status === 409) { const data = await response.json().catch(() => null) as { error?: { details?: { code?: string } } } | null; if (data?.error?.details?.code === 'CLIENT_AMBIGUOUS') throw new Error('چند پرونده با این نام و شماره وجود دارد؛ به مرحله قبل برگردید و پرونده درست را انتخاب کنید.'); }
    if (response.status === 409 || response.status === 422) throw new Error('زمان انتخابی قابل رزرو نیست یا اطلاعات معتبر نیست. ساعت‌های آزاد را دوباره بررسی کنید.');
    throw new Error('درخواست انجام نشد. دوباره تلاش کنید.');
  }
  return response.json() as Promise<T>;
}

function Calendar({ date, onSelect, onNavigate, displayMonth, available, restrict = false, selected = true }: CalendarProps): JSX.Element {
  const [display, setDisplay] = useState(date);
  useEffect(() => setDisplay(displayMonth ?? date), [date, displayMonth]);
  const first = monthStart(display), last = monthEnd(display);
  const offset = (noon(first).getUTCDay() + 1) % 7;
  const days: string[] = [];
  for (let current = first; current < last; current = shift(current, 1)) days.push(current);
  return <div className="appt-calendar" aria-label="تقویم شمسی">
    <div className="appt-calendar-head"><button type="button" aria-label="ماه قبل" onClick={() => { const value = shift(first, -1); setDisplay(value); onNavigate?.(value); }}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m9 5 7 7-7 7" /></svg></button><strong>{monthLabel.format(noon(display))}</strong><button type="button" aria-label="ماه بعد" onClick={() => { setDisplay(last); onNavigate?.(last); }}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m15 5-7 7 7 7" /></svg></button></div>
    <div className="appt-calendar-grid">{['ش', 'ی', 'د', 'س', 'چ', 'پ', 'ج'].map((day, index) => <span className="appt-weekday" key={index}>{day}</span>)}
      {Array.from({ length: offset }, (_, index) => <span key={`empty-${index}`} />)}
      {days.map((day) => <button type="button" key={day} aria-label={fullDay.format(noon(day))} aria-pressed={selected && day === date} disabled={restrict && (day < today() || !available?.has(day))} onClick={() => onSelect(day)} className={`${day === today() ? 'is-today' : ''} ${available?.has(day) ? 'has-slots' : ''}`}><span>{persianDay(day).toLocaleString('fa-IR')}</span>{available?.has(day) && <i aria-hidden="true" />}</button>)}
    </div>
    {restrict && <p className="appt-calendar-hint">روزهای دارای نقطه، زمان آزاد دارند.</p>}
  </div>;
}

export function AppointmentsPage({ openRequest = 0 }: { openRequest?: number }): JSX.Element {
  const [doctors, setDoctors] = useState<Doctor[]>([]);
  const [catalog, setCatalog] = useState<Record<string, Service[]>>({});
  const [doctorFilter, setDoctorFilter] = useState('');
  const [serviceFilter, setServiceFilter] = useState('');
  const [date, setDate] = useState(today);
  const [calendarMonth, setCalendarMonth] = useState(today);
  const [monthCount, setMonthCount] = useState<number | null>(null);
  const [view, setView] = useState<View>('day');
  const [bookings, setBookings] = useState<Booking[]>([]);
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [refresh, setRefresh] = useState(0);
  const [step, setStep] = useState(0);
  const [mobile, setMobile] = useState('');
  const [clientMatches, setClientMatches] = useState<ClientMatch[]>([]);
  const [clientId, setClientId] = useState('');
  const [lookupError, setLookupError] = useState('');
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [formDoctor, setFormDoctor] = useState('');
  const [formService, setFormService] = useState('');
  const [formDate, setFormDate] = useState(today);
  const [formMonth, setFormMonth] = useState(today);
  const [formDayPicked, setFormDayPicked] = useState(false);
  const [slots, setSlots] = useState<Slot[]>([]);
  const [slot, setSlot] = useState('');
  const [loadingSlots, setLoadingSlots] = useState(false);
  const [slotError, setSlotError] = useState('');
  const [saving, setSaving] = useState(false);
  const attempt = useRef<{ fingerprint: string; key: string } | null>(null);
  const slotSequence = useRef(0);

  useEffect(() => { if (openRequest > 0) { const initial = today(); setFormDate(initial); setFormMonth(monthStart(initial)); setFormDayPicked(false); setStep(1); setMessage(''); } }, [openRequest]);
  useEffect(() => {
    let live = true;
    void request<{ doctors: Doctor[] }>('/doctors').then(async (result) => {
      const details = await Promise.all(result.doctors.map(async (doctor) => ({ id: doctor.id, ...(await request<{ services: Service[] }>(`/doctors/${doctor.id}`)) })));
      if (!live) return;
      setDoctors(result.doctors); setCatalog(Object.fromEntries(details.map((item) => [item.id, item.services]))); setFormDoctor((current) => current || result.doctors[0]?.id || ''); setLoading(false);
    }).catch((reason: unknown) => { if (live) { setError(reason instanceof Error ? reason.message : 'خطا در دریافت پزشکان.'); setLoading(false); } });
    return () => { live = false; };
  }, [refresh]);
  useEffect(() => {
    const onFocus = () => setRefresh((value) => value + 1);
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, []);
  useEffect(() => {
    if (!doctors.length) return;
    let live = true;
    const selected = doctorFilter ? doctors.filter((doctor) => doctor.id === doctorFilter) : doctors;
    const query = new URLSearchParams(interval(date, view));
    setLoading(true); setError('');
    void Promise.all(selected.map(async (doctor) => {
      const result = await request<{ bookings: Omit<Booking, 'doctorId' | 'doctorName'>[] }>(`/doctors/${doctor.id}/bookings?${query.toString()}`);
      return result.bookings.map((item) => ({ ...item, doctorId: doctor.id, doctorName: doctor.name }));
    })).then((result) => { if (live) { setBookings(result.flat().sort((a, b) => a.start.localeCompare(b.start))); setLoading(false); } })
      .catch((reason: unknown) => { if (live) { setBookings([]); setError(reason instanceof Error ? reason.message : 'خطا در دریافت نوبت‌ها.'); setLoading(false); } });
    return () => { live = false; };
  }, [doctors, doctorFilter, date, view, refresh]);
  useEffect(() => {
    if (!doctors.length) return;
    let live = true;
    const selected = doctorFilter ? doctors.filter((doctor) => doctor.id === doctorFilter) : doctors;
    const query = new URLSearchParams(interval(calendarMonth, 'month'));
    setMonthCount(null);
    void Promise.all(selected.map(async (doctor) => (await request<{ bookings: Booking[] }>(`/doctors/${doctor.id}/bookings?${query.toString()}`)).bookings))
      .then((results) => { if (live) setMonthCount(results.flat().filter((booking) => booking.status !== 'CANCELLED' && (!serviceFilter || booking.title === serviceFilter)).length); })
      .catch(() => { if (live) setMonthCount(null); });
    return () => { live = false; };
  }, [doctors, doctorFilter, serviceFilter, calendarMonth, refresh]);
  useEffect(() => {
    const sequence = ++slotSequence.current;
    setSlots([]); setSlot(''); setSlotError('');
    if (step !== 3 || !formDoctor || !formService) { setLoadingSlots(false); return; }
    setLoadingSlots(true);
    const query = new URLSearchParams({ serviceId: formService, ...interval(formMonth, 'month') });
    void request<{ slots: Record<string, Slot[]> }>(`/doctors/${formDoctor}/slots?${query.toString()}`).then((result) => {
      if (slotSequence.current === sequence) { setSlots(Object.values(result.slots).flat()); setLoadingSlots(false); }
    }).catch((reason: unknown) => { if (slotSequence.current === sequence) { setSlotError(reason instanceof Error ? reason.message : 'خطا در دریافت زمان‌ها.'); setLoadingSlots(false); } });
    return () => { slotSequence.current++; };
  }, [step, formDoctor, formService, formMonth, refresh]);

  const serviceNames = useMemo(() => [...new Set((doctorFilter ? catalog[doctorFilter] ?? [] : Object.values(catalog).flat()).map((item) => item.title))].sort((a, b) => a.localeCompare(b, 'fa')), [catalog, doctorFilter]);
  const visible = bookings.filter((item) => (!serviceFilter || item.title === serviceFilter) && `${item.patientName} ${item.mobile} ${item.title} ${item.doctorName}`.includes(normalizeDigits(search.trim())));
  const availableDays = useMemo(() => new Set(slots.map((item) => dateKey(new Date(item.utc)))), [slots]);
  const daySlots = slots.filter((item) => dateKey(new Date(item.utc)) === formDate);
  const fromDate = dateKey(new Date(interval(date, view).start));
  const toDate = shift(dateKey(new Date(interval(date, view).end)), -1);

  function closeForm() { if (saving) return; setStep(0); setMobile(''); setFirstName(''); setLastName(''); setClientId(''); setClientMatches([]); setLookupError(''); setFormService(''); setSlot(''); setSlotError(''); setFormMonth(monthStart(today())); setFormDate(today()); setFormDayPicked(false); attempt.current = null; }
  async function save() {
    if (saving || !slot || !formDoctor || !formService) return;
    const body = { serviceId: formService, start: slot, name: `${firstName.trim()} ${lastName.trim()}`, firstName: firstName.trim(), lastName: lastName.trim(), mobile, ...(clientId ? { clientId } : {}) };
    const fingerprint = JSON.stringify([formDoctor, body]);
    if (attempt.current?.fingerprint !== fingerprint) attempt.current = { fingerprint, key: crypto.randomUUID() };
    setSaving(true); setError(''); setSlotError('');
    try { await request(`/doctors/${formDoctor}/bookings`, body, attempt.current.key); attempt.current = null; setStep(0); setFirstName(''); setLastName(''); setMobile(''); setClientId(''); setClientMatches([]); setDate(formDate); setCalendarMonth(monthStart(formDate)); setView('day'); setMessage('نوبت با موفقیت ثبت شد.'); setRefresh((value) => value + 1); }
    catch (reason) { setSlotError(reason instanceof Error ? reason.message : 'ثبت نوبت انجام نشد.'); }
    finally { setSaving(false); }
  }
  async function nextStep() {
    if (step !== 1) { setStep(step + 1); return; }
    setSaving(true); setLookupError(''); setClientId(''); setClientMatches([]);
    try { const response = await fetch('/tenant/clients?' + new URLSearchParams({ q: mobile }).toString(), { credentials: 'same-origin' }); if (!response.ok) throw new Error(); const data = await response.json() as { clients: ClientMatch[] }; setClientMatches(data.clients.filter((item) => item.mobile === mobile)); }
    catch { setLookupError('جستجوی پرونده انجام نشد؛ هنگام ثبت نوبت، اطلاعات دوباره بررسی می‌شوند.'); }
    finally { setSaving(false); setStep(2); }
  }
  async function cancel(booking: Booking) {
    if (saving || !window.confirm(`نوبت ${booking.patientName || 'بیمار'} در ساعت ${timeLabel.format(new Date(booking.start))} لغو شود؟`)) return;
    setSaving(true); setError('');
    try { await request(`/doctors/${booking.doctorId}/bookings/${encodeURIComponent(booking.uid)}/cancel`, {}, crypto.randomUUID()); setMessage('نوبت لغو شد.'); setRefresh((value) => value + 1); }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'لغو نوبت انجام نشد.'); }
    finally { setSaving(false); }
  }

  return <div className="appointments" dir="rtl">
    <div className="appointments-heading"><div><span className="appointments-eyebrow">مدیریت پذیرش</span><h1 className="pnl-page-title">نوبت‌ها</h1><p className="pnl-page-sub">برنامه پزشکان و نوبت‌های بیماران در یک نگاه</p></div><button className="appointments-primary" type="button" disabled={!doctors.length || saving} onClick={() => { const initial = date < today() ? today() : date; setFormDate(initial); setFormMonth(monthStart(initial)); setFormDayPicked(false); setStep(1); setMessage(''); setError(''); }}>＋ نوبت جدید</button></div>
    {error && <div className="appointments-alert error" role="alert">{error}</div>}{message && <div className="appointments-alert success" role="status">{message}</div>}
    {!loading && !doctors.length && !error && <div className="appointments-empty"><strong>هنوز پزشکی اضافه نشده است</strong><p>ابتدا پزشک و برنامه کاری او را تعریف کنید.</p><a href="#/doctors">رفتن به تنظیمات پزشکان ←</a></div>}
    {doctors.length > 0 && <>
      {step > 0 && <section className="appointments-create appt-wizard" aria-labelledby="new-appointment-title">
        <div className="appointments-section-head"><div><span className="appointments-kicker">پذیرش بیمار · مرحله {step.toLocaleString('fa-IR')} از ۳</span><h2 id="new-appointment-title">ثبت نوبت جدید</h2></div><button type="button" className="appointments-close" onClick={closeForm} aria-label="بستن فرم ثبت نوبت" disabled={saving}>×</button></div>
        <div className="appt-progress" aria-label={`مرحله ${step} از ۳`}><span className="active">۱ <em>شماره تماس</em></span><span className={step >= 2 ? 'active' : ''}>۲ <em>مشخصات بیمار</em></span><span className={step >= 3 ? 'active' : ''}>۳ <em>زمان نوبت</em></span></div>
        {step === 1 && <div className="appt-step"><h3>شماره موبایل بیمار را وارد کنید</h3><p>شماره تماس برای ثبت نوبت استفاده می‌شود.</p><label className="appt-field">شماره موبایل<input type="tel" autoComplete="tel" inputMode="numeric" dir="ltr" placeholder="0912 000 0000" value={mobile} onChange={(event) => { setMobile(normalizeDigits(event.target.value).replace(/[\s-]/g, '')); setFirstName(''); setLastName(''); }} maxLength={15} /></label><p className="appointments-crm-hint">در مرحله بعد، پرونده‌های دارای این شماره بررسی می‌شوند.</p></div>}
        {step === 2 && <div className="appt-step"><h3>مشخصات مراجعه‌کننده</h3>{lookupError && <p role="alert" className="appointments-field-error">{lookupError}</p>}{clientMatches.length > 0 && <label className="appt-field">انتخاب پرونده موجود<select value={clientId} onChange={(event) => { const id = event.target.value; setClientId(id); const match = clientMatches.find((item) => item.id === id); setFirstName(match?.firstName ?? ''); setLastName(match?.lastName ?? ''); }}><option value="">مراجعه‌کننده جدید</option>{clientMatches.map((item) => <option key={item.id} value={item.id}>{item.firstName} {item.lastName}</option>)}</select></label>}<p>{clientMatches.length ? 'پرونده را انتخاب کنید یا مشخصات مراجعه‌کننده جدید را وارد کنید.' : 'نام و نام خانوادگی را وارد کنید؛ پرونده با ثبت نوبت ایجاد می‌شود.'}</p><div className="appt-fields"><label className="appt-field">نام<input value={firstName} disabled={Boolean(clientId)} maxLength={40} onChange={(event) => setFirstName(event.target.value)} /></label><label className="appt-field">نام خانوادگی<input value={lastName} disabled={Boolean(clientId)} maxLength={39} onChange={(event) => setLastName(event.target.value)} /></label></div></div>}
        {step === 3 && <div className="appt-step"><h3>پزشک، خدمت و زمان نوبت</h3><p>روزهای دارای زمان آزاد در تقویم مشخص شده‌اند.</p><div className="appt-fields"><label className="appt-field">پزشک نوبت<select value={formDoctor} onChange={(event) => { setFormDoctor(event.target.value); setFormService(''); setFormDayPicked(false); setSlot(''); }}><option value="">انتخاب پزشک</option>{doctors.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label><label className="appt-field">خدمت نوبت<select value={formService} onChange={(event) => { setFormService(event.target.value); setFormDayPicked(false); setSlot(''); }}><option value="">انتخاب خدمت</option>{(catalog[formDoctor] ?? []).map((item) => <option key={item.id} value={item.id}>{item.title} · {item.length.toLocaleString('fa-IR')} دقیقه</option>)}</select></label></div>
          {formDoctor && !catalog[formDoctor]?.length && <p className="appointments-field-error">برای این پزشک خدمتی تعریف نشده است. ابتدا در بخش پزشکان و خدمات، خدمت و ساعت کاری را تنظیم کنید.</p>}
          {formService && <div className="appt-pick-time"><div><strong className="appt-pick-label">۱. انتخاب روز نوبت</strong><Calendar date={formDate} selected={formDayPicked} onNavigate={(value) => { setFormMonth(monthStart(value)); setFormDayPicked(false); setSlot(''); }} onSelect={(value) => { setFormDate(value); setFormDayPicked(true); setSlot(''); }} available={availableDays} restrict /></div><div className="appt-time-picker"><strong>۲. انتخاب ساعت {formDayPicked ? `· ${fullDay.format(noon(formDate))}` : ''}</strong>{loadingSlots ? <p className="appointments-muted">در حال دریافت روزهای آزاد…</p> : slotError ? <p className="appointments-field-error" role="alert">{slotError}</p> : !formDayPicked ? <p className="appointments-muted">ابتدا یک روز دارای زمان آزاد را از تقویم انتخاب کنید.</p> : daySlots.length ? <div className="appointments-slot-grid">{daySlots.map((item) => <button key={item.utc} type="button" aria-pressed={slot === item.utc} onClick={() => setSlot(item.utc)}><strong dir="ltr">{item.time}</strong><small>{item.seatsLeft.toLocaleString('fa-IR')} ظرفیت</small></button>)}</div> : <p className="appointments-muted">در این روز زمان آزادی وجود ندارد؛ روز دیگری را انتخاب کنید.</p>}</div></div>}
        </div>}
        <div className="appointments-form-footer"><button type="button" className="appt-secondary" disabled={saving} onClick={closeForm}>انصراف</button><div>{step > 1 && <button type="button" className="appt-secondary" disabled={saving} onClick={() => setStep(step - 1)}>مرحله قبل</button>}{step < 3 ? <button type="button" className="appointments-primary" disabled={saving || (step === 1 ? !/^09\d{9}$/.test(mobile) : !firstName.trim() || !lastName.trim())} onClick={() => void nextStep()}>ادامه ←</button> : <button type="button" className="appointments-primary" disabled={saving || !slot} onClick={() => void save()}>{saving ? 'در حال ثبت…' : 'ثبت نوبت'}</button>}</div></div>
      </section>}
      <div className="appt-layout"><main className="appt-main">
        <section className="appointments-toolbar" aria-label="فیلتر نوبت‌ها"><label className="appt-filter"><span>پزشک</span><select value={doctorFilter} onChange={(event) => { setDoctorFilter(event.target.value); setServiceFilter(''); }}><option value="">همه پزشکان</option>{doctors.map((item) => <option value={item.id} key={item.id}>{item.name}</option>)}</select></label><label className="appt-filter"><span>خدمت</span><select value={serviceFilter} onChange={(event) => setServiceFilter(event.target.value)}><option value="">همه خدمات</option>{serviceNames.map((name) => <option key={name} value={name}>{name}</option>)}</select></label><label className="appointments-search"><span aria-hidden="true">⌕</span><input type="search" placeholder="جستجوی بیمار یا شماره" aria-label="جستجوی نوبت‌ها" value={search} onChange={(event) => setSearch(event.target.value)} /></label><button type="button" className="appt-refresh" onClick={() => setRefresh((value) => value + 1)} aria-label="به‌روزرسانی نوبت‌ها" title="به‌روزرسانی نوبت‌ها">↻</button></section>
        <section className="appointments-list"><div className="appointments-list-head"><div><h2>برنامه نوبت‌ها</h2><p>{view === 'day' ? fullDay.format(noon(date)) : `${fullDay.format(noon(fromDate))} تا ${fullDay.format(noon(toDate))}`}</p></div><div className="appt-view-switch" aria-label="نوع نمایش">{([['day','روز'], ['week','هفته'], ['month','ماه']] as const).map(([key, label]) => <button key={key} type="button" aria-pressed={view === key} onClick={() => setView(key)}>{label}</button>)}</div></div>
          {loading ? <p className="appointments-list-empty">در حال دریافت نوبت‌ها…</p> : error ? <p className="appointments-list-empty">دریافت نوبت‌ها انجام نشد.</p> : !visible.length ? <div className="appointments-list-empty"><span aria-hidden="true">◷</span><strong>نوبتی پیدا نشد</strong><p>تاریخ یا فیلترها را تغییر دهید، یا نوبت جدید ثبت کنید.</p></div> : <div className="appointments-rows">{visible.map((booking) => <article className="appointments-row" key={`${booking.doctorId}-${booking.uid}`}><div className="appointments-time"><strong>{timeLabel.format(new Date(booking.start))}</strong><small>{view === 'day' ? 'ساعت' : fullDay.format(new Date(booking.start))}</small></div><div className="appointments-patient"><span className="appointments-avatar" aria-hidden="true">{booking.patientName?.trim().charAt(0) || 'ن'}</span><div><strong>{booking.patientName || 'نام ثبت نشده'}</strong><small dir="ltr">{booking.mobile || '—'}</small></div></div><div className="appointments-service"><strong>{booking.title}</strong><small>خدمت</small></div><div className="appointments-doctor"><strong>{booking.doctorName || 'نام ثبت نشده'}</strong><small>پزشک</small></div><span className={`appointments-status ${booking.status === 'CANCELLED' ? 'cancelled' : booking.status === 'PENDING' ? 'pending' : ''}`}>{booking.status === 'CANCELLED' ? 'لغو شده' : booking.status === 'PENDING' ? 'در انتظار تأیید' : booking.status === 'CONFIRMED' ? 'تأیید شده' : booking.status}</span>{booking.status !== 'CANCELLED' && <button type="button" className="appointments-cancel" disabled={saving} onClick={() => void cancel(booking)}>لغو نوبت</button>}</article>)}</div>}
        </section>
      </main><aside className="appt-calendar-panel"><div className="appt-calendar-title"><strong>تقویم نوبت‌ها</strong><button type="button" onClick={() => { const value = today(); setDate(value); setCalendarMonth(monthStart(value)); setView('day'); }}>امروز</button></div><Calendar date={date} displayMonth={calendarMonth} onNavigate={(value) => setCalendarMonth(monthStart(value))} onSelect={(value) => { setDate(value); setCalendarMonth(monthStart(value)); setView('day'); }} /><p>برای دیدن نوبت‌های هر روز، آن را در تقویم انتخاب کنید.</p><div className="appt-calendar-summary"><span>نوبت‌های این ماه{doctorFilter || serviceFilter ? ' با فیلتر فعلی' : ''}</span><strong>{monthCount === null ? '—' : monthCount.toLocaleString('fa-IR')}</strong></div></aside></div>
    </>}
  </div>;
}
