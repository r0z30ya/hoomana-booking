/**
 * hbook — webhook endpoints (Stripe-style: the signing secret is shown once).
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { notFound, unprocessable } from '../lib/errors';
import { cursorArg, pageResult, parsePage } from '../lib/paginate';
import { generateWebhookSecret } from '../lib/keys';
import { prisma } from '../lib/prisma';
import { dispatchWebhooks } from '../lib/webhooks';
import { R } from '../schemas/core';
import { DeliveriesList, WebhookCreateBody, WebhookCreated, WebhookRef, WebhooksList } from '../schemas/resources';

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
  fastify.post(
    '/webhooks',
    {
      schema: {
        summary: 'Create a webhook endpoint',
        description:
          'Emits signed events (HMAC-SHA256) to your URL. The signing secret is returned ONCE. Verify the "X-HBook-Signature: t=<ts>,v1=<hex>" header against HMAC_SHA256(secret, "<ts>.<rawBody>").',
        tags: ['Webhooks'],
        security: [{ ApiKeyAuth: [] }],
        body: R('WebhookCreateBody'),
        response: { 201: R('WebhookCreated'), 422: R('Error') },
      },
    },
    async (req: CreateRequest, reply) => {
      const b = req.body;
      if (!/^https?:\/\//i.test(b.url)) {
        throw unprocessable('INVALID_URL', 'Webhook URL must start with http:// or https://.');
      }
      const secret = b.secret ?? generateWebhookSecret();
      const webhook = await prisma.webhook.create({
        data: {
          tenantId: req.tenant!.id,
          url: b.url,
          secret,
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
      schema: {
        summary: 'Delete a webhook endpoint (its delivery log is removed too)',
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
      schema: {
        summary: 'Recent webhook delivery attempts (newest first)',
        tags: ['Webhooks'],
        security: [{ ApiKeyAuth: [] }],
        params: { type: 'object', required: ['id'], properties: { id: { type: 'string', maxLength: 64 } } },
        querystring: R('ListQuery'),
        response: { 200: R('DeliveriesList'), 404: R('Error') },
      },
    },
    async (req) => {
      const { id } = req.params as { id: string };
      await requireWebhook(req.tenant!.id, id);

      const page = parsePage(req.query as { limit?: number; cursor?: string });
      const rows = await prisma.webhookDelivery.findMany({
        where: { webhookId: id, tenantId: req.tenant!.id },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: page.limit + 1,
        ...cursorArg(page.cursor),
      });
      return pageResult(rows, page.limit);
    },
  );

  fastify.post(
    '/webhooks/:id/ping',
    {
      schema: {
        summary: 'Send a signed test ping to this webhook',
        tags: ['Webhooks'],
        security: [{ ApiKeyAuth: [] }],
        params: { type: 'object', required: ['id'], properties: { id: { type: 'string', maxLength: 64 } } },
        response: { 202: { type: 'object', properties: { sent: { type: 'boolean' } }, required: ['sent'] }, 404: R('Error') },
      },
    },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const webhook = await requireWebhook(req.tenant!.id, id);
      if (!webhook.isActive) {
        throw unprocessable('WEBHOOK_INACTIVE', 'This webhook is inactive — re-create it to receive events.');
      }
      dispatchWebhooks(req.tenant!.id, 'ping', {
        webhookId: id,
        message: 'hbook webhook test ping',
        sentAt: new Date().toISOString(),
      });
      return reply.status(202).send({ sent: true });
    },
  );
}
