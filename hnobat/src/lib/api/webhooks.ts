import { createHmac } from "crypto";
import { db } from "@/lib/db";
import { parseJsonSafe } from "./utils";

/**
 * Webhook dispatcher — cal.com parity.
 * Same trigger names as cal.com WebhookTriggerEvents, signature header
 * `x-hnobat-signature-256` (cal.com uses `x-cal-signature-256`), HMAC-SHA256
 * hex digest of the raw body using the webhook secret.
 */

export const WEBHOOK_TRIGGERS = [
  "BOOKING_CREATED", // booking confirmed instantly (no requiresConfirmation)
  "BOOKING_REQUESTED", // booking created as PENDING (requiresConfirmation)
  "BOOKING_CONFIRMED", // pending booking accepted by the host
  "BOOKING_RESCHEDULED",
  "BOOKING_CANCELLED",
  "BOOKING_REJECTED",
  "BOOKING_PAID",
  "MEETING_ENDED",
] as const;

export type WebhookTrigger = (typeof WEBHOOK_TRIGGERS)[number];

export function signWebhook(body: string, secret: string): string {
  return createHmac("sha256", secret).update(body).digest("hex");
}

// Empty allowlist disables delivery. Configure exact trusted origins at deployment.
export function isAllowedWebhookUrl(value: string): boolean {
  try {
    const url = new URL(value);
    if (url.username || url.password || !["http:", "https:"].includes(url.protocol)) return false;
    if (process.env.NODE_ENV === "production" && url.protocol !== "https:") return false;
    const allowed = (process.env.HNOBAT_WEBHOOK_ALLOWED_ORIGINS ?? "").split(",").map((v) => v.trim()).filter(Boolean);
    return allowed.includes(url.origin);
  } catch { return false; }
}

export async function dispatchWebhooks(userId: number, trigger: WebhookTrigger, payload: Record<string, unknown>) {
  try {
    const hooks = await db.webhook.findMany({ where: { userId, active: true } });
    const targets = hooks.filter((h) => parseJsonSafe<string[]>(h.eventTriggers, []).includes(trigger) && isAllowedWebhookUrl(h.subscriberUrl));
    await Promise.all(
      targets.map(async (hook) => {
        const body = JSON.stringify({
          triggerEvent: trigger,
          createdAt: new Date().toISOString(),
          webhookId: hook.id,
          payload,
        });
        const headers: Record<string, string> = {
          "content-type": "application/json",
          "x-hnobat-event": trigger,
        };
        if (hook.secret) headers["x-hnobat-signature-256"] = signWebhook(body, hook.secret);
        try {
          const res = await fetch(hook.subscriberUrl, {
            method: "POST",
            redirect: "error",
            headers,
            body,
            signal: AbortSignal.timeout(5000),
          });
          console.log(`[hnobat] webhook ${trigger} -> ${hook.subscriberUrl} responded ${res.status}`);
        } catch (err) {
          console.error(`[hnobat] webhook ${trigger} -> ${hook.subscriberUrl} failed:`, err);
        }
      }),
    );
  } catch (err) {
    console.error("[hnobat] webhook dispatch error:", err);
  }
}
