import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { handleApiError, success, Errors } from "@/lib/api/response";
import { requireAuth } from "@/lib/api/auth";

export const dynamic = "force-dynamic";

/** DELETE /api/v2/api-keys/{id} — revoke an API key. */
export async function DELETE(request: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const auth = await requireAuth(request);
    const { id } = await ctx.params;

    const apiKey = await db.apiKey.findUnique({ where: { id } });
    if (!apiKey) throw Errors.notFound("ApiKey");
    if (apiKey.userId !== auth.userId) throw Errors.forbidden("This API key belongs to another user.");

    await db.apiKey.delete({ where: { id } });
    return success({ apiKey: id, deleted: true });
  } catch (e) {
    return handleApiError(e, request);
  }
}
