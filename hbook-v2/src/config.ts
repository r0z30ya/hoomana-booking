/**
 * hbook — configuration
 * Zero-dependency .env loader + fail-fast validation.
 * All secrets come from the environment; nothing is hardcoded.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

/** Tiny .env loader (does not override variables already set). */
function loadDotEnv(file = '.env'): void {
  try {
    const full = path.resolve(process.cwd(), file);
    if (!fs.existsSync(full)) return;
    const lines = fs.readFileSync(full, 'utf8').split(/\r?\n/);
    for (const line of lines) {
      if (line.trim().startsWith('#')) continue;
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
      if (!m) continue;
      let value = m[2];
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      if (!(m[1] in process.env)) process.env[m[1]] = value;
    }
  } catch {
    /* ignore unreadable .env */
  }
}
loadDotEnv();

function required(name: string): string {
  const v = process.env[name];
  if (!v || !v.trim()) {
    throw new Error(`[hbook] Missing required environment variable: ${name}`);
  }
  return v.trim();
}

function int(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw || !raw.trim()) return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`[hbook] Environment variable ${name} must be a positive integer`);
  }
  return n;
}

function bool(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (!raw || !raw.trim()) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(raw.trim().toLowerCase());
}

const isProd = (process.env.NODE_ENV ?? 'development').toLowerCase() === 'production';

let setupToken = process.env.HBOOK_SETUP_TOKEN?.trim() ?? '';
if (!setupToken) {
  if (isProd) {
    throw new Error(
      '[hbook] HBOOK_SETUP_TOKEN is required in production. Generate one with: openssl rand -hex 32',
    );
  }
  setupToken = 'dev-setup-token';
}

// Webhook signing secrets MUST be encrypted at rest in production.
const webhookEncKey = process.env.HBOOK_WEBHOOK_ENC_KEY?.trim() ?? '';
if (isProd && !webhookEncKey) {
  throw new Error(
    '[hbook] HBOOK_WEBHOOK_ENC_KEY is required in production (openssl rand -base64 32). ' +
    'It encrypts webhook signing secrets at rest.',
  );
}

function intList(name: string, fallback: number[]): number[] {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const list = raw.split(',').map((s) => Number.parseInt(s.trim(), 10)).filter((n) => Number.isFinite(n) && n >= 0);
  return list.length > 0 ? list : fallback;
}

export const config = {
  env: process.env.NODE_ENV ?? 'development',
  isProd,
  port: int('PORT', 3000),
  host: process.env.HOST?.trim() || '0.0.0.0',
  databaseUrl: required('DATABASE_URL'),
  setupToken,
  corsOrigins: (process.env.CORS_ORIGINS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
  rateLimitMax: int('RATE_LIMIT_MAX', 300),
  rateLimitWindowMs: 60_000,
  /** Extra limiter: auth failures (bad/rotating keys) per IP per minute. */
  authFailLimit: int('AUTH_FAIL_LIMIT', 30),
  trustProxy: bool('TRUST_PROXY', false),
  logLevel: process.env.LOG_LEVEL?.trim() || (isProd ? 'warn' : 'info'),
  webhook: {
    timeoutMs: int('WEBHOOK_TIMEOUT_MS', 5_000),
    /** Backoff schedule; attempts = backoffMs.length + 1. */
    backoffMs: intList('WEBHOOK_BACKOFF_MS', [1_000, 4_000, 16_000, 64_000]),
    concurrency: int('WEBHOOK_CONCURRENCY', 5),
    tickMs: int('WEBHOOK_TICK_MS', 500),
    maxRedirects: int('WEBHOOK_MAX_REDIRECTS', 3),
    /** AES key for encrypting webhook secrets at rest. */
    encKey: webhookEncKey,
    /** Plain http destinations: only outside production + explicit flag. */
    allowInsecureHttp: bool('HBOOK_WEBHOOK_ALLOW_INSECURE_HTTP', false),
    /** Private/loopback destinations: only outside production + explicit flag
     *  (test escape hatch — e.g. a receiver on 127.0.0.1). */
    allowPrivateIps: bool('HBOOK_WEBHOOK_ALLOW_PRIVATE_IPS', false),
  },
  /** Idempotency-Key records are kept (and replayable) for this long. */
  idempotencyTtlHours: int('IDEMPOTENCY_TTL_HOURS', 24),
  /** Default booking window for event types, unless overridden. */
  defaultMaxLeadDays: 60,
  /** Hard cap for GET /v1/slots date range. */
  maxSlotRangeDays: 62,
  /** Default timezone for tenants/users when not provided. */
  defaultTimezone: 'Asia/Tehran',
} as const;

export type Config = typeof config;
