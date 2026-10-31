import { describe, expect, it, vi } from 'vitest';
import {
  createSmsProvider,
  createSmsProviderFromEnvironment,
  isSmsConfigured,
  type SmsEnvironment,
} from './factory.js';
import { SmsProviderError } from './types.js';

/**
 * Wiring tests: the factory is what the API and the worker will call, so the suite
 * pins down (a) that the selected provider really receives the configuration and
 * (b) that an unconfigured panel fails closed instead of silently doing nothing.
 *
 * `PANEL_FIXTURE` is a synthetic placeholder — a real panel reference lives in `.env`
 * only, never in a tracked file.
 */
const PANEL_FIXTURE = 'fixture-panel-ref';
const SENDER = '50002710077565';
const BLANK = '   ';

function environment(overrides: Partial<SmsEnvironment> = {}): SmsEnvironment {
  return { SMS_PROVIDER: 'melipayamak', ...overrides };
}

/** A fetch stub that always answers with the same body. */
function returning(body: string, status = 200): typeof fetch {
  return () => Promise.resolve(new Response(body, { status }));
}

/** The request body the adapter produced, decoded for assertions. */
function bodyOf(init: RequestInit): unknown {
  const body = init.body;
  if (typeof body !== 'string') throw new Error('expected a JSON string body');
  return JSON.parse(body) as unknown;
}

describe('SMS provider factory', () => {
  it('reports whether the platform panel is configured', () => {
    expect(isSmsConfigured(environment())).toBe(false);
    expect(isSmsConfigured(environment({ SMS_MELIPAYAMAK_PANEL_REF: BLANK }))).toBe(false);
    expect(isSmsConfigured(environment({ SMS_MELIPAYAMAK_PANEL_REF: PANEL_FIXTURE }))).toBe(true);
  });

  it('fails closed when the platform panel has no configuration', () => {
    expect(() => createSmsProviderFromEnvironment(environment())).toThrow(SmsProviderError);

    try {
      createSmsProviderFromEnvironment(environment());
      throw new Error('expected the factory to refuse an unconfigured panel');
    } catch (error) {
      expect(error).toMatchObject({
        name: 'SmsProviderError',
        kind: 'configuration',
        retryable: false,
      });
    }
  });

  it('builds a working provider from a configured environment', async () => {
    const fetchImpl = vi.fn(returning('12345'));
    const provider = createSmsProviderFromEnvironment(
      environment({ SMS_MELIPAYAMAK_PANEL_REF: PANEL_FIXTURE, SMS_MELIPAYAMAK_SENDER: SENDER }),
      { fetchImpl },
    );

    expect(provider.name).toBe('melipayamak');

    const result = await provider.sendFreeText({ to: '09123456789', text: 'test sms' });

    expect(result.recIds).toEqual(['12345']);

    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain('/api/send/simple/');
    expect(bodyOf(init)).toEqual({
      from: SENDER,
      to: '09123456789',
      text: 'test sms',
    });
  });

  it('rejects an unknown provider name at runtime instead of guessing', () => {
    expect(() =>
      createSmsProvider({
        provider: 'unknown-provider' as unknown as 'melipayamak',
        panelRef: PANEL_FIXTURE,
        sender: SENDER,
      }),
    ).toThrow(SmsProviderError);
  });
});
