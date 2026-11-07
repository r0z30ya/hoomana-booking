import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { handleApiError, success, Errors } from "@/lib/api/response";
import { requireAuth } from "@/lib/api/auth";
import { scheduleUpdateSchema } from "@/lib/api/validate";
import { serializeAvailability } from "@/lib/api/serialize";
import { buildAvailabilityData } from "@/lib/api/availability";

export const dynamic = "force-dynamic";

async function getOwnedSchedule(scheduleId: number, userId: number) {
  const schedule = await db.schedule.findUnique({ where: { id: scheduleId } });
  if (!schedule) throw Errors.notFound("Schedule");
  if (schedule.userId !== userId) throw Errors.forbidden("This schedule belongs to another user.");
  return schedule;
}

export async function GET(request: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const auth = await requireAuth(request);
    const { id } = await ctx.params;
    const schedule = await getOwnedSchedule(Number(id), auth.userId);
    const withAvailability = await db.schedule.findUnique({
      where: { id: schedule.id },
      include: { availability: true },
    });
    const user = await db.user.findUnique({ where: { id: auth.userId }, select: { defaultScheduleId: true } });
    return success({
      schedule: {
        id: schedule.id,
        name: schedule.name,
        timeZone: schedule.timeZone,
        isDefault: schedule.id === user?.defaultScheduleId,
        availability: serializeAvailability(withAvailability?.availability ?? []),
      },
    });
  } catch (e) {
    return handleApiError(e, request);
  }
}

export async function PATCH(request: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const auth = await requireAuth(request);
    const { id } = await ctx.params;
    const schedule = await getOwnedSchedule(Number(id), auth.userId);
    const input = scheduleUpdateSchema.parse(await request.json());

    await db.schedule.update({
      where: { id: schedule.id },
      data: {
        name: input.name,
        timeZone: input.timeZone,
        ...(input.availability
          ? { availability: { deleteMany: {}, create: buildAvailabilityData(input.availability) } }
          : {}),
      },
    });

    if (input.isDefault) {
      await db.user.update({ where: { id: auth.userId }, data: { defaultScheduleId: schedule.id } });
    }

    const updated = await db.schedule.findUnique({ where: { id: schedule.id }, include: { availability: true } });
    const user = await db.user.findUnique({ where: { id: auth.userId }, select: { defaultScheduleId: true } });
    return success({
      schedule: {
        id: schedule.id,
        name: updated?.name,
        timeZone: updated?.timeZone,
        isDefault: schedule.id === user?.defaultScheduleId,
        availability: serializeAvailability(updated?.availability ?? []),
      },
    });
  } catch (e) {
    return handleApiError(e, request);
  }
}

export async function DELETE(request: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const auth = await requireAuth(request);
    const { id } = await ctx.params;
    const schedule = await getOwnedSchedule(Number(id), auth.userId);

    const user = await db.user.findUnique({ where: { id: auth.userId }, select: { defaultScheduleId: true } });
    if (user?.defaultScheduleId === schedule.id) {
      const other = await db.schedule.findFirst({
        where: { userId: auth.userId, id: { not: schedule.id } },
        orderBy: { id: "asc" },
      });
      if (!other) throw Errors.badRequest("Cannot delete the only remaining schedule.");
      // promote the next schedule to default (cal.com behavior)
      await db.user.update({ where: { id: auth.userId }, data: { defaultScheduleId: other.id } });
    }

    await db.schedule.delete({ where: { id: schedule.id } });
    return success({ schedule: schedule.id, deleted: true });
  } catch (e) {
    return handleApiError(e, request);
  }
}
