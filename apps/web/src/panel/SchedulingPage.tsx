import { useEffect, useRef, useState, type FormEvent, type JSX } from 'react';

type Doctor = { id: string; name: string };
type Service = { id: number; title: string; length: number; slotInterval: number | null; seatsPerTimeSlot: number | null };
type Schedule = { isDefault: boolean; availability: { days: number[]; startTime: string; endTime: string }[] };
type Detail = { services: Service[]; schedules: Schedule[] };
type Slot = { utc: string; time: string; seatsLeft?: number };
type Booking = { uid: string; title: string; start: string; status: string };

async function api(path: string, body?: unknown): Promise<unknown> {
  const result = await fetch(`/tenant/scheduling${path}`, {
    credentials: 'same-origin',
    ...(body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
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
  const [practiceType, setPracticeType] = useState<'SOLO' | 'CLINIC'>('CLINIC');
  const [selected, setSelected] = useState('');
  const [detail, setDetail] = useState<Detail | null>(null);
  const [notice, setNotice] = useState('');
  const [name, setName] = useState('');
  const [title, setTitle] = useState('');
  const [duration, setDuration] = useState(30);
  const [interval, setInterval] = useState(30);
  const [capacity, setCapacity] = useState(1);
  const [editing, setEditing] = useState<number | null>(null);
  const [days, setDays] = useState<number[]>([6, 0, 1, 2, 3, 4]);
  const [start, setStart] = useState('09:00');
  const [end, setEnd] = useState('17:00');
  const [service, setService] = useState('');
  const [date, setDate] = useState('');
  const [slots, setSlots] = useState<Slot[]>([]);
  const [searched, setSearched] = useState(false);
  const submitting = useRef(false);
  const currentDoctor = useRef('');
  const [slot, setSlot] = useState('');
  const [patient, setPatient] = useState('');
  const [mobile, setMobile] = useState('');
  const [bookings, setBookings] = useState<Booking[]>([]);

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
    const row = data.schedules.find((s) => s.isDefault)?.availability?.[0];
    if (row) { setDays(row.days); setStart(row.startTime.slice(11, 16)); setEnd(row.endTime.slice(11, 16)); }
    else { setDays([]); setStart('09:00'); setEnd('17:00'); }
    setService(data.services[0] ? String(data.services[0].id) : '');
    if (mode === 'appointments') {
      const result = await api(`/doctors/${id}/bookings`) as { bookings: Booking[] };
      if (currentDoctor.current === id) setBookings(result.bookings);
    }
  }
  function failure(error: unknown) { setNotice(error instanceof Error ? error.message : 'خطایی رخ داد.'); }
  useEffect(() => { void list().catch(failure); }, []);
  useEffect(() => { currentDoctor.current = selected; if (selected) { setDetail(null); setSlots([]); setSearched(false); setEditing(null); void load(selected).catch(failure); } }, [selected, mode]);
  async function submit(event: FormEvent, action: () => Promise<void>) {
    event.preventDefault();
    if (submitting.current) return;
    submitting.current = true; setNotice('');
    try { await action(); } catch (error) { failure(error); } finally { submitting.current = false; }
  }

  return <div className="pnl-scheduling">
    <h1 className="pnl-page-title">{mode === 'doctors' ? 'پزشکان و خدمات' : 'نوبت‌ها'}</h1>
    <p className="pnl-page-sub">{mode === 'doctors' ? 'پزشک، ساعت کاری و خدمات کلینیک را مدیریت کنید.' : 'زمان‌های آزاد پزشک را ببینید و نوبت ثبت کنید.'}</p>
    {notice && <p className="pnl-notice" role="status">{notice}</p>}
    {mode === 'doctors' && isOwner && (practiceType !== 'SOLO' || doctors.length === 0) && <form className="pnl-card neu" onSubmit={(e) => void submit(e, async () => { await api('/doctors', { name }); setName(''); await list(); setNotice('پزشک اضافه شد.'); })}>
      <h2>افزودن پزشک</h2><label>نام پزشک <input required maxLength={200} value={name} onChange={(e) => setName(e.target.value)} /></label>{' '}<button className="cta" type="submit">افزودن</button>
    </form>}
    <section className="pnl-card neu">{practiceType === 'SOLO' && doctors.length ? <p>پزشک مطب: {doctors[0]?.name}</p> : <label>پزشک{' '}<select value={selected} onChange={(e) => { currentDoctor.current = e.target.value; setSelected(e.target.value); }}><option value="">انتخاب پزشک</option>{doctors.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}</select></label>}</section>
    {selected && detail && mode === 'doctors' && <>
      {isOwner && <form className="pnl-card neu" onSubmit={(e) => void submit(e, async () => { await api(`/doctors/${selected}/schedule`, { availability: days.length ? [{ days, startTime: start, endTime: end }] : [] }); await load(selected); setNotice('ساعت کاری ذخیره شد.'); })}>
        <h2>ساعت کاری هفتگی</h2><p>با ذخیره، برنامه کاری پیش‌فرض پزشک جایگزین می‌شود.</p>
        <fieldset><legend>روزهای کاری</legend>{[[6,'شنبه'],[0,'یکشنبه'],[1,'دوشنبه'],[2,'سه‌شنبه'],[3,'چهارشنبه'],[4,'پنجشنبه'],[5,'جمعه']].map(([day, label]) => <label key={day}>{' '}<input type="checkbox" checked={days.includes(day as number)} onChange={() => setDays(days.includes(day as number) ? days.filter((d) => d !== day) : [...days, day as number])} /> {label}</label>)}</fieldset>
        <label>از <input type="time" required value={start} onChange={(e) => setStart(e.target.value)} /></label>{' '}<label>تا <input type="time" required value={end} onChange={(e) => setEnd(e.target.value)} /></label>{' '}<button type="submit" className="cta">ذخیره ساعت کاری</button>
      </form>}
      {isOwner && <form className="pnl-card neu" onSubmit={(e) => void submit(e, async () => { await api(`/doctors/${selected}/services${editing === null ? '' : `/${editing}`}`, { title, duration, interval, capacity }); setTitle(''); setEditing(null); await load(selected); setNotice('خدمت ذخیره شد.'); })}>
        <h2>{editing === null ? 'تعریف خدمت' : 'ویرایش خدمت'}</h2><label>نام خدمت <input required value={title} onChange={(e) => setTitle(e.target.value)} /></label>{' '}<label>مدت (دقیقه) <input type="number" min="5" max="720" required value={duration} onChange={(e) => setDuration(Number(e.target.value))} /></label>{' '}<label>گام نوبت (دقیقه) <input type="number" min="5" max="720" required value={interval} onChange={(e) => setInterval(Number(e.target.value))} /></label>{' '}<label>ظرفیت هم‌زمان <input type="number" min="1" max="100" required value={capacity} onChange={(e) => setCapacity(Number(e.target.value))} /></label>{' '}<button className="cta" type="submit">ذخیره خدمت</button>{editing !== null && <button type="button" onClick={() => { setEditing(null); setTitle(''); }}>انصراف</button>}
      </form>}
      <section className="pnl-card neu"><h2>خدمات پزشک</h2>{detail.services.length ? <ul>{detail.services.map((s) => <li key={s.id}>{s.title} — {s.length} دقیقه، گام {s.slotInterval ?? s.length}، ظرفیت {s.seatsPerTimeSlot ?? 1} {isOwner && <button type="button" onClick={() => { setEditing(s.id); setTitle(s.title); setDuration(s.length); setInterval(s.slotInterval ?? s.length); setCapacity(s.seatsPerTimeSlot ?? 1); }}>ویرایش</button>}</li>)}</ul> : <p>خدمتی تعریف نشده است.</p>}</section>
    </>}
    {selected && detail && mode === 'appointments' && <>
      <form className="pnl-card neu" onSubmit={(e) => void submit(e, async () => {
        const from = new Date(`${date}T00:00:00+03:30`), to = new Date(from.getTime() + 86400000);
        const q = new URLSearchParams({ serviceId: service, start: from.toISOString(), end: to.toISOString() });
        const result = await api(`/doctors/${selected}/slots?${q}`) as { slots: Record<string, Slot[]> };
        setSlots(Object.values(result.slots).flat()); setSlot(''); setSearched(true);
      })}><h2>جستجوی زمان آزاد</h2><label>خدمت <select required value={service} onChange={(e) => { setService(e.target.value); setSlots([]); setSearched(false); }}><option value="">انتخاب خدمت</option>{detail.services.map((s) => <option value={s.id} key={s.id}>{s.title}</option>)}</select></label>{' '}<label>تاریخ <input type="date" required value={date} onChange={(e) => { setDate(e.target.value); setSlots([]); setSearched(false); }} /></label>{' '}<button type="submit" className="cta">نمایش زمان‌ها</button></form>
      {searched && slots.length === 0 && <p className="pnl-empty">برای این روز زمان آزادی پیدا نشد.</p>}
      {slots.length > 0 && <form className="pnl-card neu" onSubmit={(e) => void submit(e, async () => { await api(`/doctors/${selected}/bookings`, { serviceId: Number(service), start: slot, name: patient, mobile }); setNotice('نوبت ثبت شد.'); setSlots([]); setSearched(false); await load(selected); })}>
        <h2>ثبت نوبت</h2><label>زمان <select required value={slot} onChange={(e) => setSlot(e.target.value)}><option value="">انتخاب ساعت</option>{slots.map((s) => <option key={s.utc} value={s.utc}>{s.time.slice(11,16)}{s.seatsLeft ? ` — ظرفیت ${s.seatsLeft}` : ''}</option>)}</select></label>{' '}<label>نام بیمار <input required value={patient} onChange={(e) => setPatient(e.target.value)} /></label>{' '}<label>موبایل <input required pattern="09[0-9]{9}" value={mobile} onChange={(e) => setMobile(e.target.value)} /></label>{' '}<button type="submit" className="cta">ثبت نوبت</button>
      </form>}
      <section className="pnl-card neu"><h2>نوبت‌های پیش رو</h2>{bookings.length ? <ul>{bookings.map((b) => <li key={b.uid}>{b.title} — {new Date(b.start).toLocaleString('fa-IR', { timeZone: 'Asia/Tehran' })} <button type="button" onClick={() => { if (window.confirm('این نوبت لغو شود؟')) void api(`/doctors/${selected}/bookings/${encodeURIComponent(b.uid)}/cancel`, {}).then(() => load(selected)).then(() => setNotice('نوبت لغو شد.')).catch(failure); }}>لغو نوبت</button></li>)}</ul> : <p>نوبتی ثبت نشده است.</p>}</section>
    </>}
  </div>;
}
