import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CheckoutPage } from './CheckoutPage';

afterEach(() => vi.unstubAllGlobals());
describe('subscription checkout', () => {
  it.each([
    ['SOLO', '۲۵٬۰۰۰٬۰۰۰'],
    ['CLINIC', '۳۵٬۰۰۰٬۰۰۰'],
  ])('shows the %s account price without enabling a fake payment', async (practiceType, price) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ tenant: { name: 'مجموعه نمونه', practiceType }, subscription: null }) }));
    render(<CheckoutPage />);
    expect((await screen.findAllByText(new RegExp(price))).length).toBeGreaterThan(0);
    expect(screen.getByRole('button', { name: /پرداخت آنلاین/ })).toBeDisabled();
    expect(screen.getByText(/درگاه پرداخت هنوز راه‌اندازی نشده/)).toBeInTheDocument();
  });
});
