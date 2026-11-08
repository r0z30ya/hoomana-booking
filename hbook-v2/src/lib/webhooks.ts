/**
 * hbook — reliable webhook delivery (transactional outbox + worker).
 *
 * Design:
 *  1. Business mutations call `enqueueWebhookEvent(tx, …)` INSIDE their own
 *     transaction — the WebhookEvent row (outbox) and one WebhookDelivery
 *     queue row per subscribed webhook are committed atomically with the
 *     change. A crash can never lose an event.
 *  2. A worker claims due rows with SELECT … FOR UPDATE SKIP LOCKED (safe
 *     with multiple engine instances), POSTs them with a signed envelope and
 *     records the outcome. Rows survive restarts; PROCESSING rows stuck
 *     after a crash are swept back to PENDING → at-least-once delivery.
 *  3. Retry policy: bounded exponential backoff (1s, 4s, 16s, 64s by
 *     default), then FAILED. Failed deliveries can be replayed via the API.
 *  4. Stable event id: the outbox row id is reused for EVERY attempt of the
 *     same event (header X-HBook-Event-Id) so consumers can dedupe.
 *  5. Destinations are SSRF-guarded (public IPs only, HTTPS mandatory in
 *     production, DNS re-validated on every connection and redirect hop).
 *
 * Envelope:  { id, event, createdAt, data }
 * Signature: X-HBook-Signature: t=<unix>,v1=HMAC_SHA256(secret, "<t>.<rawBody>")
 * PII policy: booking payloads carry ids/times/status only — never patient
 * name, phone or email.
 */

import { createHmac, randomUUID } from 'node:crypto';
import * as http from 'node:http';
import * as https from 'node:https';
import { lookup as dnsLookup } from 'node:dns';
import type { PrismaClient, Prisma } from '@prisma/client';
import { DeliveryStatus } from '@prisma/client';
import { config } from '../config';
import { prisma } from './prisma';
import { decryptSecret, encryptSecret } from './webhookCrypto';
import { assertWebhookUrl, isForbiddenAddress } from './ssrf';

export const WEBHOOK_EVENTS = [
  'booking.created',
  'booking.confirmed',
  'booking.cancelled',
  'booking.rescheduled',
  'ping',
] as const;

export type WebhookEventName = (typeof WEBHOOK_EVENTS)[number];

export function signPayload(secret: string, timestamp: number, body: string): string {
  return createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
}

type Tx = Prisma.TransactionClient;

/** Enqueue an event + per-webhook delivery rows inside the caller's transaction. */
export async function enqueueWebhookEvent(
  tx: Tx,
  tenantId: string,
  type: WebhookEventName,
  data: unknown,
): Promise<string | null> {
  const hooks = await tx.webhook.findMany({
    where: { tenantId, isActive: true, events: { has: type } },
    select: { id: true },
  });
  if (hooks.length === 0) return null;

  const eventId = randomUUID();
  await tx.webhookEvent.create({
    data: { id: eventId, tenantId, type, data: data as Prisma.InputJsonValue },
  });
  await tx.webhookDelivery.createMany({
    data: hooks.map((h) => ({
      webhookId: h.id,
      tenantId,
      eventId,
      eventType: type,
      status: DeliveryStatus.PENDING,
      nextAttemptAt: new Date(),
    })),
  });
  return eventId;
}

/** Outbox enqueue outside an explicit transaction (ping, manual events). */
export async function emitWebhookEvent(
  tenantId: string,
  type: WebhookEventName,
  data: unknown,
): Promise<string | null> {
  return prisma.$transaction((tx) => enqueueWebhookEvent(tx, tenantId, type, data));
}

// ─────────────────────── SSRF-safe HTTP POST ───────────────────────

interface PostResult {
  status: number | null;
  error: string | null;
  location: string | null;
}

type LookupOptions = { family?: number; hints?: number; all: boolean; verbatim?: boolean };
type LookupCallback = (err: NodeJS.ErrnoException | null, address?: string, family?: number) => void;

function validatingLookup(
  hostname: string,
  options: LookupOptions,
  callback: LookupCallback,
): void {
  // same test escape hatch as assertWebhookUrl (never honored in production)
  if (!config.isProd && config.webhook.allowPrivateIps) {
    dnsLookup(hostname, { ...options, all: false } as never, (err, address) => {
      if (err) return callback(err);
      callback(null, address as string, String(address).includes(':') ? 6 : 4);
    });
    return;
  }
  dnsLookup(hostname, { ...options, all: true, verbatim: true } as never, (err, addresses) => {
    if (err) return callback(err);
    const ips = (addresses as unknown as Array<{ address: string }>).map((a) => a.address);
    for (const ip of ips) {
      if (isForbiddenAddress(ip)) {
        const e = new Error('webhook target resolved to a forbidden address') as NodeJS.ErrnoException;
        e.code = 'EHBOOKFORBIDDEN';
        return callback(e);
      }
    }
    const first = ips[0];
    callback(null, first, first.includes(':') ? 6 : 4);
  });
}

/** One POST hop; resolves {status} on any HTTP answer, {error} on failure. */
function postJsonHop(
  url: URL,
  body: string,
  headers: Record<string, string>,
  timeoutMs: number,
): Promise<PostResult> {
  return new Promise((resolve) => {
    const isHttps = url.protocol === 'https:';
    const mod = isHttps ? https : http;
    const req = mod.request(
      {
        protocol: url.protocol,
        hostname: url.hostname.replace(/\.$/, '').replace(/^\[|\]$/g, ''),
        port: url.port || (isHttps ? 443 : 80),
        path: `${url.pathname}${url.search}` || '/',
        method: 'POST',
        headers,
        lookup: validatingLookup,
        // SNI + certificate check against the hostname (not the resolved IP)
        servername: isHttps && !/^\d{1,3}(\.\d{1,3}){3}$/.test(url.hostname) ? url.hostname : undefined,
      } as https.RequestOptions,
      (res) => {
        const location = typeof res.headers.location === 'string' ? res.headers.location : null;
        res.resume(); // drain to release the socket
        res.on('end', () => resolve({ status: res.statusCode ?? 0, error: null, location }));
        res.on('error', () => resolve({ status: res.statusCode ?? 0, error: null, location }));
      },
    );
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`timeout after ${timeoutMs}ms`)));
    req.on('error', (e: NodeJS.ErrnoException) => {
      const msg =
        e.code === 'EHBOOKFORBIDDEN'
          ? 'blocked: webhook target resolved to a forbidden address'
          : e.message || 'request failed';
      resolve({ status: null, error: msg, location: null });
    });
    req.end(body);
  });
}

/**
 * POST with manual redirect handling: every hop is re-validated (scheme +
 * DNS + public IP). Max 3 hops; 303 is not followed (body would be lost).
 */
async function postJsonGuarded(
  rawUrl: string,
  body: string,
  headers: Record<string, string>,
): Promise<PostResult> {
  let current = rawUrl;
  for (let hop = 0; hop <= config.webhook.maxRedirects; hop++) {
    let target: Awaited<ReturnType<typeof assertWebhookUrl>>;
    try {
      target = await assertWebhookUrl(current);
    } catch (e) {
      return { status: null, error: `blocked: ${(e as Error).message}`, location: null };
    }
    const url = new URL(current);
    const res = await postJsonHop(url, body, headers, config.webhook.timeoutMs);
    if (res.error) return { status: res.status, error: res.error, location: null };
    if (res.status && [301, 302, 307, 308].includes(res.status)) {
      if (!res.location) return { status: res.status, error: 'redirect without Location', location: null };
      current = new URL(res.location, url).toString();
      continue;
    }
    return { status: res.status, error: null, location: null };
  }
  return { status: null, error: `too many redirects (> ${config.webhook.maxRedirects})`, location: null };
}

// ─────────────────────────── worker ───────────────────────────

interface ClaimedDelivery {
  id: string;
  attempts: number;
  webhookId: string;
  webhookUrl: string;
  webhookSecret: string;
  eventName: string;
  eventId: string;
  eventData: unknown;
  eventCreatedAt: Date;
}

const inflight = new Set<Promise<void>>();
let workerTimer: NodeJS.Timeout | null = null;
let stopped = true;
let lastHousekeeping = 0;

async function claimBatch(batch: number): Promise<ClaimedDelivery[]> {
  return prisma.$transaction(async (tx) => {
    const ids = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT "id" FROM "WebhookDelivery"
      WHERE "status" = 'PENDING' AND "nextAttemptAt" <= now()
      ORDER BY "nextAttemptAt" ASC
      LIMIT ${batch}
      FOR UPDATE SKIP LOCKED`;
    if (ids.length === 0) return [];
    await tx.webhookDelivery.updateMany({
      where: { id: { in: ids.map((r) => r.id) } },
      data: { status: DeliveryStatus.PROCESSING, lastAttemptAt: new Date() },
    });
    const rows = await tx.webhookDelivery.findMany({
      where: { id: { in: ids.map((r) => r.id) } },
      select: {
        id: true,
        attempts: true,
        webhookId: true,
        webhook: { select: { url: true, secret: true } },
        eventType: true,
        event: { select: { id: true, data: true, createdAt: true } },
      },
    });
    return rows.map((r) => ({
      id: r.id,
      attempts: r.attempts,
      webhookId: r.webhookId,
      webhookUrl: r.webhook.url,
      webhookSecret: r.webhook.secret,
      eventName: r.eventType,
      eventId: r.event.id,
      eventData: r.event.data,
      eventCreatedAt: r.event.createdAt,
    }));
  });
}

async function deliverClaimed(d: ClaimedDelivery): Promise<void> {
  // Decrypt failure (e.g. enc-key mismatch across instances) is RETRYABLE:
  // the row goes back to PENDING with backoff so an instance holding the
  // right HBOOK_WEBHOOK_ENC_KEY can deliver it later. Only HTTP outcomes
  // decide DELIVERED vs the final FAILED transition below.
  let secret: string;
  let legacy = false;
  try {
    const dec = decryptSecret(d.webhookSecret);
    secret = dec.secret;
    legacy = dec.legacy;
  } catch (e) {
    const attempts = d.attempts + 1;
    const maxAttempts = config.webhook.backoffMs.length + 1;
    await prisma.webhookDelivery
      .update({
        where: { id: d.id },
        data: {
          status:
            attempts < maxAttempts ? DeliveryStatus.PENDING : DeliveryStatus.FAILED,
          attempts,
          lastAttemptAt: new Date(),
          lastError: 'signing secret decrypt failed (HBOOK_WEBHOOK_ENC_KEY mismatch?)'.slice(0, 300),
          nextAttemptAt:
            attempts < maxAttempts
              ? new Date(Date.now() + config.webhook.backoffMs[attempts - 1])
              : null,
        },
      })
      .catch(() => undefined);
    void e;
    return;
  }
  try {
    if (legacy) {
      // transparent migration of pre-v2 plaintext secrets
      void prisma.webhook
        .update({ where: { id: d.webhookId }, data: { secret: encryptSecret(secret) } })
        .catch(() => undefined);
    }

    const body = JSON.stringify({
      id: d.eventId, // stable across ALL attempts (dedupe key)
      event: d.eventName,
      createdAt: d.eventCreatedAt.toISOString(),
      data: d.eventData,
    });
    const timestamp = Math.floor(Date.now() / 1000);
    const signature = `t=${timestamp},v1=${signPayload(secret, timestamp, body)}`;

    const res = await postJsonGuarded(
      d.webhookUrl,
      body,
      {
        'content-type': 'application/json',
        'user-agent': 'hbook-webhooks/2.0',
        'x-hbook-event': d.eventName,
        'x-hbook-event-id': d.eventId,
        'x-hbook-delivery-id': d.id,
        'x-hbook-signature': signature,
      },
    );

    const success = res.status !== null && res.status >= 200 && res.status < 300;
    const maxAttempts = config.webhook.backoffMs.length + 1;
    const attempts = d.attempts + 1;

    await prisma.webhookDelivery.update({
      where: { id: d.id },
      data: {
        status: success
          ? DeliveryStatus.DELIVERED
          : attempts < maxAttempts
            ? DeliveryStatus.PENDING
            : DeliveryStatus.FAILED,
        attempts,
        lastAttemptAt: new Date(),
        lastStatusCode: res.status,
        lastError: success ? null : (res.error ?? `HTTP ${res.status}`)?.slice(0, 300) ?? null,
        nextAttemptAt: success
          ? null
          : attempts < maxAttempts
            ? new Date(Date.now() + config.webhook.backoffMs[attempts - 1])
            : null,
      },
    });
  } catch {
    // never let a delivery crash the worker
    await prisma.webhookDelivery
      .update({
        where: { id: d.id },
        data: {
          status: DeliveryStatus.FAILED,
          lastError: 'internal delivery error',
          lastAttemptAt: new Date(),
        },
      })
      .catch(() => undefined);
  }
}

function track(p: Promise<void>): Promise<void> {
  inflight.add(p);
  void p.finally(() => inflight.delete(p));
  return p;
}

async function tick(): Promise<void> {
  if (stopped) return;
  try {
    // crash recovery: PROCESSING rows stuck beyond 2×timeout are re-queued
    const cutoff = new Date(Date.now() - (config.webhook.timeoutMs * 2 + 30_000));
    await prisma.webhookDelivery.updateMany({
      where: { status: DeliveryStatus.PROCESSING, lastAttemptAt: { lt: cutoff } },
      data: { status: DeliveryStatus.PENDING, nextAttemptAt: new Date() },
    });

    const batch = Math.max(0, config.webhook.concurrency - inflight.size);
    if (batch > 0) {
      const claimed = await claimBatch(batch);
      for (const d of claimed) {
        track(deliverClaimed(d));
      }
    }

    // low-frequency housekeeping: idempotency TTL, empty slot instances,
    // old outbox events (their deliveries are DONE by definition of age)
    if (Date.now() - lastHousekeeping > 10 * 60_000) {
      lastHousekeeping = Date.now();
      await prisma.$transaction([
        prisma.idempotencyKey.deleteMany({
          where: { createdAt: { lt: new Date(Date.now() - config.idempotencyTtlHours * 3_600_000) } },
        }),
        prisma.$executeRaw`
          DELETE FROM "SlotInstance"
          WHERE "taken" = 0 AND "startsAt" < now() - interval '1 day'`,
        prisma.$executeRaw`
          DELETE FROM "WebhookEvent" e
          WHERE e."createdAt" < now() - interval '30 days'
            AND NOT EXISTS (
              SELECT 1 FROM "WebhookDelivery" d
              WHERE d."eventId" = e."id" AND d."status" IN ('PENDING', 'PROCESSING'))`,
      ]).catch(() => undefined);
    }
  } catch {
    /* transient DB errors — the next tick retries */
  }
}

export function startWebhookWorker(): void {
  if (workerTimer) return; // already running
  stopped = false;
  lastHousekeeping = Date.now();
  workerTimer = setInterval(() => void tick(), config.webhook.tickMs);
  workerTimer.unref?.();
}

export async function stopWebhookWorker(timeoutMs = 10_000): Promise<void> {
  if (workerTimer) {
    clearInterval(workerTimer);
    workerTimer = null;
  }
  stopped = true;
  if (inflight.size === 0) return;
  const deadline = Date.now() + timeoutMs;
  while (inflight.size > 0 && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 100));
  }
}

export const _internal = { postJsonGuarded, validatingLookup };
export type { PrismaClient };
