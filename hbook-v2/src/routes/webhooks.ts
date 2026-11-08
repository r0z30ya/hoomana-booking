/**
 * hbook — webhook endpoints (Stripe-style: the signing secret is shown once).
 *
 * v2:
 *  - Destination URLs are SSRF-validated at creation (public host, https
 *    mandatory in production) and re-validated on every delivery attempt.
 *  - The signing secret is stored ENCRYPTED (AES-256-GCM, key from
 *    HBOOK_WEBHOOK_ENC_KEY) and never returned after creation.
 *  - Deliveries are persistent queue rows (transactional outbox): they
 *    survive restarts, retry with bounded backoff and can be replayed.
 *  - The payload data carries NO patient PII.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { notFound, unprocessable } from '../lib/errors';
import { cursorArg, pageResult, parsePage } from '../lib/paginate';
import { generateWebhookSecret } from '../lib/keys';
import { prisma } from '../lib/prisma';
import { assertWebhookUrl } from '../lib/ssrf';
import { encryptSecret } from '../lib/webhookCrypto';
import { emitWebhookEvent } from '../lib/webhooks';
import { R } from '../schemas/core';
import {
  DeliveriesList,
  WebhookCreateBody,
  WebhookCreated,
  WebhookRef,
  WebhooksList,
} from '../schemas/resources';

type CreateRequest = FastifyRequest<{
  Body: { url: string; events: string[]; secret?: string };
}>;

async function requireWebhook(tenantId: string, id: string) {
  const webhook = await prisma.webhook.findFirst({
    where: { id, tenantId },
    select: { id: true, isActive: true },
  });
  if (!webhook) throw notFound('Webhook');
  return webhook;
}

export default async function webhookRoutes(fastify: FastifyInstance): Promise<void> {
  const requireScope = fastify.requireScope.bind(fastify);

  fastify.post(
    '/webhooks',
    {
      preHandler: requireScope('manage'),
      schema: {
        summary: 'Create a webhook endpoint',
        description:
          'Emits signed events (HMAC-SHA256) to your URL. HTTPS is required in production; localhost/private-network/link-local targets are rejected. The signing secret is returned ONCE and stored encrypted.',
        tags: ['Webhooks'],
        security: [{ ApiKeyAuth: [] }],
        body: R('WebhookCreateBody'),
        response: { 201: R('WebhookCreated'), 422: R('Error') },
      },
    },
    async (req: CreateRequest, reply) => {
      const b = req.body;
      // SSRF guard — resolves DNS and rejects private/loopback/link-local
      const target = await assertWebhookUrl(b.url, { forCreation: true });

      const secret = b.secret ?? generateWebhookSecret();
      const webhook = await prisma.webhook.create({
        data: {
          tenantId: req.tenant!.id,
          url: `${target.protocol}//${target.hostname}${target.port ? `:${target.port}` : ''}${target.path}`,
          secret: encryptSecret(secret),
          events: b.events,
        },
      });
      return reply.status(201).send({
        id: webhook.id,
        url: webhook.url,
        events: webhook.events,
        isActive: webhook.isActive,
        createdAt: webhook.createdAt.toISOString(),
        secret,
      });
    },
  );

  fastify.get(
    '/webhooks',
    {
      preHandler: requireScope('manage'),
      schema: {
        summary: 'List webhook endpoints',
        tags: ['Webhooks'],
        security: [{ ApiKeyAuth: [] }],
        querystring: R('ListQuery'),
        response: { 200: R('WebhooksList') },
      },
    },
    async (req) => {
      const page = parsePage(req.query as { limit?: number; cursor?: string });
      const rows = await prisma.webhook.findMany({
        where: { tenantId: req.tenant!.id },
        select: { id: true, url: true, events: true, isActive: true, createdAt: true },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: page.limit + 1,
        ...cursorArg(page.cursor),
      });
      return pageResult(rows, page.limit);
    },
  );

  fastify.delete(
    '/webhooks/:id',
    {
      preHandler: requireScope('manage'),
      schema: {
        summary: 'Delete a webhook endpoint (its queue rows are removed too)',
        tags: ['Webhooks'],
        security: [{ ApiKeyAuth: [] }],
        params: { type: 'object', required: ['id'], properties: { id: { type: 'string', maxLength: 64 } } },
        response: { 200: { type: 'object', properties: { deleted: { type: 'boolean' } }, required: ['deleted'] }, 404: R('Error') },
      },
    },
    async (req) => {
      const { id } = req.params as { id: string };
      await requireWebhook(req.tenant!.id, id);
      await prisma.webhook.delete({ where: { id } });
      return { deleted: true };
    },
  );

  fastify.get(
    '/webhooks/:id/deliveries',
    {
      preHandler: requireScope('manage'),
      schema: {
        summary: 'Webhook delivery queue rows (newest first)',
        description:
          'status: PENDING (waiting/retrying) · PROCESSING (in flight) · DELIVERED · FAILED (retries exhausted). payload = the delivered envelope data.',
        tags: ['Webhooks'],
        security: [{ ApiKeyAuth: [] }],
        params: { type: 'object', required: ['id'], properties: { id: { type: 'string', maxLength: 64 } } },
        querystring: {
          type: 'object',
          properties: {
            limit: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
            cursor: { type: 'string', maxLength: 128 },
            status: { type: 'string', enum: ['PENDING', 'PROCESSING', 'DELIVERED', 'FAILED'] },
          },
        },
        response: { 200: R('DeliveriesList'), 404: R('Error') },
      },
    },
    async (req) => {
      const { id } = req.params as { id: string };
      await requireWebhook(req.tenant!.id, id);

      const q = req.query as { limit?: number; cursor?: string; status?: string };
      const page = parsePage(q);
      const rows = await prisma.webhookDelivery.findMany({
        where: {
          webhookId: id,
          tenantId: req.tenant!.id,
          ...(q.status ? { status: q.status as 'PENDING' | 'PROCESSING' | 'DELIVERED' | 'FAILED' } : {}),
        },
        include: { event: { select: { id: true, type: true, data: true, createdAt: true } } },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: page.limit + 1,
        ...cursorArg(page.cursor),
      });
      const result = pageResult(
        rows.map((r) => ({
          id: r.id,
          event: r.eventType,
          eventId: r.event.id,
          status: r.status,
          attempts: r.attempts,
          nextAttemptAt: r.nextAttemptAt,
          lastAttemptAt: r.lastAttemptAt,
          statusCode: r.lastStatusCode,
          error: r.lastError,
          payload: {
            id: r.event.id,
            event: r.event.type,
            createdAt: r.event.createdAt,
            data: r.event.data,
          },
          createdAt: r.createdAt,
        })),
        page.limit,
      );
      return JSON.parse(JSON.stringify(result));
    },
  );

  fastify.post(
    '/webhooks/:id/deliveries/:deliveryId/replay',
    {
      preHandler: requireScope('manage'),
      schema: {
        summary: 'Replay a FAILED (or any) delivery — re-queues it immediately',
        tags: ['Webhooks'],
        security: [{ ApiKeyAuth: [] }],
        params: {
          type: 'object',
          required: ['id', 'deliveryId'],
          properties: { id: { type: 'string', maxLength: 64 }, deliveryId: { type: 'string', maxLength: 64 } },
        },
        response: { 202: { type: 'object', properties: { queued: { type: 'boolean' } }, required: ['queued'] }, 404: R('Error') },
      },
    },
    async (req, reply) => {
      const { id, deliveryId } = req.params as { id: string; deliveryId: string };
      await requireWebhook(req.tenant!.id, id);
      const delivery = await prisma.webhookDelivery.findFirst({
        where: { id: deliveryId, webhookId: id, tenantId: req.tenant!.id },
        select: { id: true },
      });
      if (!delivery) throw notFound('Delivery');
      await prisma.webhookDelivery.update({
        where: { id: delivery.id },
        data: { status: 'PENDING', attempts: 0, nextAttemptAt: new Date(), lastError: null },
      });
      return reply.status(202).send({ queued: true });
    },
  );

  fastify.post(
    '/webhooks/:id/ping',
    {
      preHandler: requireScope('manage'),
      schema: {
        summary: 'Send a signed test ping to this webhook (via the outbox)',
        tags: ['Webhooks'],
        security: [{ ApiKeyAuth: [] }],
        params: { type: 'object', required: ['id'], properties: { id: { type: 'string', maxLength: 64 } } },
        response: { 202: { type: 'object', properties: { queued: { type: 'boolean' } }, required: ['queued'] }, 404: R('Error') },
      },
    },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const webhook = await requireWebhook(req.tenant!.id, id);
      if (!webhook.isActive) {
        throw unprocessable('WEBHOOK_INACTIVE', 'This webhook is inactive — re-create it to receive events.');
      }
      await emitWebhookEvent(req.tenant!.id, 'ping', {
        webhookId: id,
        message: 'hbook webhook test ping',
        sentAt: new Date().toISOString(),
      });
      return reply.status(202).send({ queued: true });
    },
  );
}
