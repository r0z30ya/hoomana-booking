/**
 * hbook — API key authentication.
 *
 * Design notes:
 *  - Keys are looked up by SHA-256 hash (unique index) — no timing side
 *    channel, one indexed B-tree probe per request.
 *  - lastUsedAt is written at most once per minute per key (in-memory
 *    throttle) so authentication stays a single read in the hot path.
 *  - Registered with fastify-plugin so the decoration is visible to all routes.
 */
import fp from 'fastify-plugin';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { unauthorized } from '../lib/errors';
import { hashApiKey } from '../lib/keys';
import { prisma } from '../lib/prisma';

export interface ApiKeyContext {
  id: string;
  name: string;
  prefix: string;
  expiresAt: Date | null;
}

const LAST_USED_INTERVAL_MS = 60_000;
const lastUsedCache = new Map<string, number>();

async function requireApiKey(request: FastifyRequest, _reply: FastifyReply): Promise<void> {
  const h = request.headers;
  let raw = typeof h['x-api-key'] === 'string' ? (h['x-api-key'] as string) : undefined;
  if (!raw && typeof h.authorization === 'string' && h.authorization.startsWith('Bearer ')) {
    raw = h.authorization.slice(7).trim();
  }
  if (!raw) {
    throw unauthorized('UNAUTHORIZED', 'Provide an API key via the "X-API-Key" header.');
  }

  const key = await prisma.apiKey.findUnique({
    where: { hashedKey: hashApiKey(raw) },
    include: { tenant: true },
  });
  if (!key) throw unauthorized('INVALID_API_KEY', 'API key not recognized.');
  if (key.revokedAt) throw unauthorized('API_KEY_REVOKED', 'This API key has been revoked.');
  if (key.expiresAt && key.expiresAt.getTime() < Date.now()) {
    throw unauthorized('API_KEY_EXPIRED', 'This API key has expired.');
  }

  request.tenant = key.tenant;
  request.apiKey = { id: key.id, name: key.name, prefix: key.prefix, expiresAt: key.expiresAt };

  const now = Date.now();
  if (now - (lastUsedCache.get(key.id) ?? 0) > LAST_USED_INTERVAL_MS) {
    lastUsedCache.set(key.id, now);
    void prisma.apiKey
      .update({ where: { id: key.id }, data: { lastUsedAt: new Date() } })
      .catch(() => undefined);
  }
}

export default fp(
  async (fastify: FastifyInstance) => {
    fastify.decorateRequest('tenant', undefined);
    fastify.decorateRequest('apiKey', undefined);
    fastify.decorate('requireApiKey', requireApiKey);
  },
  { name: 'hbook-auth' },
);
