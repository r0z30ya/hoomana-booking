import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { SchedulingPage } from './SchedulingPage';

afterEach(() => vi.unstubAllGlobals());

it('shows saved working hours and sends service capacity and interval', async () => {
  const fetcher = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const path = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (path.endsWith('/services') && init?.method === 'POST') return Promise.resolve(Response.json({}));
    if (path.endsWith('/catalog') && !path.includes('/doctors/')) return Promise.resolve(Response.json({ services: [] }));
    if (path.endsWith('/catalog')) return Promise.resolve(Response.json({ assignments: [] }));
    if (path.endsWith('/doctors')) return Promise.resolve(Response.json({ doctors: [{ id: 'doc', name: 'پزشک نمونه' }] }));
    return Promise.resolve(Response.json({ services: [], schedules: [{ isDefault: true, availability: [{ days: [6], startTime: '1970-01-01T09:00:00.000Z', endTime: '1970-01-01T17:00:00.000Z' }] }] }));
  });
  vi.stubGlobal('fetch', fetcher);
  render(<SchedulingPage mode="doctors" isOwner />);
  await screen.findByRole('button', { name: 'ویرایش برنامه' });
  fireEvent.click(screen.getByRole('button', { name: 'ویرایش برنامه' }));
  fireEvent.click(screen.getByRole('button', { name: '+ خدمت جدید' }));
  expect(screen.getByLabelText('شروع شنبه بازه 1')).toHaveValue('09:00');
  fireEvent.change(screen.getByLabelText('نام خدمت'), { target: { value: 'ویزیت' } });
  fireEvent.change(screen.getByLabelText('گام نوبت (دقیقه)'), { target: { value: '15' } });
  fireEvent.change(screen.getByLabelText('ظرفیت هم‌زمان'), { target: { value: '2' } });
  fireEvent.click(screen.getByRole('button', { name: 'ذخیره خدمت' }));
  await waitFor(() => expect(fetcher.mock.calls.some(([url, init]) => typeof url === 'string' && url.endsWith('/catalog') && init?.body === JSON.stringify({ title: 'ویزیت', duration: 30, interval: 15, capacity: 2, totalTomans: 0, depositTomans: null }))).toBe(true));
});


it('preserves independent days and multiple working windows on save', async () => {
  const fetcher = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const path = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (path.endsWith('/schedule') && init?.method === 'POST') return Promise.resolve(Response.json({}));
    if (path.endsWith('/catalog') && !path.includes('/doctors/')) return Promise.resolve(Response.json({ services: [] }));
    if (path.endsWith('/catalog')) return Promise.resolve(Response.json({ assignments: [] }));
    if (path.endsWith('/doctors')) return Promise.resolve(Response.json({ doctors: [{ id: 'doc', name: 'پزشک نمونه' }] }));
    return Promise.resolve(Response.json({ services: [], schedules: [{ isDefault: true, availability: [
      { days: [6, 0], startTime: '1970-01-01T09:00:00.000Z', endTime: '1970-01-01T12:00:00.000Z' },
      { days: [6], startTime: '1970-01-01T14:00:00.000Z', endTime: '1970-01-01T17:00:00.000Z' }
    ] }] }));
  });
  vi.stubGlobal('fetch', fetcher);
  render(<SchedulingPage mode="doctors" isOwner />);
  await screen.findByRole('button', { name: 'ویرایش برنامه' });
  fireEvent.click(screen.getByRole('button', { name: 'ویرایش برنامه' }));
  await screen.findByLabelText('شروع شنبه بازه 2');
  fireEvent.change(screen.getByLabelText('شروع یکشنبه بازه 1'), { target: { value: '10:00' } });
  fireEvent.click(screen.getByRole('button', { name: 'ذخیره برنامه پزشک' }));
  await waitFor(() => expect(fetcher.mock.calls.some(([url, init]) => typeof url === 'string' && url.endsWith('/schedule') && init?.body === JSON.stringify({ availability: [
    { days: [6], startTime: '09:00', endTime: '12:00' }, { days: [6], startTime: '14:00', endTime: '17:00' }, { days: [0], startTime: '10:00', endTime: '12:00' }
  ] }))).toBe(true));
});


it('assigns an existing clinic service to the selected doctor', async () => {
  const fetcher = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const path = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (path.endsWith('/doctors/doc/catalog/shared') && init?.method === 'POST') return Promise.resolve(Response.json({ assignment: {} }));
    if (path.endsWith('/doctors/doc/catalog')) return Promise.resolve(Response.json({ assignments: [] }));
    if (path.endsWith('/catalog')) return Promise.resolve(Response.json({ services: [{ id: 'shared', title: 'مشاوره', duration: 30, interval: 30, capacity: 1, totalTomans: 100000, depositTomans: null }] }));
    if (path.endsWith('/doctors')) return Promise.resolve(Response.json({ doctors: [{ id: 'doc', name: 'پزشک نمونه' }] }));
    return Promise.resolve(Response.json({ services: [], schedules: [] }));
  });
  vi.stubGlobal('fetch', fetcher);
  render(<SchedulingPage mode="doctors" isOwner />);
  fireEvent.click(await screen.findByRole('button', { name: 'انتخاب خدمات' }));
  fireEvent.click(screen.getByRole('checkbox', { name: 'مشاوره' }));
  fireEvent.click(screen.getByRole('button', { name: 'ذخیره خدمات پزشک' }));
  await waitFor(() => expect(fetcher.mock.calls.some(([url, init]) => typeof url === 'string' && url.endsWith('/doctors/doc/catalog/shared') && init?.body === JSON.stringify({ active: true }))).toBe(true));
});
