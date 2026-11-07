import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { handleApiError, success } from "@/lib/api/response";
import { requireAuth } from "@/lib/api/auth";
import { scheduleCreateSchema } from "@/lib/api/validate";
import { serializeAvailability } from "@/lib/api/serialize";
import { buildAvailabilityData } from "@/lib/api/availability";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  try {
    const auth = await requireAuth(request);
    const [user, schedules] = await Promise.all([
      db.user.findUnique({ where: { id: auth.userId }, select: { defaultScheduleId: true } }),
      db.schedule.findMany({
        where: { userId: auth.userId },
        orderBy: { id: "asc" },
        include: { availability: true },
      }),
    ]);
    return success({
      defaultScheduleId: user?.defaultScheduleId ?? null,
      schedules: schedules.map((s) => ({
        id: s.id,
        name: s.name,
        timeZone: s.timeZone,
        isDefault: s.id === user?.defaultScheduleId,
        availability: serializeAvailability(s.availability),
      })),
    });
  } catch (e) {
    return handleApiError(e, request);
  }
}

export async function POST(request: NextRequest) {
  try {
    const auth = await requireAuth(request);
    const input = scheduleCreateSchema.parse(await request.json());

    const user = await db.user.findUnique({ where: { id: auth.userId }, select: { defaultScheduleId: true } });
    const isFirstSchedule = !user?.defaultScheduleId;

    const schedule = await db.schedule.create({
      data: {
        userId: auth.userId,
        name: input.name,
        timeZone: input.timeZone,
        availability: input.availability ? { create: buildAvailabilityData(input.availability) } : undefined,
      },
      include: { availability: true },
    });

    // first schedule becomes the default (cal.com behavior)
    if (isFirstSchedule || input.isDefault) {
      await db.user.update({ where: { id: auth.userId }, data: { defaultScheduleId: schedule.id } });
    }

    return success(
      {
        schedule: {
          id: schedule.id,
          name: schedule.name,
          timeZone: schedule.timeZone,
          isDefault: isFirstSchedule || Boolean(input.isDefault),
          availability: serializeAvailability(schedule.availability),
        },
      },
      201,
    );
  } catch (e) {
    return handleApiError(e, request);
  }
}
