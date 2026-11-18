import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { ClientsPage } from './ClientsPage';
afterEach(() => vi.unstubAllGlobals());
it('shows client details, linked bookings and manual payments', async () => {
  vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
    const path = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (path.includes('/bookings')) return Promise.resolve(Response.json({ bookings: [{ uid: 'one', title: 'ویزیت', doctorName: 'دکتر نمونه', start: '2026-11-18T10:00:00Z', status: 'CONFIRMED' }] }));
    if (path.includes('/payments')) return Promise.resolve(Response.json({ payments: [{ id: 'p', amountTomans: 100000, method: 'CARD', paidAt: '2026-11-18T10:00:00Z', note: null }] }));
    return Promise.resolve(Response.json({ clients: [{ id: 'a', firstName: 'سارا', lastName: 'نمونه', mobile: '09120000000', fatherName: 'علی', birthDate: '1370/01/01', nationalId: null, fileNumber: '12', address: null, occupation: null }] }));
  }));
  render(<ClientsPage />); const list = await screen.findByRole('button', { name: /سارا نمونه/ }); fireEvent.click(list);
  const details = screen.getByRole('main'); expect(within(details).getByText('علی')).toBeInTheDocument();
  expect(await within(details).findByText('ویزیت')).toBeInTheDocument(); expect(await within(details).findByText('۱۰۰٬۰۰۰ تومان')).toBeInTheDocument();
  await waitFor(() => expect(within(details).getByText(/تأییدیه درگاه پرداخت نیستند/)).toBeInTheDocument());
});
