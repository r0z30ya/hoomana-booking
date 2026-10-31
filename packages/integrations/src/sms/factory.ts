import { createMelipayamakProvider, type MelipayamakConfig } from './melipayamak.js';
import { SmsProviderError, type SmsProvider } from './types.js';

/**
 * SMS provider wiring.
 *
 * The platform's own panel (the central panel with credit) is one configuration of
 * the same adapter a tenant uses with their own panel reference, so nothing above this
 * file needs to know which provider is behind it: the API asks for `SmsProvider`.
 *
 * The environment shape below is structural on purpose — this package does not depend
 * on the environment schema. `loadEnvironment()` produces a superset of it, and the
 * API passes that object straight through.
 */
export interface SmsEnvironment {
  readonly SMS_PROVIDER: 'melipayamak';
  readonly SMS_MELIPAYAMAK_PANEL_REF?: string | undefined;
  readonly SMS_MELIPAYAMAK_SENDER?: string | undefined;
}

export interface SmsProviderConfig {
  readonly provider: 'melipayamak';
  /** Panel reference. It is confidential and is never logged or echoed in an error. */
  readonly panelRef: string;
  readonly sender: string;
  readonly baseUrl?: string;
  readonly timeoutMs?: number;
  /** Injectable for tests. Defaults to the global fetch. */
  readonly fetchImpl?: typeof fetch;
}

/**
 * True when the platform panel has configuration. Callers use this to decide whether a
 * platform-panel feature is available (a tenant panel is configured per tenant, in the
 * database, and never comes from the environment).
 */
export function isSmsConfigured(environment: SmsEnvironment): boolean {
  const panelRef = environment.SMS_MELIPAYAMAK_PANEL_REF;

  return panelRef !== undefined && panelRef.trim() !== '';
}

export function createSmsProvider(config: SmsProviderConfig): SmsProvider {
  // Held as a string so an unknown provider value can still fail closed at runtime
  // instead of being compiled away.
  const provider: string = config.provider;

  switch (provider) {
    case 'melipayamak': {
      const melipayamak: MelipayamakConfig = {
        panelRef: config.panelRef,
        sender: config.sender,
        ...(config.baseUrl === undefined ? {} : { baseUrl: config.baseUrl }),
        ...(config.timeoutMs === undefined ? {} : { timeoutMs: config.timeoutMs }),
        ...(config.fetchImpl === undefined ? {} : { fetchImpl: config.fetchImpl }),
      };

      return createMelipayamakProvider(melipayamak);
    }
    default:
      throw new SmsProviderError(`Unknown SMS provider "${provider}"`, {
        kind: 'configuration',
        provider: 'unknown',
      });
  }
}

/**
 * Build the platform provider from a validated environment.
 *
 * Fails closed: a missing panel reference is a configuration error, never a silently
 * disabled feature. `isSmsConfigured` exists so the API can decide *before* building
 * anything whether platform SMS is available at all.
 */
export function createSmsProviderFromEnvironment(
  environment: SmsEnvironment,
  options: {
    readonly baseUrl?: string;
    readonly timeoutMs?: number;
    readonly fetchImpl?: typeof fetch;
  } = {},
): SmsProvider {
  const panelRef = environment.SMS_MELIPAYAMAK_PANEL_REF;

  if (panelRef === undefined || panelRef.trim() === '') {
    throw new SmsProviderError(
      'The platform SMS panel is not configured (SMS_MELIPAYAMAK_PANEL_REF is missing)',
      { kind: 'configuration', provider: environment.SMS_PROVIDER },
    );
  }

  return createSmsProvider({
    provider: environment.SMS_PROVIDER,
    panelRef,
    sender: environment.SMS_MELIPAYAMAK_SENDER ?? '',
    ...options,
  });
}
