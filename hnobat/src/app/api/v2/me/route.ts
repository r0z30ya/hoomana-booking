import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { handleApiError, success, Errors } from "@/lib/api/response";
import { requireAuth } from "@/lib/api/auth";
import { meUpdateSchema } from "@/lib/api/validate";

export const dynamic = "force-dynamic";

async function getMe(userId: number) {
  const user = await db.user.findUnique({ where: { id: userId } });
  if (!user) throw Errors.notFound("User");
  return {
    id: user.id,
    username: user.username,
    name: user.name,
    email: user.email,
    timeZone: user.timeZone,
    weekStart: user.weekStart,
    timeFormat: user.timeFormat,
    bio: user.bio,
    avatarUrl: user.avatarUrl,
    defaultScheduleId: user.defaultScheduleId,
    createdAt: user.createdAt.toISOString(),
  };
}

export async function GET(request: NextRequest) {
  try {
    const auth = await requireAuth(request);
    return success(await getMe(auth.userId));
  } catch (e) {
    return handleApiError(e, request);
  }
}

export async function PATCH(request: NextRequest) {
  try {
    const auth = await requireAuth(request);
    const input = meUpdateSchema.parse(await request.json());

    if (input.username) {
      const taken = await db.user.findFirst({
        where: { username: input.username, id: { not: auth.userId } },
      });
      if (taken) throw Errors.conflict("This username is already taken.");
    }

    await db.user.update({ where: { id: auth.userId }, data: input });
    return success(await getMe(auth.userId));
  } catch (e) {
    return handleApiError(e, request);
  }
}
