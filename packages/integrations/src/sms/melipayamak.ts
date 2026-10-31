import {
  SmsProviderError,
  type SmsBulkInput,
  type SmsCredit,
  type SmsDeliveryState,
  type SmsDeliveryStatus,
  type SmsFreeTextInput,
  type SmsOtpInput,
  type SmsPatternInput,
  type SmsProvider,
  type SmsSendResult,
} from './types.js';

/**
 * Melipayamak console adapter (console.melipayamak.com).
 *
 * Implemented against the sample calls the owner supplied (2026-10-12):
 *   POST /api/send/otp/<ref>        { to }                 panel OTP pattern
 *   POST /api/send/shared/<ref>     { bodyId, to, args }   shared-service pattern
 *   POST /api/send/simple/<ref>     { from, to, text }     free text, one recipient
 *   POST /api/send/advanced/<ref>   { from, to, text }     one text, many recipients
 *   POST /api/receive/status/<ref>  { recIds }             delivery status
 *   GET  /api/receive/credit/<ref>                         panel balance
 *
 * The panel reference travels in the URL path (that is the provider's design), which
 * is exactly why this adapter never puts a URL into an error message or a log line.
 * `send/advanced` is wrapped as `sendBulk`; `send/multiple`, `send/schedule`,
 * `receive/messages`, `receive/inboxcount` and `receive/price` stay unwrapped until a
 * use case needs them.
 */
export interface MelipayamakConfig {
  /** Panel reference. It is confidential and is never logged or echoed in an error. */
  readonly panelRef: string;
  /** The panel's sender line, e.g. `50002710077565`. */
  readonly sender: string;
  readonly baseUrl?: string;
  readonly timeoutMs?: number;
  /** Injectable for tests. Defaults to the global fetch. */
  readonly fetchImpl?: typeof fetch;
}

const PROVIDER_NAME = 'melipayamak';
const DEFAULT_BASE_URL = 'https://console.melipayamak.com';
/** 10 s, per the provider notes in infra/docs/integrations/melipayamak.md. */
const DEFAULT_TIMEOUT_MS = 10_000;

/** Delivery codes observed for this provider (carried over from the legacy panel). */
const DELIVERED_CODES = new Set([2]);
const FAILED_CODES = new Set([3, 16]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function firstDefined(payload: Record<string, unknown>, keys: readonly string[]): unknown {
  for (const key of keys) {
    const value = payload[key];
    if (value !== undefined && value !== null) return value;
  }
  return undefined;
}

/** Text form of a value that genuinely is a string or a finite number. */
function toText(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return undefined;
}

function toTextList(value: unknown): readonly string[] {
  if (Array.isArray(value)) {
    return value.flatMap((entry) => {
      const text = toText(entry);
      return text === undefined ? [] : [text];
    });
  }

  const text = toText(value);
  return text === undefined ? [] : [text];
}

/**
 * Provider responses differ between console versions (a bare id, an array, or
 * `{ RecId, Value, RetStatus, StrRetStatus }`). Parsing stays tolerant instead of
 * assuming one shape; the first live call confirms which variant this panel returns.
 */
function extractRecIds(payload: unknown): readonly string[] {
  const direct = toTextList(payload);
  if (direct.length > 0) return direct;

  if (!isRecord(payload)) return [];

  return toTextList(
    firstDefined(payload, ['recId', 'RecId', 'recIds', 'RecIds', 'Value', 'value']),
  );
}

function extractStatusText(payload: unknown): string | undefined {
  if (!isRecord(payload)) return undefined;
  return toText(firstDefined(payload, ['StrRetStatus', 'strRetStatus', 'Status', 'status']));
}

function extractNumber(payload: unknown): number | undefined {
  if (typeof payload === 'number' && Number.isFinite(payload)) return payload;

  const text = toText(payload);
  if (text !== undefined) {
    const parsed = Number(text);
    return Number.isFinite(parsed) ? parsed : undefined;
  }

  if (!isRecord(payload)) return undefined;

  const value = firstDefined(payload, ['Value', 'value', 'Credit', 'credit']);
  if (typeof value === 'number' && Number.isFinite(value)) return value;

  const valueText = toText(value);
  if (valueText === undefined) return undefined;

  const parsed = Number(valueText);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function toDeliveryState(code: unknown): SmsDeliveryState {
  const numeric = typeof code === 'number' ? code : Number(toText(code));
  if (!Number.isFinite(numeric)) return 'unknown';
  if (DELIVERED_CODES.has(numeric)) return 'delivered';
  if (FAILED_CODES.has(numeric)) return 'failed';
  return 'pending';
}

function parseDeliveryStatuses(payload: unknown): readonly SmsDeliveryStatus[] {
  const rows = Array.isArray(payload) ? payload : isRecord(payload) ? [payload] : [];

  return rows.flatMap((row) => {
    if (!isRecord(row)) return [];

    const recId = toText(firstDefined(row, ['recId', 'RecId', 'id']));
    if (recId === undefined) return [];

    const code = firstDefined(row, ['status', 'Status', 'statusCode', 'StatusCode']);
    const providerCode = toText(code);

    return [
      {
        recId,
        state: toDeliveryState(code),
        ...(providerCode === undefined ? {} : { providerCode }),
      },
    ];
  });
}

/**
 * Turn an accepted send into the port's result shape.
 *
 * A response without a message id is not a success we can track: the message may in
 * fact have been accepted, so retrying could send it twice. This is why a missing id
 * throws a non-retryable `unexpected-response` instead of returning an empty list.
 */
function toSendResult(payload: unknown, provider: string): SmsSendResult {
  const recIds = extractRecIds(payload);

  if (recIds.length === 0) {
    throw new SmsProviderError('Melipayamak accepted the request without a message id', {
      kind: 'unexpected-response',
      provider,
    });
  }

  const statusText = extractStatusText(payload);

  return { recIds, ...(statusText === undefined ? {} : { providerStatus: statusText }) };
}

export function createMelipayamakProvider(config: MelipayamakConfig): SmsProvider {
  const baseUrl = (config.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const fetchImpl = config.fetchImpl ?? fetch;

  function assertConfigured(): void {
    if (config.panelRef.trim() === '') {
      throw new SmsProviderError('The Melipayamak panel reference is missing', {
        kind: 'configuration',
        provider: PROVIDER_NAME,
      });
    }
    if (config.sender.trim() === '') {
      throw new SmsProviderError('The Melipayamak sender line is missing', {
        kind: 'configuration',
        provider: PROVIDER_NAME,
      });
    }
  }

  /**
   * One request helper for every endpoint. The URL (which carries the panel
   * reference) never leaves this function: not in an error, not in a thrown cause.
   */
  async function request(
    path: string,
    init: { method: 'GET' | 'POST'; body?: unknown },
  ): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
    }, timeoutMs);

    try {
      const response = await fetchImpl(`${baseUrl}/api/${path}/${config.panelRef}`, {
        method: init.method,
        headers: { 'Content-Type': 'application/json' },
        ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
        signal: controller.signal,
      });

      const text = await response.text();

      if (!response.ok) {
        throw new SmsProviderError(
          `Melipayamak rejected the request with status ${response.status}`,
          {
            kind: response.status >= 500 ? 'provider' : 'invalid-request',
            provider: PROVIDER_NAME,
            status: response.status,
          },
        );
      }

      if (text.trim() === '') return undefined;

      try {
        return JSON.parse(text) as unknown;
      } catch {
        // A bare number/string is a legitimate response for this API.
        return text;
      }
    } catch (error) {
      if (error instanceof SmsProviderError) throw error;

      // Network failure or timeout. The original error is not attached: it can carry
      // the request URL, and that URL holds the panel reference.
      throw new SmsProviderError('Melipayamak is unreachable', {
        kind: 'unreachable',
        provider: PROVIDER_NAME,
      });
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    name: PROVIDER_NAME,

    async sendOtp(input: SmsOtpInput): Promise<SmsSendResult> {
      assertConfigured();
      const payload = await request('send/otp', { method: 'POST', body: { to: input.to } });
      return toSendResult(payload, PROVIDER_NAME);
    },

    async sendPattern(input: SmsPatternInput): Promise<SmsSendResult> {
      assertConfigured();
      const payload = await request('send/shared', {
        method: 'POST',
        body: {
          bodyId: input.bodyId,
          to: input.to,
          args: [...(input.args ?? [])],
        },
      });
      return toSendResult(payload, PROVIDER_NAME);
    },

    async sendFreeText(input: SmsFreeTextInput): Promise<SmsSendResult> {
      assertConfigured();
      const payload = await request('send/simple', {
        method: 'POST',
        body: { from: config.sender, to: input.to, text: input.text },
      });
      return toSendResult(payload, PROVIDER_NAME);
    },

    async sendBulk(input: SmsBulkInput): Promise<SmsSendResult> {
      assertConfigured();
      const payload = await request('send/advanced', {
        method: 'POST',
        body: { from: config.sender, to: [...input.to], text: input.text, udh: '' },
      });
      return toSendResult(payload, PROVIDER_NAME);
    },

    async fetchCredit(): Promise<SmsCredit> {
      assertConfigured();
      const payload = await request('receive/credit', { method: 'GET' });
      return { amount: extractNumber(payload) };
    },

    async fetchDeliveryStatus(recIds: readonly string[]): Promise<readonly SmsDeliveryStatus[]> {
      assertConfigured();
      if (recIds.length === 0) return [];
      const payload = await request('receive/status', { method: 'POST', body: { recIds } });
      return parseDeliveryStatuses(payload);
    },
  };
}
