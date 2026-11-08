/**
 * hbook — API key management (create, list, revoke).
 * Revocation is immediate: the next request with a revoked key gets 401.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { notFound, unprocessable } from '../lib/errors';
import { cursorArg, pageResult, parsePage } from '../lib/paginate';
import { generateApiKey } from '../lib/keys';
import { prisma } from '../lib/prisma';
import { R } from '../schemas/core';
import { ApiKeyCreateBody, ApiKeyCreated, ApiKeyRef, ApiKeysList } from '../schemas/resources';

type CreateRequest = FastifyRequest<{ Body: { name?: string; expiresAt?: string } }>;

export default async function apiKeyRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.post(
    '/api-keys',
    {
      schema: {
        summary: 'Create an additional API key',
        description: 'The full key is returned ONCE. Keys are stored as SHA-256 hashes only.',
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
      const { key, prefix, hashedKey } = generateApiKey();
      const apiKey = await prisma.apiKey.create({
        data: {
          tenantId: req.tenant!.id,
          name: b.name ?? 'default',
          hashedKey,
          prefix,
          expiresAt,
        },
      });
      return reply.status(201).send({
        id: apiKey.id,
        name: apiKey.name,
        prefix: apiKey.prefix,
        key,
        expiresAt: apiKey.expiresAt ? apiKey.expiresAt.toISOString() : null,
        createdAt: apiKey.createdAt.toISOString(),
      });
    },
  );

  fastify.get(
    '/api-keys',
    {
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
}

function toJSONSafe(row: {
  id: string;
  name: string;
  prefix: string;
  expiresAt: Date | null;
  revokedAt: Date | null;
  lastUsedAt: Date | null;
  createdAt: Date;
}) {
  return {
    id: row.id,
    name: row.name,
    prefix: row.prefix,
    expiresAt: row.expiresAt ? row.expiresAt.toISOString() : null,
    revokedAt: row.revokedAt ? row.revokedAt.toISOString() : null,
    lastUsedAt: row.lastUsedAt ? row.lastUsedAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
  };
}
