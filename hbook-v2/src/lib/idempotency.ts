import { createHash } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { conflict, unprocessable } from './errors';
import { prisma } from './prisma';
import { config } from '../config';

export function idempotencyKeyOf(req: FastifyRequest): string | null {
  const header = req.headers['idempotency-key'];
  if (typeof header !== 'string' || !header.trim()) return null;
  const key = header.trim();
  if (key.length > 200) throw unprocessable('IDEMPOTENCY_KEY_INVALID', 'Idempotency-Key must be at most 200 characters.');
  return key;
}

export async function withIdempotency(
  req: FastifyRequest,
  reply: FastifyReply,
  endpoint: string,
  fn: (tx: Prisma.TransactionClient) => Promise<{ status: number; body: unknown }>,
): Promise<unknown> {
  const key = idempotencyKeyOf(req);
  const tenantId = req.tenant!.id;
  const requestHash = createHash('sha256')
    .update(JSON.stringify({ params: req.params ?? null, body: req.body ?? null }))
    .digest('hex');

  const result = await prisma.$transaction(async (tx) => {
    if (key) {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`${tenantId}:${key}`}, 1))`;
      const existing = await tx.idempotencyKey.findUnique({ where: { tenantId_key: { tenantId, key } } });
      if (existing) {
        if (existing.endpoint !== endpoint || existing.requestHash !== requestHash) {
          throw unprocessable('IDEMPOTENCY_KEY_REUSED', 'This Idempotency-Key was already used with a different request.');
        }
        if (existing.responseStatus === null || existing.responseBody === null) {
          throw conflict('IDEMPOTENCY_IN_PROGRESS', 'The previous request has an incomplete idempotency record.');
        }
        return { status: existing.responseStatus, body: existing.responseBody, replay: true };
      }
    }

    const response = await fn(tx);
    if (key) {
      await tx.idempotencyKey.create({
        data: {
          tenantId,
          key,
          endpoint,
          requestHash,
          responseStatus: response.status,
          responseBody: response.body as Prisma.InputJsonValue,
        },
      });
    }
    return { ...response, replay: false };
  }, { maxWait: 10_000, timeout: 20_000 });

  if (result.replay) reply.header('x-hbook-idempotent-replay', 'true');
  return reply.status(result.status).send(result.body);
}

export const IDEMPOTENCY_TTL_MS = () => config.idempotencyTtlHours * 3_600_000;
