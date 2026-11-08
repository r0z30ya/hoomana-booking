/**
 * hbook — webhook dispatcher.
 *
 * - Envelope: { id, event, createdAt, data }
 * - Signature header:  X-HBook-Signature: t=<unix seconds>,v1=HMAC_SHA256(secret, "t.body")
 * - Fire-and-forget with exponential-backoff retries (1s, 4s, 16s) and a
 *   persisted delivery log (WebhookDelivery) for observability.
 * - Delivery failures never propagate into the main API request.
 */
import { createHmac, randomUUID } from 'node:crypto';
import type { Webhook } from '@prisma/client';
import { Prisma } from '@prisma/client';
import { config } from '../config';
import { prisma } from './prisma';

export const WEBHOOK_EVENTS = [
  'booking.created',
  'booking.confirmed',
  'booking.cancelled',
  'booking.rescheduled',
  'ping',
] as const;

export type WebhookEvent = (typeof WEBHOOK_EVENTS)[number];

export function signPayload(secret: string, timestamp: number, body: string): string {
  return createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
}

export function dispatchWebhooks(tenantId: string, event: WebhookEvent, data: unknown): void {
  prisma.webhook
    .findMany({ where: { tenantId, isActive: true, events: { has: event } } })
    .then((hooks) => {
      for (const hook of hooks) {
        void deliver(hook, event, data, 1);
      }
    })
    .catch(() => {
      /* webhook lookup must never break the main request */
    });
}

async function deliver(hook: Webhook, event: WebhookEvent, data: unknown, attempt: number): Promise<void> {
  const envelope = {
    id: randomUUID(),
    event,
    createdAt: new Date().toISOString(),
    data,
  };
  const body = JSON.stringify(envelope);
  const timestamp = Math.floor(Date.now() / 1000);
  const signature = `t=${timestamp},v1=${signPayload(hook.secret, timestamp, body)}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.webhook.timeoutMs);
  timer.unref?.();

  let success = false;
  let statusCode: number | null = null;
  let error: string | null = null;

  try {
    const res = await fetch(hook.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'user-agent': 'hbook-webhooks/1.0',
        'x-hbook-event': event,
        'x-hbook-signature': signature,
      },
      body,
      signal: controller.signal,
    });
    statusCode = res.status;
    success = res.ok;
    if (!success) error = `HTTP ${res.status}`;
    // drain the response body so the socket is released
    await res.arrayBuffer().catch(() => undefined);
  } catch (e: unknown) {
    const err = e as Error;
    error =
      err?.name === 'AbortError'
        ? `timeout after ${config.webhook.timeoutMs}ms`
        : String(err?.message ?? err);
  } finally {
    clearTimeout(timer);
  }

  try {
    await prisma.webhookDelivery.create({
      data: {
        webhookId: hook.id,
        tenantId: hook.tenantId,
        event,
        payload: envelope as unknown as Prisma.InputJsonValue,
        attempt,
        success,
        statusCode,
        error,
      },
    });
  } catch {
    /* delivery logging must never throw */
  }

  if (!success && attempt < config.webhook.maxAttempts) {
    const delayMs = Math.round(1000 * Math.pow(4, attempt - 1)); // 1s, 4s, 16s
    const t = setTimeout(() => void deliver(hook, event, data, attempt + 1), delayMs);
    t.unref?.();
  }
}
