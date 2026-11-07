import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { handleApiError, success, Errors } from "@/lib/api/response";
import { hashPassword, signJwt } from "@/lib/api/auth";
import { signupSchema } from "@/lib/api/validate";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const input = signupSchema.parse(body);

    const existingEmail = await db.user.findUnique({ where: { email: input.email.toLowerCase() } });
    if (existingEmail) throw Errors.conflict("A user with this email already exists.");
    const existingUsername = await db.user.findUnique({ where: { username: input.username } });
    if (existingUsername) throw Errors.conflict("This username is already taken.");

    const user = await db.user.create({
      data: {
        username: input.username,
        name: input.name,
        email: input.email.toLowerCase(),
        passwordHash: hashPassword(input.password),
        timeZone: input.timeZone ?? "Etc/UTC",
      },
    });

    const token = signJwt({ sub: user.id, email: user.email, username: user.username });

    return success(
      {
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
      },
      201,
    );
  } catch (e) {
    return handleApiError(e, request);
  }
}
