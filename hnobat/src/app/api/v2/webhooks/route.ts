import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { handleApiError, success, Errors } from "@/lib/api/response";
import { requireAuth } from "@/lib/api/auth";
import { webhookCreateSchema } from "@/lib/api/validate";
import { WEBHOOK_TRIGGERS, isAllowedWebhookUrl } from "@/lib/api/webhooks";
import { parseJsonSafe } from "@/lib/api/utils";

export const dynamic = "force-dynamic";

/** GET /api/v2/webhooks — list own webhooks. */
export async function GET(request: NextRequest) {
  try {
    const auth = await requireAuth(request);
    const webhooks = await db.webhook.findMany({
      where: { userId: auth.userId },
      orderBy: { createdAt: "desc" },
    });
    return success({
      webhooks: webhooks.map(({ secret: _secret, ...w }) => ({ ...w, eventTriggers: parseJsonSafe<string[]>(w.eventTriggers, []) })),
    });
  } catch (e) {
    return handleApiError(e, request);
  }
}

/** POST /api/v2/webhooks — register a webhook subscriber (cal.com parity). */
export async function POST(request: NextRequest) {
  try {
    const auth = await requireAuth(request);
    const input = webhookCreateSchema.parse(await request.json());

    if (!isAllowedWebhookUrl(input.subscriberUrl)) throw Errors.badRequest("Webhook origin is not allowed by server configuration.");
    const webhook = await db.webhook.create({
      data: {
        userId: auth.userId,
        subscriberUrl: input.subscriberUrl,
        eventTriggers: JSON.stringify(input.eventTriggers),
        active: input.active ?? true,
        secret: input.secret,
      },
    });

    const { secret: _secret, ...safeWebhook } = webhook;
    return success(
      {
        webhook: { ...safeWebhook, eventTriggers: input.eventTriggers },
        availableTriggers: WEBHOOK_TRIGGERS,
      },
      201,
    );
  } catch (e) {
    return handleApiError(e, request);
  }
}
