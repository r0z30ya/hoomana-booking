import { findSessionByTokenHash, hashToken, revokeSession, type PrismaClient } from '@hmn/db';
import type { FastifyRequest } from 'fastify';
import { SESSION_COOKIE_NAME } from './auth-service.js';

/** Apply the same account and clinic checks to every clinic session. */
export async function currentSession(client: PrismaClient, request: FastifyRequest) {
  const raw = request.cookies[SESSION_COOKIE_NAME];
  if (raw === undefined || raw.trim() === '') return undefined;
  const session = await findSessionByTokenHash(client, hashToken(raw));
  const now = Date.now();
  if (
    session === undefined ||
    session.revokedAt !== null ||
    session.expiresAt.getTime() <= now ||
    session.idleExpiresAt.getTime() <= now
  )
    return undefined;

  const user = await client.user.findUnique({
    where: { id: session.userId },
    select: { isActive: true },
  });
  const tenant =
    session.activeTenantId === null
      ? null
      : await client.tenant.findUnique({
          where: { id: session.activeTenantId },
          select: { isSuspended: true, blockedAt: true },
        });
  if (
    user === null ||
    !user.isActive ||
    (session.activeTenantId !== null &&
      (tenant === null || tenant.isSuspended || tenant.blockedAt !== null))
  ) {
    await revokeSession(client, session.id);
    return undefined;
  }
  return session;
}
