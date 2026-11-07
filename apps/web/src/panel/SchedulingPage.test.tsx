import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { SchedulingPage } from './SchedulingPage';

afterEach(() => vi.unstubAllGlobals());

it('shows saved working hours and sends service capacity and interval', async () => {
  const fetcher = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const path = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (path.endsWith('/services') && init?.method === 'POST') return Promise.resolve(Response.json({}));
    if (path.endsWith('/doctors')) return Promise.resolve(Response.json({ doctors: [{ id: 'doc', name: 'پزشک نمونه' }] }));
    return Promise.resolve(Response.json({ services: [], schedules: [{ isDefault: true, availability: [{ days: [6], startTime: '1970-01-01T09:00:00.000Z', endTime: '1970-01-01T17:00:00.000Z' }] }] }));
  });
  vi.stubGlobal('fetch', fetcher);
  render(<SchedulingPage mode="doctors" isOwner />);
  await screen.findByRole('heading', { name: 'تعریف خدمت' });
  expect(screen.getByLabelText('از')).toHaveValue('09:00');
  fireEvent.change(screen.getByLabelText('نام خدمت'), { target: { value: 'ویزیت' } });
  fireEvent.change(screen.getByLabelText('گام نوبت (دقیقه)'), { target: { value: '15' } });
  fireEvent.change(screen.getByLabelText('ظرفیت هم‌زمان'), { target: { value: '2' } });
  fireEvent.click(screen.getByRole('button', { name: 'ذخیره خدمت' }));
  await waitFor(() => expect(fetcher.mock.calls.some(([url, init]) => typeof url === 'string' && url.endsWith('/services') && init?.body === JSON.stringify({ title: 'ویزیت', duration: 30, interval: 15, capacity: 2 }))).toBe(true));
});
