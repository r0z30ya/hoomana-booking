import { createHash, createHmac, randomBytes, scryptSync, timingSafeEqual } from "crypto";
import { db } from "@/lib/db";
import { ApiError, Errors } from "./response";

/**
 * Authentication for hnobat API v2.
 * cal.com parity:
 *  - Credentials (email+password) -> JWT session (cal.com uses NextAuth credentials provider)
 *  - API keys with a brand prefix ("cal_live_..." in cal.com, "hnb_..." here), stored hashed (SHA-256)
 */

function jwtSecret(): string {
  const secret = process.env.JWT_SECRET;
  if (process.env.NODE_ENV === "production" && (!secret || secret.length < 32 || secret === "dev-insecure-secret-change-me" || secret === "change-me-please-openssl-rand-hex-32")) {
    throw new Error("JWT_SECRET must be a unique secret of at least 32 characters in production.");
  }
  return secret || "dev-insecure-secret-change-me";
}
const API_KEY_PREFIX = "hnb_";

// ---------- passwords (scrypt, no external deps) ----------

export function hashPassword(password: string): string {
  const salt = randomBytes(16).toString("hex");
  const hash = scryptSync(password, salt, 64).toString("hex");
  return `scrypt$${salt}$${hash}`;
}

export function verifyPassword(password: string, stored: string | null): boolean {
  if (!stored) return false;
  const [scheme, salt, hash] = stored.split("$");
  if (scheme !== "scrypt" || !salt || !hash) return false;
  const candidate = scryptSync(password, salt, 64);
  const expected = Buffer.from(hash, "hex");
  return candidate.length === expected.length && timingSafeEqual(candidate, expected);
}

// ---------- JWT (HS256) ----------

export interface JwtPayload {
  sub: number; // user id
  email: string;
  username: string;
  iat: number;
  exp: number;
}

function b64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64url");
}

export function signJwt(payload: Omit<JwtPayload, "iat" | "exp">, ttlSeconds = 30 * 24 * 3600): string {
  const now = Math.floor(Date.now() / 1000);
  const body: JwtPayload = { ...payload, iat: now, exp: now + ttlSeconds };
  const header = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const claims = b64url(JSON.stringify(body));
  const signature = createHmac("sha256", jwtSecret()).update(`${header}.${claims}`).digest("base64url");
  return `${header}.${claims}.${signature}`;
}

export function verifyJwt(token: string): JwtPayload | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [header, claims, signature] = parts;
  const expected = createHmac("sha256", jwtSecret()).update(`${header}.${claims}`).digest("base64url");
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const jwtHeader = JSON.parse(Buffer.from(header, "base64url").toString());
    const payload = JSON.parse(Buffer.from(claims, "base64url").toString()) as JwtPayload;
    if (jwtHeader.alg !== "HS256" || jwtHeader.typ !== "JWT" ||
        !Number.isSafeInteger(payload.sub) || payload.sub <= 0 ||
        !Number.isSafeInteger(payload.iat) || !Number.isSafeInteger(payload.exp) ||
        typeof payload.email !== "string" || typeof payload.username !== "string" ||
        payload.exp <= Math.floor(Date.now() / 1000) || payload.iat > payload.exp) return null;
    return payload;
  } catch {
    return null;
  }
}

// ---------- API keys ----------

export function generateApiKey(): string {
  return `${API_KEY_PREFIX}${randomBytes(24).toString("base64url")}`;
}

export function hashApiKey(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}

// ---------- request auth ----------

export type AuthContext = { userId: number; via: "jwt" | "apiKey" };

async function authWithApiKey(key: string): Promise<AuthContext | null> {
  const record = await db.apiKey.findUnique({ where: { hashedKey: hashApiKey(key) } });
  if (!record) return null;
  if (record.expiresAt && record.expiresAt.getTime() < Date.now()) return null;
  // update lastUsedAt without blocking the response
  db.apiKey.update({ where: { id: record.id }, data: { lastUsedAt: new Date() } }).catch(() => {});
  return { userId: record.userId, via: "apiKey" };
}

/**
 * Resolves the caller from:
 *  - "Authorization: Bearer <jwt>"      (session)
 *  - "Authorization: Bearer hnb_..."    (API key)
 *  - "x-api-key: hnb_..."               (API key)
 */
export async function getAuth(request: Request): Promise<AuthContext | null> {
  const authHeader = request.headers.get("authorization");
  const apiKeyHeader = request.headers.get("x-api-key");

  const bearer = authHeader?.toLowerCase().startsWith("bearer ") ? authHeader.slice(7).trim() : null;

  const apiKey = apiKeyHeader?.startsWith(API_KEY_PREFIX) ? apiKeyHeader : bearer?.startsWith(API_KEY_PREFIX) ? bearer : null;

  if (apiKey) return authWithApiKey(apiKey);

  if (bearer) {
    const payload = verifyJwt(bearer);
    if (payload) return { userId: payload.sub, via: "jwt" };
  }
  return null;
}

export async function requireAuth(request: Request): Promise<AuthContext> {
  const auth = await getAuth(request);
  if (!auth) throw Errors.unauthorized();
  return auth;
}
