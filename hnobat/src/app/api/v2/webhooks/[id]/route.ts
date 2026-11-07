import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { handleApiError, success, Errors } from "@/lib/api/response";
import { requireAuth } from "@/lib/api/auth";
import { webhookUpdateSchema } from "@/lib/api/validate";
import { isAllowedWebhookUrl } from "@/lib/api/webhooks";
import { parseJsonSafe } from "@/lib/api/utils";

export const dynamic = "force-dynamic";

async function getOwnedWebhook(webhookId: string, userId: number) {
  const webhook = await db.webhook.findUnique({ where: { id: webhookId } });
  if (!webhook) throw Errors.notFound("Webhook");
  if (webhook.userId !== userId) throw Errors.forbidden("This webhook belongs to another user.");
  return webhook;
}

export async function PATCH(request: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const auth = await requireAuth(request);
    const { id } = await ctx.params;
    await getOwnedWebhook(id, auth.userId);
    const input = webhookUpdateSchema.parse(await request.json());

    if (input.subscriberUrl && !isAllowedWebhookUrl(input.subscriberUrl)) throw Errors.badRequest("Webhook origin is not allowed by server configuration.");
    const webhook = await db.webhook.update({
      where: { id },
      data: {
        subscriberUrl: input.subscriberUrl,
        eventTriggers: input.eventTriggers ? JSON.stringify(input.eventTriggers) : undefined,
        active: input.active,
        secret: input.secret,
      },
    });
    const { secret: _secret, ...safeWebhook } = webhook;
    return success({ webhook: { ...safeWebhook, eventTriggers: parseJsonSafe<string[]>(webhook.eventTriggers, []) } });
  } catch (e) {
    return handleApiError(e, request);
  }
}

export async function DELETE(request: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const auth = await requireAuth(request);
    const { id } = await ctx.params;
    await getOwnedWebhook(id, auth.userId);
    await db.webhook.delete({ where: { id } });
    return success({ webhook: id, deleted: true });
  } catch (e) {
    return handleApiError(e, request);
  }
}
