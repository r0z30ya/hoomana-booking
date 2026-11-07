import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { handleApiError, success, Errors } from "@/lib/api/response";
import { signJwt, verifyPassword } from "@/lib/api/auth";
import { loginSchema } from "@/lib/api/validate";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const input = loginSchema.parse(body);

    const user = await db.user.findUnique({ where: { email: input.email.toLowerCase() } });
    if (!user || !verifyPassword(input.password, user.passwordHash)) {
      throw Errors.unauthorized("Invalid credentials.");
    }

    const token = signJwt({ sub: user.id, email: user.email, username: user.username });

    return success({
      user: {
        id: user.id,
        username: user.username,
        name: user.name,
        email: user.email,
        timeZone: user.timeZone,
      },
      accessToken: token,
      tokenType: "Bearer",
      expiresIn: 30 * 24 * 3600,
    });
  } catch (e) {
    return handleApiError(e, request);
  }
}
