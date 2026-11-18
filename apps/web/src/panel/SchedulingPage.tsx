import { useEffect, useRef, useState, type FormEvent, type JSX } from 'react';
import './scheduling.css';

type Doctor = { id: string; name: string };
type Service = { id: string; title: string; length: number; slotInterval: number | null; seatsPerTimeSlot: number | null };
type CatalogService = { id: string; title: string; duration: number; interval: number; capacity: number; totalTomans: number; depositTomans: number | null };
type Assignment = { clinicServiceId: string; engineServiceId: string; active: boolean };
type Schedule = { isDefault: boolean; availability: { days: number[]; startTime: string; endTime: string }[] };
type Detail = { services: Service[]; schedules: Schedule[] };
type Window = { start: string; end: string };
const weekdays = [[6, 'شنبه'], [0, 'یکشنبه'], [1, 'دوشنبه'], [2, 'سه‌شنبه'], [3, 'چهارشنبه'], [4, 'پنجشنبه'], [5, 'جمعه']] as const;
type Slot = { utc: string; time: string; seatsLeft?: number };
type Booking = { uid: string; title: string; start: string; status: string };

async function api(path: string, body?: unknown, idempotencyKey?: string): Promise<unknown> {
  const result = await fetch(`/tenant/scheduling${path}`, {
    credentials: 'same-origin',
    ...(body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json', ...(idempotencyKey ? { 'idempotency-key': idempotencyKey } : {}) }, body: JSON.stringify(body) }),
  });
  if (!result.ok) {
    if (result.status === 401) throw new Error('نشست شما پایان یافته است؛ دوباره وارد شوید.');
    if (result.status === 403) {
      const data = await result.json().catch(() => null) as { error?: { code?: string } } | null;
      if (data?.error?.code === 'SUBSCRIPTION_EXPIRED') throw new Error('دوره اشتراک یا دوره آزمایشی به پایان رسیده است.');
      if (data?.error?.code === 'PRACTICE_DOCTOR_LIMIT') throw new Error('در بسته مطب فقط یک پزشک قابل تعریف است.');
      throw new Error('برای این عملیات دسترسی ندارید.');
    }
    if (result.status === 503) throw new Error('موتور نوبت‌دهی در دسترس نیست یا تنظیم نشده است.');
    throw new Error('درخواست انجام نشد؛ اطلاعات و زمان انتخاب‌شده را بررسی کنید.');
  }
  return result.json();
}

export function SchedulingPage({ mode, isOwner }: { mode: 'doctors' | 'appointments'; isOwner: boolean }): JSX.Element {
  const [doctors, setDoctors] = useState<Doctor[]>([]);
  const [catalog, setCatalog] = useState<CatalogService[]>([]);
  const [assignments, setAssignments] = useState<Assignment[]>([]);
  const [chosenServices, setChosenServices] = useState<string[]>([]);
  const [editingAssignments, setEditingAssignments] = useState(false);
  const [totalTomans, setTotalTomans] = useState(0);
  const [depositTomans, setDepositTomans] = useState('');
  const [viewService, setViewService] = useState('');
  const [practiceType, setPracticeType] = useState<'SOLO' | 'CLINIC'>('CLINIC');
  const [selected, setSelected] = useState('');
  const [detail, setDetail] = useState<Detail | null>(null);
  const [notice, setNotice] = useState('');
  const [noticeError, setNoticeError] = useState(false);
  const [name, setName] = useState('');
  const [addingDoctor, setAddingDoctor] = useState(false);
  const [editingSchedule, setEditingSchedule] = useState(false);
  const [addingService, setAddingService] = useState(false);
  const [title, setTitle] = useState('');
  const [duration, setDuration] = useState(30);
  const [interval, setInterval] = useState(30);
  const [capacity, setCapacity] = useState(1);
  const [editing, setEditing] = useState<string | null>(null);
  const [weekly, setWeekly] = useState<Record<number, Window[]>>({});
  const [service, setService] = useState('');
  const [date, setDate] = useState('');
  const [slots, setSlots] = useState<Slot[]>([]);
  const [searched, setSearched] = useState(false);
  const submitting = useRef(false);
  const bookingAttempt = useRef<{ fingerprint: string; key: string } | null>(null);
  const currentDoctor = useRef('');
  const [slot, setSlot] = useState('');
  const [patient, setPatient] = useState('');
  const [mobile, setMobile] = useState('');
  const [bookings, setBookings] = useState<Booking[]>([]);

  async function loadCatalog() {
    const data = await api('/catalog') as { services: CatalogService[] }; setCatalog(data.services);
  }
  async function loadAssignments(id: string) {
    const data = await api(`/doctors/${id}/catalog`) as { assignments: Assignment[] };
    if (currentDoctor.current === id) { setAssignments(data.assignments); setChosenServices(data.assignments.filter((item) => item.active).map((item) => item.clinicServiceId)); }
  }
  async function list() {
    const data = await api('/doctors') as { doctors: Doctor[]; practiceType?: 'SOLO' | 'CLINIC' };
    setDoctors(data.doctors);
    setPracticeType(data.practiceType ?? 'CLINIC');
    setSelected((value) => value || data.doctors[0]?.id || '');
  }
  async function load(id: string) {
    const data = await api(`/doctors/${id}`) as Detail;
    if (currentDoctor.current !== id) return;
    setDetail(data);
    const next: Record<number, Window[]> = {};
    for (const row of data.schedules.find((schedule) => schedule.isDefault)?.availability ?? []) {
      for (const day of row.days) (next[day] ??= []).push({ start: row.startTime.includes('T') ? row.startTime.slice(11, 16) : row.startTime.slice(0, 5), end: row.endTime.includes('T') ? row.endTime.slice(11, 16) : row.endTime.slice(0, 5) });
    }
    setWeekly(next);
    setService(data.services[0] ? String(data.services[0].id) : '');
    if (mode === 'appointments') {
      const result = await api(`/doctors/${id}/bookings`) as { bookings: Booking[] };
      if (currentDoctor.current === id) setBookings(result.bookings);
    }
  }
  function failure(error: unknown) { setNoticeError(true); setNotice(error instanceof Error ? error.message : 'خطایی رخ داد.'); }
  useEffect(() => { void list().catch(failure); if (mode === 'doctors') void loadCatalog().catch(failure); }, [mode]);
  useEffect(() => { currentDoctor.current = selected; if (selected) { setDetail(null); setSlots([]); setSearched(false); setEditing(null); setEditingSchedule(false); setEditingAssignments(false); setAddingService(false); setAssignments([]); if (mode === 'doctors') void loadAssignments(selected).catch(failure); void load(selected).catch(failure); } }, [selected, mode]);
  async function submit(event: FormEvent, action: () => Promise<void>) {
    event.preventDefault();
    if (submitting.current) return;
    submitting.current = true; setNotice(''); setNoticeError(false);
    try { await action(); } catch (error) { failure(error); } finally { submitting.current = false; }
  }

  return <div className={`pnl-scheduling ${mode === 'doctors' ? 'doctor-settings' : ''}`} dir="rtl">
    <div className="doctor-page-heading"><div><h1 className="pnl-page-title">{mode === 'doctors' ? 'پزشکان و خدمات' : 'نوبت‌ها'}</h1><p className="pnl-page-sub">برنامه هفتگی و خدمات هر پزشک را مدیریت کنید.</p></div>{mode === 'doctors' && isOwner && (practiceType !== 'SOLO' || doctors.length === 0) && <button type="button" className="cta doctor-heading-button" onClick={() => { setChosenServices([]); setAddingDoctor(true); }}>+ افزودن پزشک</button>}</div>
    {notice && <p className={`pnl-notice ${noticeError ? 'doctor-notice-error' : 'doctor-notice-success'}`} role={noticeError ? 'alert' : 'status'}>{notice}</p>}
    {mode === 'doctors' && addingDoctor && <form className="pnl-card neu doctor-create" onSubmit={(e) => void submit(e, async () => { const created = await api('/doctors', { name }) as { doctor: Doctor }; setName(''); setAddingDoctor(false); await list(); currentDoctor.current = created.doctor.id; setSelected(created.doctor.id); try { for (const id of chosenServices) await api(`/doctors/${created.doctor.id}/catalog/${id}`, { active: true }); await loadAssignments(created.doctor.id); await load(created.doctor.id); } catch { throw new Error('پزشک ساخته شد، اما تخصیص همه خدمات کامل نشد. خدمات پزشک را بررسی و دوباره ذخیره کنید.'); } setNotice('پزشک اضافه شد.'); })}>
      <h2>افزودن پزشک</h2><label>نام پزشک <input required maxLength={200} value={name} onChange={(e) => setName(e.target.value)} /></label>{catalog.length > 0 && <fieldset><legend>خدمات پزشک</legend>{catalog.map((item) => <label key={item.id}><input type="checkbox" checked={chosenServices.includes(item.id)} onChange={(event) => setChosenServices((current) => event.target.checked ? [...current, item.id] : current.filter((id) => id !== item.id))} /> {item.title}</label>)}</fieldset>}<div className="doctor-create-actions"><button className="cta" type="submit">ثبت پزشک</button><button type="button" className="doctor-secondary" onClick={() => { setAddingDoctor(false); setName(''); }}>انصراف</button></div>
    </form>}
    {mode === 'doctors' && <div className="doctor-layout"><aside className="doctor-list pnl-card neu"><div className="doctor-list-heading"><h2>پزشکان</h2><span>{doctors.length.toLocaleString('fa-IR')} پزشک</span></div>{doctors.length ? doctors.map((doctor) => <button key={doctor.id} type="button" className="doctor-list-item" aria-pressed={selected === doctor.id} onClick={() => { currentDoctor.current = doctor.id; setSelected(doctor.id); }}><span className="doctor-avatar">{doctor.name.trim().charAt(0)}</span><span><strong>{doctor.name}</strong><small>مشاهده برنامه و خدمات</small></span><b aria-hidden="true">‹</b></button>) : <p>هنوز پزشکی اضافه نشده است.</p>}</aside><main className="doctor-detail">
    {selected && detail && <>
      {!editingSchedule && <section className="pnl-card neu doctor-overview"><div className="doctor-section-head"><div><h2>{doctors.find((doctor) => doctor.id === selected)?.name}</h2><p>برنامه کاری و خدمات پزشک</p></div>{isOwner && <button type="button" className="doctor-secondary" onClick={() => setEditingSchedule(true)}>ویرایش برنامه</button>}</div><h3>برنامه هفتگی</h3><div className="doctor-overview-days">{weekdays.map(([day, label]) => <div key={day}><strong>{label}</strong><span dir="ltr">{weekly[day]?.length ? weekly[day].map((window) => window.start + ' – ' + window.end).join(' / ') : 'تعطیل'}</span></div>)}</div><div className="doctor-section-head"><h3>خدمات پزشک</h3>{isOwner && <button type="button" className="doctor-secondary" onClick={() => { setChosenServices(assignments.filter((entry) => entry.active).map((entry) => entry.clinicServiceId)); setEditingAssignments(true); }}>انتخاب خدمات</button>}</div><div className="doctor-service-tags">{detail.services.length ? detail.services.map((item) => <span key={item.id}>{item.title}</span>) : <p>خدمتی برای این پزشک تعریف نشده است.</p>}</div></section>}
      {editingAssignments && <form className="pnl-card neu" onSubmit={(e) => void submit(e, async () => { for (const item of catalog) { const active = chosenServices.includes(item.id); if (active !== Boolean(assignments.find((entry) => entry.clinicServiceId === item.id)?.active)) await api(`/doctors/${selected}/catalog/${item.id}`, { active }); } await Promise.all([load(selected), loadAssignments(selected)]); setEditingAssignments(false); setNotice('خدمات پزشک ذخیره شد.'); })}><h2>انتخاب خدمات پزشک</h2><p>خدماتی را که این پزشک انجام می‌دهد انتخاب کنید.</p><fieldset>{catalog.length ? catalog.map((item) => <label key={item.id}><input type="checkbox" checked={chosenServices.includes(item.id)} onChange={(event) => setChosenServices((current) => event.target.checked ? [...current, item.id] : current.filter((id) => id !== item.id))} /> {item.title}</label>) : <p>ابتدا یک خدمت در فهرست خدمات کلینیک تعریف کنید.</p>}</fieldset><button className="cta" type="submit">ذخیره خدمات پزشک</button> <button className="doctor-secondary" type="button" onClick={() => { setEditingAssignments(false); setChosenServices(assignments.filter((entry) => entry.active).map((entry) => entry.clinicServiceId)); }}>انصراف</button></form>}
      {editingSchedule && isOwner && <form className="pnl-card neu doctor-week" onSubmit={(e) => void submit(e, async () => {
        const availability = weekdays.flatMap(([day]) => (weekly[day] ?? []).map((window) => ({ days: [day], startTime: window.start, endTime: window.end })));
        for (const [day, label] of weekdays) {
          const windows = [...(weekly[day] ?? [])].sort((a, b) => a.start.localeCompare(b.start));
          if (windows.some((window, index) => !window.start || !window.end || window.start >= window.end || (index > 0 && windows[index - 1]!.end > window.start))) throw new Error(`بازه‌های ${label} را بررسی کنید؛ ساعت پایان باید بعد از شروع باشد و بازه‌ها هم‌پوشانی نداشته باشند.`);
        }
        await api(`/doctors/${selected}/schedule`, { availability }); await load(selected); setEditingSchedule(false); setNotice('برنامه کاری پزشک ذخیره شد.');
      })}>
        <div className="doctor-section-head"><div><h2>برنامه کاری هفتگی پزشک</h2><p>برای هر روز ساعت حضور پزشک را مشخص کنید. این برنامه مستقل از ساعت کاری کلینیک است.</p></div><span className="doctor-badge">{doctors.find((doctor) => doctor.id === selected)?.name}</span></div>
        <div className="doctor-week-list">{weekdays.map(([day, label]) => <div className="doctor-day" key={day}>
          <div className="doctor-day-name"><label><input type="checkbox" aria-label={`فعال کردن ${label}`} checked={Boolean(weekly[day]?.length)} onChange={(event) => setWeekly((current) => ({ ...current, [day]: event.target.checked ? [{ start: '09:00', end: '17:00' }] : [] }))} /><strong>{label}</strong></label><small>{weekly[day]?.length ? 'فعال' : 'تعطیل'}</small></div>
          <div className="doctor-day-windows">{(weekly[day] ?? []).map((window, index) => <div className="doctor-window" key={index}>
            <label>از <input aria-label={`شروع ${label} بازه ${index + 1}`} type="time" required value={window.start} onChange={(event) => setWeekly((current) => ({ ...current, [day]: (current[day] ?? []).map((item, i) => i === index ? { ...item, start: event.target.value } : item) }))} /></label>
            <label>تا <input aria-label={`پایان ${label} بازه ${index + 1}`} type="time" required value={window.end} onChange={(event) => setWeekly((current) => ({ ...current, [day]: (current[day] ?? []).map((item, i) => i === index ? { ...item, end: event.target.value } : item) }))} /></label>
            <button type="button" className="doctor-remove" aria-label={`حذف بازه ${index + 1} ${label}`} onClick={() => setWeekly((current) => ({ ...current, [day]: (current[day] ?? []).filter((_, i) => i !== index) }))}>حذف</button>
          </div>)}{!weekly[day]?.length && <span className="doctor-closed">برای این روز ساعتی تعیین نشده است</span>}</div>
          {Boolean(weekly[day]?.length) && <button type="button" className="doctor-add-window" onClick={() => setWeekly((current) => ({ ...current, [day]: [...(current[day] ?? []), { start: '09:00', end: '17:00' }] }))}>+ افزودن بازه</button>}
        </div>)}</div>
        <div className="doctor-actions"><span>تغییرات پس از ذخیره در نوبت‌دهی اعمال می‌شوند.</span><div><button type="button" className="doctor-secondary" onClick={() => { setEditingSchedule(false); void load(selected).catch(failure); }}>انصراف</button> <button type="submit" className="cta">ذخیره برنامه پزشک</button></div></div>
      </form>}
    </>}
    {!selected && <section className="pnl-card neu doctor-overview"><p>برای مشاهده برنامه، یک پزشک انتخاب کنید.</p></section>}
    </main></div>}
    {mode === 'appointments' && <section className="pnl-card neu"><label>پزشک <select value={selected} onChange={(e) => { currentDoctor.current = e.target.value; setSelected(e.target.value); }}><option value="">انتخاب پزشک</option>{doctors.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}</select></label></section>}
    {mode === 'doctors' && <>
      {isOwner && addingService && <form className="pnl-card neu" onSubmit={(e) => void submit(e, async () => { const body = { title, duration, interval, capacity, totalTomans, depositTomans: depositTomans === '' ? null : Number(depositTomans) }; await api(`/catalog${editing === null ? '' : `/${editing}`}`, body); setTitle(''); setEditing(null); setAddingService(false); await loadCatalog(); if (selected) await load(selected); setNotice('خدمت ذخیره شد.'); })}>
        <div className="doctor-section-head"><div><h2>{editing === null ? 'خدمت جدید' : 'ویرایش خدمت'}</h2><p>خدمت در فهرست کلینیک ثبت می‌شود.</p></div></div>
        <div className="doctor-service-fields"><label>نام خدمت <input required maxLength={120} value={title} onChange={(e) => setTitle(e.target.value)} /></label><label>مدت (دقیقه) <input type="number" min="5" max="480" required value={duration} onChange={(e) => setDuration(Number(e.target.value))} /></label><label>گام نوبت (دقیقه) <input type="number" min="5" max="480" required value={interval} onChange={(e) => setInterval(Number(e.target.value))} /></label><label>ظرفیت هم‌زمان <input type="number" min="1" max="100" required value={capacity} onChange={(e) => setCapacity(Number(e.target.value))} /></label><label>هزینه کل (تومان) <input type="number" min="0" max="2000000000" required value={totalTomans} onChange={(e) => setTotalTomans(Number(e.target.value))} /></label><label>مبلغ رزرو اختیاری (تومان) <input type="number" min="0" max={totalTomans} value={depositTomans} placeholder="بدون مبلغ رزرو" onChange={(e) => setDepositTomans(e.target.value)} /></label></div>
        <p>مبلغ رزرو بخشی از هزینه کل است. خالی‌گذاشتن آن به معنی نداشتن مبلغ رزرو است.</p><button className="cta" type="submit">ذخیره خدمت</button> <button type="button" className="doctor-secondary" onClick={() => { setAddingService(false); setEditing(null); setTitle(''); }}>انصراف</button>
      </form>}
      <section className="pnl-card neu doctor-services"><div className="doctor-section-head"><div><h2>خدمات کلینیک</h2><p>خدمات مشترک را تعریف و به پزشکان اختصاص دهید. خدمات قبلی هر پزشک در بخش همان پزشک باقی می‌مانند.</p></div>{isOwner && <button className="cta" type="button" onClick={() => { setEditing(null); setTitle(''); setDuration(30); setInterval(30); setCapacity(1); setTotalTomans(0); setDepositTomans(''); setAddingService(true); }}>+ خدمت جدید</button>}</div>{catalog.length ? <ul>{catalog.map((item) => <li key={item.id}><button type="button" className="catalog-service-button" onClick={() => setViewService(viewService === item.id ? '' : item.id)} aria-expanded={viewService === item.id}><strong>{item.title}</strong><small>{item.duration.toLocaleString('fa-IR')} دقیقه</small>{viewService === item.id && <span>هزینه کل: {item.totalTomans.toLocaleString('fa-IR')} تومان · مبلغ رزرو: {item.depositTomans === null ? 'ندارد' : item.depositTomans.toLocaleString('fa-IR') + ' تومان'}</span>}</button>{isOwner && <button type="button" onClick={() => { setAddingService(true); setEditing(item.id); setTitle(item.title); setDuration(item.duration); setInterval(item.interval); setCapacity(item.capacity); setTotalTomans(item.totalTomans); setDepositTomans(item.depositTomans === null ? '' : String(item.depositTomans)); }}>ویرایش</button>}</li>)}</ul> : <p>هنوز خدمتی در فهرست کلینیک تعریف نشده است.</p>}</section>
    </>}
    {selected && detail && mode === 'appointments' && <>
      <form className="pnl-card neu" onSubmit={(e) => void submit(e, async () => {
        const from = new Date(`${date}T00:00:00+03:30`), to = new Date(from.getTime() + 86400000);
        const q = new URLSearchParams({ serviceId: service, start: from.toISOString(), end: to.toISOString() });
        const result = await api(`/doctors/${selected}/slots?${q}`) as { slots: Record<string, Slot[]> };
        setSlots(Object.values(result.slots).flat()); setSlot(''); setSearched(true);
      })}><h2>جستجوی زمان آزاد</h2><label>خدمت <select required value={service} onChange={(e) => { setService(e.target.value); setSlots([]); setSearched(false); }}><option value="">انتخاب خدمت</option>{detail.services.map((s) => <option value={s.id} key={s.id}>{s.title}</option>)}</select></label>{' '}<label>تاریخ <input type="date" required value={date} onChange={(e) => { setDate(e.target.value); setSlots([]); setSearched(false); }} /></label>{' '}<button type="submit" className="cta">نمایش زمان‌ها</button></form>
      {searched && slots.length === 0 && <p className="pnl-empty">برای این روز زمان آزادی پیدا نشد.</p>}
      {slots.length > 0 && <form className="pnl-card neu" onSubmit={(e) => void submit(e, async () => { const body = { serviceId: service, start: slot, name: patient, mobile }; const fingerprint = JSON.stringify([selected, body]); if (bookingAttempt.current?.fingerprint !== fingerprint) bookingAttempt.current = { fingerprint, key: crypto.randomUUID() }; await api(`/doctors/${selected}/bookings`, body, bookingAttempt.current.key); bookingAttempt.current = null; setNotice('نوبت ثبت شد.'); setSlots([]); setSearched(false); await load(selected); })}>
        <h2>ثبت نوبت</h2><label>زمان <select required value={slot} onChange={(e) => setSlot(e.target.value)}><option value="">انتخاب ساعت</option>{slots.map((s) => <option key={s.utc} value={s.utc}>{s.time}{s.seatsLeft ? ` — ظرفیت ${s.seatsLeft}` : ''}</option>)}</select></label>{' '}<label>نام بیمار <input required value={patient} onChange={(e) => setPatient(e.target.value)} /></label>{' '}<label>موبایل <input required pattern="09[0-9]{9}" value={mobile} onChange={(e) => setMobile(e.target.value)} /></label>{' '}<button type="submit" className="cta">ثبت نوبت</button>
      </form>}
      <section className="pnl-card neu"><h2>نوبت‌های پیش رو</h2>{bookings.length ? <ul>{bookings.map((b) => <li key={b.uid}>{b.title} — {new Date(b.start).toLocaleString('fa-IR', { timeZone: 'Asia/Tehran' })} <button type="button" onClick={() => { if (window.confirm('این نوبت لغو شود؟')) void api(`/doctors/${selected}/bookings/${encodeURIComponent(b.uid)}/cancel`, {}).then(() => load(selected)).then(() => { setNoticeError(false); setNotice('نوبت لغو شد.'); }).catch(failure); }}>لغو نوبت</button></li>)}</ul> : <p>نوبتی ثبت نشده است.</p>}</section>
    </>}
  </div>;
}
