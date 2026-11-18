import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { AppointmentsPage } from './AppointmentsPage';

afterEach(() => vi.unstubAllGlobals());
const pathOf = (input: RequestInfo | URL): string => typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
const start = new Date(Date.now() + 86400000);
const dayLabel = new Intl.DateTimeFormat('fa-IR', { timeZone: 'Asia/Tehran', weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }).format(start);
const appointment = { uid: 'one', serviceId: 'service', title: 'ویزیت', start: start.toISOString(), status: 'CONFIRMED', patientName: 'بیمار نمونه', mobile: '09120000000' };

it('registers a test booking through the phone-first steps', async () => {
  let booked = false;
  const fetcher = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const path = pathOf(input);
    if (path.startsWith('/tenant/clients?')) return Promise.resolve(Response.json({ clients: [] }));
    if (path.endsWith('/doctors')) return Promise.resolve(Response.json({ doctors: [{ id: 'doc', name: 'دکتر نمونه' }] }));
    if (path.includes('/slots?')) return Promise.resolve(Response.json({ slots: { available: [{ utc: start.toISOString(), time: '10:00', seatsLeft: 1 }] } }));
    if (path.endsWith('/bookings') && init?.method === 'POST') { booked = true; return Promise.resolve(Response.json({})); }
    if (path.includes('/bookings?')) return Promise.resolve(Response.json({ bookings: booked ? [appointment] : [] }));
    return Promise.resolve(Response.json({ services: [{ id: 'service', title: 'ویزیت', length: 30 }] }));
  });
  vi.stubGlobal('fetch', fetcher);
  render(<AppointmentsPage />);
  await screen.findByText('نوبتی پیدا نشد');
  fireEvent.click(screen.getByRole('button', { name: '＋ نوبت جدید' }));
  expect(screen.getByText(/پرونده‌های دارای این شماره بررسی می‌شوند/)).toBeInTheDocument();
  fireEvent.change(screen.getByLabelText('شماره موبایل'), { target: { value: '۰۹۱۲۰۰۰۰۰۰۰' } });
  fireEvent.click(screen.getByRole('button', { name: 'ادامه ←' }));
  fireEvent.change(await screen.findByLabelText('نام'), { target: { value: 'بیمار' } });
  fireEvent.change(screen.getByLabelText('نام خانوادگی'), { target: { value: 'نمونه' } });
  fireEvent.click(screen.getByRole('button', { name: 'ادامه ←' }));
  fireEvent.change(screen.getByLabelText('خدمت نوبت'), { target: { value: 'service' } });
  const wizard = screen.getByRole('heading', { name: 'ثبت نوبت جدید' }).closest('section');
  if (!wizard) throw new Error('Wizard not found');
  expect(within(wizard).queryByRole('button', { name: /10:00/ })).not.toBeInTheDocument();
  expect(await within(wizard).findByText(/ابتدا یک روز دارای زمان آزاد/)).toBeInTheDocument();
  const day = await within(wizard).findByRole('button', { name: dayLabel });
  await waitFor(() => expect(day).toBeEnabled());
  fireEvent.click(day);
  fireEvent.click(await within(wizard).findByRole('button', { name: /10:00/ }));
  fireEvent.click(within(wizard).getByRole('button', { name: 'ثبت نوبت' }));
  expect(await screen.findByText('بیمار نمونه')).toBeInTheDocument();
  const call = fetcher.mock.calls.find(([url, init]) => pathOf(url).endsWith('/bookings') && init?.method === 'POST');
  expect(JSON.parse(typeof call?.[1]?.body === 'string' ? call[1].body : '{}')).toMatchObject({ mobile: '09120000000', name: 'بیمار نمونه', serviceId: 'service' });
  expect((call?.[1]?.headers as Record<string, string>)['idempotency-key']).toBeTruthy();
});

it('counts the calendar month independently of the day list and updates when navigating months', async () => {
  const calls: string[] = [];
  vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
    const path = pathOf(input);
    if (path.endsWith('/doctors')) return Promise.resolve(Response.json({ doctors: [{ id: 'doc', name: 'پزشک' }] }));
    if (path.includes('/bookings?')) {
      calls.push(path);
      const query = new URL(path, 'http://localhost').searchParams;
      const duration = new Date(query.get('end') ?? '').getTime() - new Date(query.get('start') ?? '').getTime();
      return Promise.resolve(Response.json({ bookings: duration > 86400000 ? [appointment, { ...appointment, uid: 'two' }, { ...appointment, uid: 'cancelled', status: 'CANCELLED' }] : [appointment] }));
    }
    return Promise.resolve(Response.json({ services: [{ id: 'service', title: 'ویزیت', length: 30 }] }));
  }));
  render(<AppointmentsPage />);
  const panel = (await screen.findByText('تقویم نوبت‌ها')).closest('aside');
  if (!panel) throw new Error('Calendar panel not found');
  const summary = within(panel).getByText('نوبت‌های این ماه').parentElement;
  if (!summary) throw new Error('Month summary not found');
  await waitFor(() => expect(within(summary).getByText('۲')).toBeInTheDocument());
  const before = calls.length;
  fireEvent.click(within(panel).getByRole('button', { name: 'ماه بعد' }));
  await waitFor(() => expect(calls.length).toBeGreaterThan(before));
});

it('filters multiple doctors and services and changes the displayed range', async () => {
  const fetcher = vi.fn((input: RequestInfo | URL) => {
    const path = pathOf(input);
    if (path.endsWith('/doctors')) return Promise.resolve(Response.json({ doctors: [{ id: 'a', name: 'پزشک الف' }, { id: 'b', name: 'پزشک ب' }] }));
    if (path.includes('/bookings?')) return Promise.resolve(Response.json({ bookings: [path.includes('/a/') ? appointment : { ...appointment, uid: 'two', title: 'مشاوره', patientName: 'بیمار دوم' }] }));
    return Promise.resolve(Response.json({ services: [{ id: path.includes('/a') ? 'service' : 'service2', title: path.includes('/a') ? 'ویزیت' : 'مشاوره', length: 30 }] }));
  });
  vi.stubGlobal('fetch', fetcher);
  render(<AppointmentsPage />);
  await screen.findByText('بیمار دوم');
  fireEvent.change(screen.getByLabelText('خدمت'), { target: { value: 'ویزیت' } });
  expect(screen.queryByText('بیمار دوم')).not.toBeInTheDocument();
  expect(screen.getByText('بیمار نمونه')).toBeInTheDocument();
  const row = screen.getByText('بیمار نمونه').closest('article');
  if (!row) throw new Error('Appointment row not found');
  expect(within(row).getByText('پزشک الف')).toBeInTheDocument();
  expect(within(row).getByText('پزشک الف').parentElement).not.toContainElement(within(row).getByText('ویزیت'));
  fireEvent.change(screen.getByLabelText('پزشک'), { target: { value: 'b' } });
  expect(await screen.findByText('بیمار دوم')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'هفته' }));
  await waitFor(() => expect(screen.getByRole('button', { name: 'هفته' })).toHaveAttribute('aria-pressed', 'true'));
  fireEvent.click(screen.getByRole('button', { name: 'ماه' }));
  expect(screen.getByRole('button', { name: 'ماه' })).toHaveAttribute('aria-pressed', 'true');
});
