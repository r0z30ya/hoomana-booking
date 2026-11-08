/**
 * hbook — API key authentication with hierarchical scopes.
 *
 * Design notes:
 *  - Keys are looked up by SHA-256 hash (unique index) — no timing side
 *    channel, one indexed B-tree probe per request.
 *  - lastUsedAt is written at most once per minute per key (in-memory
 *    throttle) so authentication stays a single read in the hot path.
 *  - Scopes (hierarchical): admin > manage > book > read.
 *      read   → GET /me, GET /slots, GET /bookings…
 *      book   → create / cancel / confirm / reschedule bookings
 *      manage → users, event types, availability, webhooks
 *      admin  → everything, incl. API key management
 *  - Invalid-key abuse limiter: failed authentications are counted per IP
 *    (fixed 1-minute window). Rotating random keys cannot brute-force —
 *    after AUTH_FAIL_LIMIT failures within a minute the IP gets 429.
 *  - Registered with fastify-plugin so decorations are visible to all routes.
 */
import fp from 'fastify-plugin';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { AppError, unauthorized } from '../lib/errors';
import { hashApiKey } from '../lib/keys';
import { prisma } from '../lib/prisma';
import { config } from '../config';

export type Scope = 'admin' | 'manage' | 'book' | 'read';

const SCOPE_RANK: Record<Scope, number> = { read: 1, book: 2, manage: 3, admin: 4 };

export interface ApiKeyContext {
  id: string;
  name: string;
  prefix: string;
  scopes: Scope[];
  expiresAt: Date | null;
}

/** True when the key's scopes satisfy the required scope. */
export function hasScope(scopes: string[] | undefined, need: Scope): boolean {
  if (!scopes || scopes.length === 0) return false;
  const needRank = SCOPE_RANK[need];
  return scopes.some((s) => (SCOPE_RANK[s as Scope] ?? 0) >= needRank);
}

// ── invalid-key abuse limiter (per IP, fixed 1-minute window) ─────────
const failWindowMs = 60_000;
const failCounts = new Map<string, { count: number; resetAt: number }>();

function recordAuthFailure(ip: string): number {
  const now = Date.now();
  const entry = failCounts.get(ip);
  if (!entry || entry.resetAt <= now) {
    failCounts.set(ip, { count: 1, resetAt: now + failWindowMs });
    return 1;
  }
  entry.count += 1;
  return entry.count;
}

function authFailCount(ip: string): number {
  const now = Date.now();
  const entry = failCounts.get(ip);
  if (!entry || entry.resetAt <= now) return 0;
  return entry.count;
}

// periodic cleanup so the map cannot grow unbounded
const cleanup = setInterval(() => {
  const now = Date.now();
  for (const [k, v] of failCounts) if (v.resetAt <= now) failCounts.delete(k);
}, failWindowMs);
cleanup.unref?.();

async function requireApiKey(request: FastifyRequest, _reply: FastifyReply): Promise<void> {
  const h = request.headers;
  const raw =
    typeof h['x-api-key'] === 'string'
      ? (h['x-api-key'] as string)
      : typeof h.authorization === 'string' && h.authorization.startsWith('Bearer ')
        ? h.authorization.slice(7).trim()
        : undefined;

  if (!raw) {
    throw unauthorized('UNAUTHORIZED', 'Provide an API key via the "X-API-Key" header.');
  }

  // brute-force guard: too many failed keys from this IP → 429
  if (authFailCount(request.ip) >= config.authFailLimit) {
    throw new AppError(429, 'RATE_LIMITED', 'Too many invalid API key attempts. Wait a minute and try again.');
  }

  const key = await prisma.apiKey.findUnique({
    where: { hashedKey: hashApiKey(raw) },
    include: { tenant: true },
  });
  if (!key) {
    recordAuthFailure(request.ip);
    throw unauthorized('INVALID_API_KEY', 'API key not recognized.');
  }
  if (key.revokedAt) {
    recordAuthFailure(request.ip);
    throw unauthorized('API_KEY_REVOKED', 'This API key has been revoked.');
  }
  if (key.expiresAt && key.expiresAt.getTime() < Date.now()) {
    recordAuthFailure(request.ip);
    throw unauthorized('API_KEY_EXPIRED', 'This API key has expired.');
  }

  request.tenant = key.tenant;
  request.apiKey = {
    id: key.id,
    name: key.name,
    prefix: key.prefix,
    scopes: (key.scopes ?? ['admin']) as Scope[],
    expiresAt: key.expiresAt,
  };

  const now = Date.now();
  if (now - (_lastUsed.get(key.id) ?? 0) > LAST_USED_INTERVAL_MS) {
    _lastUsed.set(key.id, now);
    void prisma.apiKey
      .update({ where: { id: key.id }, data: { lastUsedAt: new Date() } })
      .catch(() => undefined);
  }
}

const LAST_USED_INTERVAL_MS = 60_000;
const _lastUsed = new Map<string, number>();

/** Route-level preHandler enforcing a minimum scope. */
export function requireScope(need: Scope) {
  // MUST be async: Fastify 5.12 hangs on sync preHandlers that return undefined.
  return async (request: FastifyRequest): Promise<void> => {
    if (!hasScope(request.apiKey?.scopes, need)) {
      throw new AppError(
        403,
        'SCOPE_INSUFFICIENT',
        `This API key is not allowed to perform this action (requires scope "${need}").`,
      );
    }
  };
}

declare module 'fastify' {
  interface FastifyInstance {
    requireScope: (need: Scope) => (request: FastifyRequest) => void;
  }
}

export default fp(
  async (fastify: FastifyInstance) => {
    fastify.decorateRequest('tenant', undefined);
    fastify.decorateRequest('apiKey', undefined);
    fastify.decorate('requireApiKey', requireApiKey);
    fastify.decorate('requireScope', requireScope);
  },
  { name: 'hbook-auth' },
);
