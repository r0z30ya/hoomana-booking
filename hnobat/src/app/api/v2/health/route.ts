import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

/** GET /api/v2/health — engine status. */
export async function GET() {
  return NextResponse.json({
    status: "success",
    data: {
      service: "hnobat",
      engine: "booking-engine",
      version: "v2",
      time: new Date().toISOString(),
      uptimeSeconds: Math.round(process.uptime()),
    },
  });
}
