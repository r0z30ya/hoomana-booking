import { NextResponse } from "next/server";
import { ZodError } from "zod";

/**
 * Response envelope — modeled after cal.com API v2:
 *   success: { status: "success", data: ... }
 *   error:   { status: "error", timestamp, path, error: { code, message, details } }
 */

export function success<T>(data: T, status = 200) {
  return NextResponse.json({ status: "success", data }, { status });
}

export class ApiError extends Error {
  statusCode: number;
  code: string;
  details?: unknown;

  constructor(statusCode: number, code: string, message: string, details?: unknown) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
  }

  toResponse(path: string) {
    return NextResponse.json(
      {
        status: "error",
        timestamp: new Date().toISOString(),
        path,
        error: { code: this.code, message: this.message, details: this.details },
      },
      { status: this.statusCode },
    );
  }
}

// Error codes used across hnobat API v2 (cal.com v2 naming style)
export const Errors = {
  unauthorized: (msg = "Authentication required. Provide a valid JWT (Authorization: Bearer <token>) or an API key (x-api-key).") =>
    new ApiError(401, "UnauthorizedError", msg),
  forbidden: (msg = "You do not have permission to perform this action.") => new ApiError(403, "ForbiddenError", msg),
  notFound: (resource = "Resource") => new ApiError(404, "ResourceNotFoundError", `${resource} not found.`),
  validation: (msg: string, details?: unknown) => new ApiError(400, "ValidationError", msg, details),
  conflict: (msg: string) => new ApiError(409, "ConflictError", msg),
  slotUnavailable: (msg = "The requested time slot is not available.") =>
    new ApiError(400, "BookingSlotUnavailable", msg),
  minNotice: (msg: string) => new ApiError(400, "MinimumBookingNoticeError", msg),
  badRequest: (msg: string) => new ApiError(400, "BadRequestError", msg),
};

export function handleApiError(e: unknown, request: Request) {
  if (e instanceof ApiError) return e.toResponse(new URL(request.url).pathname);
  if (e instanceof ZodError) {
    return new ApiError(400, "ValidationError", "Invalid request payload.", {
      issues: e.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
    }).toResponse(new URL(request.url).pathname);
  }
  console.error("[hnobat] Unhandled API error:", e);
  return new ApiError(500, "InternalServerError", "An unexpected error occurred.").toResponse(
    new URL(request.url).pathname,
  );
}
