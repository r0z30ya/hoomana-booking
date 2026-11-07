import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { handleApiError, success, Errors } from "@/lib/api/response";
import { requireAuth } from "@/lib/api/auth";
import { eventTypeUpdateSchema } from "@/lib/api/validate";

export const dynamic = "force-dynamic";

async function getOwnedEventType(eventTypeId: number, userId: number) {
  const eventType = await db.eventType.findUnique({ where: { id: eventTypeId } });
  if (!eventType) throw Errors.notFound("EventType");
  if (eventType.userId !== userId) throw Errors.forbidden("This event type belongs to another user.");
  return eventType;
}

export async function GET(request: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const auth = await requireAuth(request);
    const { id } = await ctx.params;
    const eventType = await getOwnedEventType(Number(id), auth.userId);
    return success({ eventType });
  } catch (e) {
    return handleApiError(e, request);
  }
}

export async function PATCH(request: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const auth = await requireAuth(request);
    const { id } = await ctx.params;
    await getOwnedEventType(Number(id), auth.userId);
    const input = eventTypeUpdateSchema.parse(await request.json());

    if (input.scheduleId !== undefined) {
      const schedule = await db.schedule.findFirst({ where: { id: input.scheduleId, userId: auth.userId } });
      if (!schedule) throw Errors.notFound("Schedule");
    }

    if (input.slug) {
      const clash = await db.eventType.findUnique({ where: { userId_slug: { userId: auth.userId, slug: input.slug } } });
      if (clash && clash.id !== Number(id)) throw Errors.conflict(`You already have an event type with slug "${input.slug}".`);
    }

    const data: Record<string, unknown> = { ...input };
    if (input.locations) data.locations = JSON.stringify(input.locations);
    if (input.metadata) data.metadata = JSON.stringify(input.metadata);

    const eventType = await db.eventType.update({ where: { id: Number(id) }, data });
    return success({ eventType });
  } catch (e) {
    return handleApiError(e, request);
  }
}

export async function DELETE(request: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const auth = await requireAuth(request);
    const { id } = await ctx.params;
    await getOwnedEventType(Number(id), auth.userId);
    await db.eventType.delete({ where: { id: Number(id) } });
    return success({ eventType: Number(id), deleted: true });
  } catch (e) {
    return handleApiError(e, request);
  }
}
