import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { handleApiError, success } from "@/lib/api/response";
import { requireAuth, generateApiKey } from "@/lib/api/auth";
import { apiKeyCreateSchema } from "@/lib/api/validate";

export const dynamic = "force-dynamic";

/** GET /api/v2/api-keys — list own keys (metadata only, never the raw key). */
export async function GET(request: NextRequest) {
  try {
    const auth = await requireAuth(request);
    const keys = await db.apiKey.findMany({
      where: { userId: auth.userId },
      orderBy: { createdAt: "desc" },
      select: { id: true, name: true, createdAt: true, expiresAt: true, lastUsedAt: true },
    });
    return success({ apiKeys: keys });
  } catch (e) {
    return handleApiError(e, request);
  }
}

/** POST /api/v2/api-keys — create a key; the raw `hnb_...` value is returned ONCE. */
export async function POST(request: NextRequest) {
  try {
    const auth = await requireAuth(request);
    const input = apiKeyCreateSchema.parse(await request.json().catch(() => ({})));

    const rawKey = generateApiKey();
    const apiKey = await db.apiKey.create({
      data: {
        userId: auth.userId,
        name: input.name,
        expiresAt: input.expiresAt,
        hashedKey: (await import("crypto")).createHash("sha256").update(rawKey).digest("hex"),
      },
    });

    return success(
      {
        apiKey: { id: apiKey.id, name: apiKey.name, createdAt: apiKey.createdAt, expiresAt: apiKey.expiresAt },
        // shown only once — the database stores only its SHA-256 hash (cal.com parity)
        key: rawKey,
      },
      201,
    );
  } catch (e) {
    return handleApiError(e, request);
  }
}
