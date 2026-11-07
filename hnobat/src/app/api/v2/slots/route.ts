import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { handleApiError, success, Errors } from "@/lib/api/response";
import { slotsQuerySchema } from "@/lib/api/validate";
import { getAvailableSlots, loadSchedulableEventType } from "@/lib/api/slot-engine";

export const dynamic = "force-dynamic";

/**
 * GET /api/v2/slots — public endpoint (like cal.com's booking-page slot picker).
 *
 * Query:
 *  - eventTypeId=123                          OR username=demo&eventTypeSlug=30min
 *  - startTime=2026-11-05T00:00:00Z (required)
 *  - endTime=2026-11-08T00:00:00Z   (required, max 31 days after startTime)
 *  - timeZone=Asia/Tehran (optional; default = event type/schedule timezone)
 */
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const input = slotsQuerySchema.parse(Object.fromEntries(searchParams.entries()));

    if ((input.endTime.getTime() - input.startTime.getTime()) > 31 * 86_400_000) {
      throw Errors.badRequest("The requested range cannot exceed 31 days.");
    }

    let eventTypeId = input.eventTypeId;
    if (!eventTypeId && input.username && input.eventTypeSlug) {
      const user = await db.user.findUnique({ where: { username: input.username } });
      if (!user) throw Errors.notFound("User");
      const eventType = await db.eventType.findUnique({
        where: { userId_slug: { userId: user.id, slug: input.eventTypeSlug } },
      });
      if (!eventType) throw Errors.notFound("EventType");
      eventTypeId = eventType.id;
    }
    if (!eventTypeId) throw Errors.badRequest("Provide either `eventTypeId` or both `username` and `eventTypeSlug`.");

    const eventType = await loadSchedulableEventType(eventTypeId);
    if (!eventType) throw Errors.notFound("EventType");

    const scheduleTz = eventType.schedule?.timeZone ?? "Etc/UTC";
    const targetTz = input.timeZone || eventType.timeZone || scheduleTz;

    const slots = await getAvailableSlots(eventType, input.startTime, input.endTime, targetTz);

    return success({
      slots,
      meta: {
        eventTypeId: eventType.id,
        duration: eventType.length,
        timeZone: targetTz,
        slotInterval: eventType.slotInterval ?? eventType.length,
      },
    });
  } catch (e) {
    return handleApiError(e, request);
  }
}
