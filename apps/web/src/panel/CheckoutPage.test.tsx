import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CheckoutPage } from './CheckoutPage';

afterEach(() => vi.unstubAllGlobals());
describe('subscription checkout', () => {
  it('changes the amount with the selected subscription duration', async () => {
    vi.stubGlobal('fetch', vi.fn((url: string) => Promise.resolve({ ok: true, json: async () => url === '/auth/prices' ? { prices: [{ practiceType: 'SOLO', durationMonths: 3, priceTomans: 7000000 }, { practiceType: 'SOLO', durationMonths: 12, priceTomans: 25000000 }] } : { tenant: { name: 'مطب', practiceType: 'SOLO' }, subscription: null } })));
    render(<CheckoutPage />);
    await screen.findAllByText(/۲۵٬۰۰۰٬۰۰۰/);
    fireEvent.change(screen.getByLabelText('مدت اشتراک'), { target: { value: '3' } });
    expect(screen.getAllByText(/۷٬۰۰۰٬۰۰۰/)).toHaveLength(2);
    fireEvent.change(screen.getByLabelText('مدت اشتراک'), { target: { value: '6' } });
    expect(screen.getAllByText(/تعیین نشده/)).toHaveLength(2);
  });
  it.each([
    ['SOLO', '۲۵٬۰۰۰٬۰۰۰'],
    ['CLINIC', '۳۵٬۰۰۰٬۰۰۰'],
  ])('shows the %s account price without enabling a fake payment', async (practiceType, price) => {
    vi.stubGlobal('fetch', vi.fn((url: string) => Promise.resolve({ ok: true, json: async () => url === '/auth/prices' ? { prices: [{ practiceType: 'SOLO', durationMonths: 12, priceTomans: 25000000 }, { practiceType: 'CLINIC', durationMonths: 12, priceTomans: 35000000 }] } : { tenant: { name: 'مجموعه نمونه', practiceType }, subscription: null } })));
    render(<CheckoutPage />);
    expect((await screen.findAllByText(new RegExp(price))).length).toBeGreaterThan(0);
    expect(screen.getByRole('button', { name: /پرداخت آنلاین/ })).toBeDisabled();
    expect(screen.getByText(/درگاه پرداخت هنوز راه‌اندازی نشده/)).toBeInTheDocument();
  });
});
