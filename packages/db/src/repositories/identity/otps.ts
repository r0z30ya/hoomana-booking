import { createHash } from 'node:crypto';
import type { PrismaClient } from '../../generated/prisma/client.js';

/**
 * Identity repository: `auth_otps` (global table, no RLS — owner decision 2026-10-13).
 *
 * A one-time SMS code is a credential: only its SHA-256 is stored, it expires, it can be
 * attempted a limited number of times, and it is marked consumed the moment it is used.
 * The raw code never reaches this module.
 */

export type OtpPurpose = 'SIGNUP' | 'LOGIN' | 'RECOVERY';

/** SHA-256 of the code, hex-encoded. */
export function hashOtpCode(code: string): string {
  return createHash('sha256').update(code, 'utf8').digest('hex');
}

export interface CreateOtpInput {
  readonly identifier: string;
  readonly purpose: OtpPurpose;
  readonly codeHash: string;
  readonly expiresAt: Date;
}

export async function createOtp(client: PrismaClient, input: CreateOtpInput) {
  return client.authOtp.create({
    data: {
      identifier: input.identifier,
      purpose: input.purpose,
      codeHash: input.codeHash,
      expiresAt: input.expiresAt,
    },
  });
}

export interface ActiveOtp {
  readonly id: string;
  readonly codeHash: string;
  readonly attempts: number;
  readonly expiresAt: Date;
}

/**
 * The newest unconsumed code for this identifier and purpose, expired or not — the
 * caller decides, so "expired code" and "no code" can share one response shape.
 */
export async function findLatestOtp(
  client: PrismaClient,
  identifier: string,
  purpose: OtpPurpose,
): Promise<ActiveOtp | undefined> {
  const row = await client.authOtp.findFirst({
    where: { identifier, purpose, consumedAt: null },
    orderBy: { createdAt: 'desc' },
    select: { id: true, codeHash: true, attempts: true, expiresAt: true },
  });

  return row ?? undefined;
}

export async function countOtpsSince(
  client: PrismaClient,
  identifier: string,
  purpose: OtpPurpose,
  since: Date,
): Promise<number> {
  return client.authOtp.count({ where: { identifier, purpose, createdAt: { gte: since } } });
}

export async function addOtpAttempt(client: PrismaClient, id: string): Promise<void> {
  await client.authOtp.update({ where: { id }, data: { attempts: { increment: 1 } } });
}

export async function consumeOtp(client: PrismaClient, id: string): Promise<void> {
  await client.authOtp.update({ where: { id }, data: { consumedAt: new Date() } });
}

/** Drop a code that failed too often, so it cannot be replayed. */
export async function invalidateOtp(client: PrismaClient, id: string): Promise<void> {
  await client.authOtp.update({ where: { id }, data: { consumedAt: new Date() } });
}
