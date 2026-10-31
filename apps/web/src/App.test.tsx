import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';

/**
 * `fetch` is stubbed with a minimal shape rather than a real `Response`, because `App`
 * only reads `ok`, `status` and `json()`. This keeps the tests independent of which
 * fetch implementation the test environment happens to provide.
 */
interface FetchStubResponse {
  readonly ok: boolean;
  readonly status: number;
  readonly json: () => Promise<unknown>;
}

type FetchStub = (input: string, init?: { signal?: AbortSignal }) => Promise<FetchStubResponse>;

const fetchMock = vi.fn<FetchStub>();

function jsonResponse(body: unknown, status = 200): FetchStubResponse {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  };
}

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  fetchMock.mockReset();
  vi.unstubAllGlobals();
});

describe('App', () => {
  it('requests the health endpoint on mount with an abort signal', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ status: 'ok' }));

    render(<App />);

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalled();
    });

    const firstCall = fetchMock.mock.calls[0];

    expect(firstCall?.[0]).toBe('/health');
    // The request must be abortable so an unmounted component cannot set state.
    expect(firstCall?.[1]?.signal).toBeInstanceOf(AbortSignal);
  });

  it('shows the healthy state when the API reports ok', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ status: 'ok' }));

    render(<App />);

    await waitFor(() => {
      expect(screen.getByTestId('health-status')).toHaveTextContent('API is ok');
    });
  });

  it('reports the status code when the API answers with an error', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ status: 'error' }, 503));

    render(<App />);

    await waitFor(() => {
      expect(screen.getByTestId('health-status')).toHaveTextContent('503');
    });
  });

  it('reports an unreachable API when the request rejects', async () => {
    fetchMock.mockRejectedValue(new Error('network down'));

    render(<App />);

    await waitFor(() => {
      expect(screen.getByTestId('health-status')).toHaveTextContent('network down');
    });
  });

  it('treats an unexpected body as a failure rather than a false success', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ status: 'degraded' }));

    render(<App />);

    await waitFor(() => {
      expect(screen.getByTestId('health-status')).toHaveTextContent('Unexpected health response');
    });
  });

  it('treats a non-object body as a failure', async () => {
    fetchMock.mockResolvedValue(jsonResponse('not-an-object'));

    render(<App />);

    await waitFor(() => {
      expect(screen.getByTestId('health-status')).toHaveTextContent('Unexpected health response');
    });
  });

  it('opens on the login screen with the Persian brand and no English scaffolding copy', () => {
    fetchMock.mockResolvedValue(jsonResponse({ status: 'ok' }));

    render(<App />);

    // The owner removed the English masthead; the screen is Persian-first.
    expect(screen.queryByText('HMN SaaS')).not.toBeInTheDocument();
    expect(screen.getByText('هومانا')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'ورود به پنل' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /sign in/i })).not.toBeInTheDocument();
  });

  it('leads from the login footer to the plans screen and then to signup', () => {
    fetchMock.mockResolvedValue(jsonResponse({ status: 'ok' }));

    render(<App />);

    // The owner asked for both "free demo" and "signup" to open the comparison page.
    fireEvent.click(screen.getByRole('button', { name: 'ثبت‌نام رایگان' }));
    expect(screen.getByText('پکیج‌های هومانا')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'کلینیک' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'شروع دورهٔ آزمایشی' }));
    expect(screen.getByLabelText('شمارهٔ موبایل')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'دریافت کد تأیید' })).toBeInTheDocument();
  });
});
