import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PlansPage } from './PlansPage';

afterEach(() => vi.unstubAllGlobals());
describe('plans and trial', () => {
  it('shows both annual prices, the configured trial, and carries the selected package to signup', async () => {
    vi.stubGlobal('fetch', vi.fn((url: string) => Promise.resolve({ ok: true, json: async () => url === '/auth/prices' ? { prices: [{ practiceType: 'SOLO', durationMonths: 12, priceTomans: 25000000 }, { practiceType: 'CLINIC', durationMonths: 12, priceTomans: 35000000 }] } : { soloTrialDays: 14, clinicTrialDays: 21 } })));
    const start = vi.fn();
    render(<PlansPage onStartFree={start} />);
    expect(await screen.findByText('۲۵٬۰۰۰٬۰۰۰')).toBeInTheDocument();
    expect(await screen.findByText('۳۵٬۰۰۰٬۰۰۰')).toBeInTheDocument();
    await waitFor(() => expect(screen.getAllByText(/۱۴ روزه/).length).toBeGreaterThan(0));
    fireEvent.click(screen.getByRole('button', { name: /شروع رایگان کلینیک/ }));
    expect(start).toHaveBeenCalledWith('CLINIC');
  });
  it('does not claim a fixed trial duration when the setting cannot be loaded', () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
    render(<PlansPage onStartFree={vi.fn()} />);
    expect(screen.queryByText(/۱۴ روزه/)).not.toBeInTheDocument();
  });
});
