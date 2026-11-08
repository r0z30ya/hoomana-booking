/**
 * hbook — API key management (create, list, revoke, rotate).
 * Revocation is immediate: the next request with a revoked key gets 401.
 * Keys are stored as SHA-256 hashes only, never logged, never re-shown.
 * Scopes are hierarchical: admin > manage > book > read — a new key can
 * only receive scopes the CALLING key already has (no privilege escalation).
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { notFound, unprocessable } from '../lib/errors';
import { cursorArg, pageResult, parsePage } from '../lib/paginate';
import { generateApiKey } from '../lib/keys';
import { hasScope, type Scope } from '../plugins/auth';
import { prisma } from '../lib/prisma';
import { R } from '../schemas/core';
import { ApiKeyCreateBody, ApiKeyCreated, ApiKeyRef, ApiKeysList } from '../schemas/resources';

type CreateRequest = FastifyRequest<{ Body: { name?: string; expiresAt?: string; scopes?: string[] } }>;

const VALID_SCOPES: Scope[] = ['admin', 'manage', 'book', 'read'];
const SCOPE_RANK: Record<string, number> = { read: 1, book: 2, manage: 3, admin: 4 };

function parseScopes(requested: string[] | undefined, creatorScopes: Scope[] | undefined): Scope[] {
  if (!requested || requested.length === 0) return ['admin'];
  const clean = [...new Set(requested)];
  for (const s of clean) {
    if (!VALID_SCOPES.includes(s as Scope)) {
      throw unprocessable('SCOPE_INVALID', `Unknown scope "${s}". Valid: ${VALID_SCOPES.join(', ')}.`);
    }
  }
  if (!hasScope(creatorScopes, 'admin')) {
    throw unprocessable('SCOPE_INSUFFICIENT', 'Only keys with the admin scope can create API keys.');
  }
  // every requested scope must be within the creator's power
  const creatorRank = Math.max(...(creatorScopes ?? []).map((s) => SCOPE_RANK[s] ?? 0));
  for (const s of clean) {
    if ((SCOPE_RANK[s] ?? 0) > creatorRank) {
      throw unprocessable('SCOPE_INSUFFICIENT', `Scope "${s}" exceeds the calling key's own scope.`);
    }
  }
  return clean as Scope[];
}

export default async function apiKeyRoutes(fastify: FastifyInstance): Promise<void> {
  const requireScope = fastify.requireScope.bind(fastify);

  fastify.post(
    '/api-keys',
    {
      preHandler: requireScope('admin'),
      schema: {
        summary: 'Create an additional API key',
        description:
          'The full key is returned ONCE. Keys are stored as SHA-256 hashes only. scopes (optional): admin | manage | book | read — always a subset of the calling key.',
        tags: ['API Keys'],
        security: [{ ApiKeyAuth: [] }],
        body: R('ApiKeyCreateBody'),
        response: { 201: R('ApiKeyCreated'), 422: R('Error') },
      },
    },
    async (req: CreateRequest, reply) => {
      const b = req.body;
      let expiresAt: Date | null = null;
      if (b.expiresAt) {
        expiresAt = new Date(b.expiresAt);
        if (Number.isNaN(expiresAt.getTime())) {
          throw unprocessable('INVALID_EXPIRES_AT', 'expiresAt must be a valid ISO 8601 date-time.');
        }
      }
      const scopes = parseScopes(b.scopes, req.apiKey!.scopes);
      const { key, prefix, hashedKey } = generateApiKey();
      const apiKey = await prisma.apiKey.create({
        data: {
          tenantId: req.tenant!.id,
          name: b.name ?? 'default',
          hashedKey,
          prefix,
          expiresAt,
          scopes,
        },
      });
      return reply.status(201).send({
        id: apiKey.id,
        name: apiKey.name,
        prefix: apiKey.prefix,
        scopes: apiKey.scopes,
        key,
        expiresAt: apiKey.expiresAt ? apiKey.expiresAt.toISOString() : null,
        createdAt: apiKey.createdAt.toISOString(),
      });
    },
  );

  fastify.get(
    '/api-keys',
    {
      preHandler: requireScope('admin'),
      schema: {
        summary: 'List API keys (secrets are never returned)',
        tags: ['API Keys'],
        security: [{ ApiKeyAuth: [] }],
        querystring: R('ListQuery'),
        response: { 200: R('ApiKeysList') },
      },
    },
    async (req) => {
      const page = parsePage(req.query as { limit?: number; cursor?: string });
      const rows = await prisma.apiKey.findMany({
        where: { tenantId: req.tenant!.id },
        select: {
          id: true,
          name: true,
          prefix: true,
          scopes: true,
          expiresAt: true,
          revokedAt: true,
          lastUsedAt: true,
          createdAt: true,
        },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: page.limit + 1,
        ...cursorArg(page.cursor),
      });
      return pageResult(rows, page.limit);
    },
  );

  fastify.delete(
    '/api-keys/:id',
    {
      preHandler: requireScope('admin'),
      schema: {
        summary: 'Revoke an API key (idempotent)',
        tags: ['API Keys'],
        security: [{ ApiKeyAuth: [] }],
        params: { type: 'object', required: ['id'], properties: { id: { type: 'string', maxLength: 64 } } },
        response: { 200: R('ApiKeyRef'), 404: R('Error') },
      },
    },
    async (req) => {
      const { id } = req.params as { id: string };
      const existing = await prisma.apiKey.findFirst({
        where: { id, tenantId: req.tenant!.id },
      });
      if (!existing) throw notFound('API key');
      if (existing.revokedAt) return toJSONSafe(existing);

      const updated = await prisma.apiKey.update({
        where: { id },
        data: { revokedAt: new Date() },
      });
      return toJSONSafe(updated);
    },
  );

  fastify.post(
    '/api-keys/:id/rotate',
    {
      preHandler: requireScope('admin'),
      schema: {
        summary: 'Rotate an API key — revokes the old key and issues a replacement atomically',
        description: 'The new full key is returned ONCE. Any request made with the old key afterwards gets 401.',
        tags: ['API Keys'],
        security: [{ ApiKeyAuth: [] }],
        params: { type: 'object', required: ['id'], properties: { id: { type: 'string', maxLength: 64 } } },
        response: { 201: R('ApiKeyCreated'), 404: R('Error') },
      },
    },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const existing = await prisma.apiKey.findFirst({
        where: { id, tenantId: req.tenant!.id },
      });
      if (!existing) throw notFound('API key');

      const { key, prefix, hashedKey } = generateApiKey();
      const rotated = await prisma.$transaction(async (tx) => {
        await tx.apiKey.update({ where: { id: existing.id }, data: { revokedAt: new Date() } });
        return tx.apiKey.create({
          data: {
            tenantId: existing.tenantId,
            name: existing.name,
            hashedKey,
            prefix,
            expiresAt: existing.expiresAt,
            scopes: existing.scopes,
          },
        });
      });
      req.log.info({ apiKeyId: rotated.id, tenantId: rotated.tenantId }, 'api key rotated');
      return reply.status(201).send({
        id: rotated.id,
        name: rotated.name,
        prefix: rotated.prefix,
        scopes: rotated.scopes,
        key,
        expiresAt: rotated.expiresAt ? rotated.expiresAt.toISOString() : null,
        createdAt: rotated.createdAt.toISOString(),
      });
    },
  );
}

function toJSONSafe(row: {
  id: string;
  name: string;
  prefix: string;
  scopes?: string[];
  expiresAt: Date | null;
  revokedAt: Date | null;
  lastUsedAt: Date | null;
  createdAt: Date;
}) {
  return {
    id: row.id,
    name: row.name,
    prefix: row.prefix,
    scopes: row.scopes ?? ['admin'],
    expiresAt: row.expiresAt ? row.expiresAt.toISOString() : null,
    revokedAt: row.revokedAt ? row.revokedAt.toISOString() : null,
    lastUsedAt: row.lastUsedAt ? row.lastUsedAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
  };
}

