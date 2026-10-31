/**
 * SMS port — the provider-agnostic boundary the rest of HMN depends on.
 *
 * Rationale (ADR-0004 §2.10, owner-approved): switching SMS providers must be a
 * configuration change, not a code change, because the product sells a **SMS panel
 * per tenant** (their own credentials) and a **central panel with credit** (ours).
 * Nothing outside `packages/integrations` may know a provider's URL shapes, status
 * codes or payload names.
 *
 * Provider credentials are **data**, not environment: a tenant's token belongs to
 * that tenant and is stored encrypted (ADR-0004 D-A pattern). Only the platform's own
 * panel credential may come from the environment.
 *
 * Security rule for every implementation: the request URL, headers and body are never
 * included in an error message or a log line. Melipayamak, for example, carries the
 * panel token inside the URL path, so a "helpful" error containing the URL would leak
 * a live credential.
 */

export interface SmsSendInput {
  /** Normalised Iranian mobile number: `09xxxxxxxxx`. */
  readonly to: string;
}

export interface SmsOtpInput extends SmsSendInput {
  /** OTP code to deliver. The panel's OTP pattern is defined on the panel itself. */
  readonly code: string;
}

export interface SmsPatternInput extends SmsSendInput {
  /** Shared-service pattern id (Melipayamak `bodyId`). */
  readonly bodyId: number;
  /** Pattern variables, in the order the pattern defines them. */
  readonly args?: readonly string[];
}

export interface SmsFreeTextInput extends SmsSendInput {
  readonly text: string;
}

/**
 * One text, several recipients, in a single call (Melipayamak `send/advanced`).
 *
 * This is the carrier for the "patient list per doctor" feature: one message body and
 * a recipient list. The 70-character segmentation into parts stays in the domain
 * module; the adapter carries text, it does not edit it.
 */
export interface SmsBulkInput {
  readonly to: readonly string[];
  readonly text: string;
}

/** Result of an accepted send. `recIds` are provider message ids used for status lookups. */
export interface SmsSendResult {
  readonly recIds: readonly string[];
  /**
   * Provider's own status text, kept verbatim for support cases.
   *
   * Declared as `X | undefined` on purpose: with `exactOptionalPropertyTypes` a
   * conditional spread (`...(status === undefined ? {} : { providerStatus: status })`)
   * produces `string | undefined`, which is not assignable to a bare `?: string`.
   * Same convention as the environment interfaces in this package.
   */
  readonly providerStatus?: string | undefined;
}

export type SmsDeliveryState = 'delivered' | 'failed' | 'pending' | 'unknown';

export interface SmsDeliveryStatus {
  readonly recId: string;
  readonly state: SmsDeliveryState;
  /** Raw provider status code, kept for diagnosis. */
  readonly providerCode?: string;
}

export interface SmsCredit {
  /** Panel balance in the provider's unit; `undefined` when the panel did not report one. */
  readonly amount: number | undefined;
}

export interface SmsProvider {
  /** Stable provider key used in logs, audit rows and the tenant's settings. */
  readonly name: string;

  sendOtp(input: SmsOtpInput): Promise<SmsSendResult>;
  sendPattern(input: SmsPatternInput): Promise<SmsSendResult>;
  sendFreeText(input: SmsFreeTextInput): Promise<SmsSendResult>;
  sendBulk(input: SmsBulkInput): Promise<SmsSendResult>;

  /** Current panel credit. */
  fetchCredit(): Promise<SmsCredit>;

  /** Delivery state for previously accepted messages. */
  fetchDeliveryStatus(recIds: readonly string[]): Promise<readonly SmsDeliveryStatus[]>;
}

export type SmsErrorKind =
  /** The adapter itself is misconfigured (missing panel reference or sender). */
  | 'configuration'
  /** The provider rejected the request: retrying the same payload cannot help. */
  | 'invalid-request'
  /** The provider failed on its side: retrying later is reasonable. */
  | 'provider'
  /** Network/timeout: retrying later is reasonable. */
  | 'unreachable'
  /**
   * The provider accepted the request but returned no message id, so the send can
   * neither be tracked nor confirmed. Never retried automatically: the message may
   * already be on its way, and a duplicate SMS costs money and annoys the patient.
   * The caller records the attempt and warns the operator instead.
   */
  | 'unexpected-response';

/**
 * Adapter-level failure.
 *
 * Deliberately carries no URL and no response body: both can contain the credential
 * or the message content. `retryable` is what the queue policy reads (ADR-0004 D-B),
 * so retry decisions never depend on string matching.
 */
export class SmsProviderError extends Error {
  readonly kind: SmsErrorKind;
  readonly provider: string;
  readonly status: number | undefined;
  readonly retryable: boolean;

  constructor(
    message: string,
    options: {
      readonly kind: SmsErrorKind;
      readonly provider: string;
      readonly status?: number | undefined;
    },
  ) {
    super(message);
    this.name = 'SmsProviderError';
    this.kind = options.kind;
    this.provider = options.provider;
    this.status = options.status;
    this.retryable = options.kind === 'provider' || options.kind === 'unreachable';
  }
}
