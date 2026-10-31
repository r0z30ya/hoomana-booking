import { describe, expect, it, vi } from 'vitest';
import { createMelipayamakProvider } from './melipayamak.js';
import { SmsProviderError } from './types.js';

/**
 * Adapter tests. No network: `fetchImpl` is injected, so the suite asserts the exact
 * request shape the provider documented, plus the error contract the worker's retry
 * policy depends on.
 */
const PANEL_FIXTURE = 'fixture-panel-ref';
const SENDER = '50002710077565';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** A fetch stub that always answers with the same JSON body. */
function returningJson(body: unknown, status = 200): typeof fetch {
  return () => Promise.resolve(jsonResponse(body, status));
}

/** A fetch stub that always answers with the same plain-text body. */
function returningText(body: string, status = 200): typeof fetch {
  return () => Promise.resolve(new Response(body, { status }));
}

/** A fetch stub that never answers, so the adapter's own timeout has to fire. */
function hanging(): typeof fetch {
  return (_input, init) =>
    new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => {
        reject(new Error('aborted'));
      });
    });
}

/** The request body the adapter produced, decoded for assertions. */
function bodyOf(init: RequestInit): unknown {
  const body = init.body;
  if (typeof body !== 'string') throw new Error('expected a JSON string body');
  return JSON.parse(body) as unknown;
}

function providerWith(fetchImpl: typeof fetch, timeoutMs?: number) {
  return createMelipayamakProvider({
    panelRef: PANEL_FIXTURE,
    sender: SENDER,
    fetchImpl,
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  });
}

describe('melipayamak adapter', () => {
  it('sends an OTP through the panel OTP endpoint', async () => {
    const fetchImpl = vi.fn(returningJson(3741437414));
    const provider = providerWith(fetchImpl);

    const result = await provider.sendOtp({ to: '09123456789', code: '12345' });

    expect(result.recIds).toEqual(['3741437414']);

    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain(`/api/send/otp/${PANEL_FIXTURE}`);
    expect(init.method).toBe('POST');
    expect(bodyOf(init)).toEqual({ to: '09123456789' });
  });

  it('sends a shared-service pattern with its variables in order', async () => {
    const fetchImpl = vi.fn(
      returningJson({ RetStatus: 1, StrRetStatus: 'Ok', Value: '99887766' }),
    );
    const provider = providerWith(fetchImpl);

    const result = await provider.sendPattern({
      to: '09123456789',
      bodyId: 524,
      args: ['آقای احمدی', '1405/07/20'],
    });

    expect(result.recIds).toEqual(['99887766']);
    expect(result.providerStatus).toBe('Ok');

    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`https://console.melipayamak.com/api/send/shared/${PANEL_FIXTURE}`);
    expect(bodyOf(init)).toEqual({
      bodyId: 524,
      to: '09123456789',
      args: ['آقای احمدی', '1405/07/20'],
    });
  });

  it('sends free text from the configured sender line', async () => {
    const fetchImpl = vi.fn(returningJson(12345));
    const provider = providerWith(fetchImpl);

    await provider.sendFreeText({ to: '09123456789', text: 'test sms' });

    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`https://console.melipayamak.com/api/send/simple/${PANEL_FIXTURE}`);
    expect(bodyOf(init)).toEqual({
      from: SENDER,
      to: '09123456789',
      text: 'test sms',
    });
  });

  it('sends one text to many recipients through the advanced endpoint', async () => {
    const fetchImpl = vi.fn(returningJson([111, 222]));
    const provider = providerWith(fetchImpl);

    const result = await provider.sendBulk({
      to: ['09123456789', '09120000000'],
      text: 'night list',
    });

    expect(result.recIds).toEqual(['111', '222']);

    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`https://console.melipayamak.com/api/send/advanced/${PANEL_FIXTURE}`);
    expect(bodyOf(init)).toEqual({
      from: SENDER,
      to: ['09123456789', '09120000000'],
      text: 'night list',
      udh: '',
    });
  });

  it('fails closed when a send is accepted without a message id', async () => {
    const withoutId = providerWith(returningJson({ RetStatus: 1 }));
    const withEmptyBody = providerWith(returningText(''));

    for (const provider of [withoutId, withEmptyBody]) {
      await expect(provider.sendFreeText({ to: '09123456789', text: 'x' })).rejects.toMatchObject({
        name: 'SmsProviderError',
        kind: 'unexpected-response',
        retryable: false,
      });
    }
  });

  it('reads the panel credit from both response shapes', async () => {
    const numeric = providerWith(returningJson(12_500));
    const wrapped = providerWith(returningJson({ Value: '9800' }));

    expect((await numeric.fetchCredit()).amount).toBe(12_500);
    expect((await wrapped.fetchCredit()).amount).toBe(9_800);
  });

  it('normalises delivery codes (2 delivered, 3/16 failed, else pending)', async () => {
    const provider = providerWith(
      returningJson([
        { recId: 111, status: 2 },
        { recId: 222, status: 3 },
        { recId: 333, status: 16 },
        { recId: 444, status: 5 },
      ]),
    );

    const statuses = await provider.fetchDeliveryStatus(['111', '222', '333', '444']);

    expect(statuses.map((entry) => [entry.recId, entry.state])).toEqual([
      ['111', 'delivered'],
      ['222', 'failed'],
      ['333', 'failed'],
      ['444', 'pending'],
    ]);
  });

  it('skips the status call entirely when there is nothing to look up', async () => {
    const fetchImpl = vi.fn(returningJson([]));
    const provider = providerWith(fetchImpl);

    expect(await provider.fetchDeliveryStatus([])).toEqual([]);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('marks a 4xx rejection as non-retryable', async () => {
    const provider = providerWith(returningText('bad request', 400));

    await expect(provider.sendOtp({ to: '09123456789', code: '1' })).rejects.toMatchObject({
      name: 'SmsProviderError',
      kind: 'invalid-request',
      retryable: false,
      status: 400,
    });
  });

  it('marks a 5xx failure as retryable', async () => {
    const provider = providerWith(returningText('boom', 503));

    await expect(provider.sendFreeText({ to: '09123456789', text: 'x' })).rejects.toMatchObject({
      kind: 'provider',
      retryable: true,
      status: 503,
    });
  });

  it('turns a timeout into a retryable unreachable error', async () => {
    const provider = providerWith(hanging(), 5);

    await expect(provider.sendOtp({ to: '09123456789', code: '1' })).rejects.toMatchObject({
      kind: 'unreachable',
      retryable: true,
    });
  });

  it('refuses to send when the panel reference or sender is missing', async () => {
    const fetchImpl = vi.fn(returningJson(1));
    const missingRef = createMelipayamakProvider({
      panelRef: '  ',
      sender: SENDER,
      fetchImpl,
    });

    await expect(missingRef.fetchCredit()).rejects.toMatchObject({ kind: 'configuration' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('never leaks the panel reference in an error message, whatever the failure mode', async () => {
    const failures: readonly (typeof fetch)[] = [
      returningText('nope', 401),
      () =>
        Promise.reject(
          new Error(
            `connect ECONNREFUSED https://console.melipayamak.com/api/send/otp/${PANEL_FIXTURE}`,
          ),
        ),
    ];

    for (const fetchImpl of failures) {
      const provider = providerWith(fetchImpl);

      try {
        await provider.sendOtp({ to: '09123456789', code: '1' });
        throw new Error('expected the adapter to fail');
      } catch (error) {
        expect(error).toBeInstanceOf(SmsProviderError);

        const message = error instanceof Error ? error.message : '';
        expect(message).not.toContain(PANEL_FIXTURE);
        expect(message).not.toContain('console.melipayamak.com');
      }
    }
  });
});
