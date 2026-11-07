/// <reference types="bun-types" />
/** Minimal webhook receiver for testing hnobat webhook dispatch (localhost only). */
import { createHmac } from "crypto";

const SECRET = "supersecret123";

Bun.serve({
  port: 3099,
  async fetch(req) {
    const raw = await req.text();
    const expected = createHmac("sha256", SECRET).update(raw).digest("hex");
    const received = (req.headers.get("x-hnobat-signature-256") ?? "").replace("sha256=", "");
    console.log("EVENT:", req.headers.get("x-hnobat-event"));
    console.log("SIGNATURE OK:", expected === received);
    const parsed = JSON.parse(raw);
    console.log("TRIGGER:", parsed.triggerEvent, "| booking uid:", parsed.payload?.booking?.uid, "| status:", parsed.payload?.booking?.status);
    return new Response("ok");
  },
});
console.log("hook receiver on :3099");
