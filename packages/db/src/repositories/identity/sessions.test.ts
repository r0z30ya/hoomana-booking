import { randomBytes } from 'node:crypto';
import { loadEnvironment } from '@hmn/shared';
import { afterAll, describe, expect, it } from 'vitest';
import { checkDatabase, createDatabaseClient } from '../../database.js';
import {
  createSession,
  findSessionByTokenHash,
  hashToken,
  revokeAllSessions,
  revokeSession,
  touchSession,
} from './sessions.js';

const environment = loadEnvironment();
const client = createDatabaseClient({ connectionString: environment.DATABASE_APP_URL });
/** The migrator role cleans up test rows: hmn_app deliberately cannot DELETE global rows. */
const migrator = createDatabaseClient({ connectionString: environment.DATABASE_URL });

afterAll(async () => {
  await client.$disconnect();
  await migrator.$disconnect();
});

const dbAvailable = (await checkDatabase(client, 3_000)).status === 'ok';

/** A raw token for testing; only its hash is ever stored. */
function rawToken(): string {
  return randomBytes(32).toString('base64url');
}

describe.skipIf(!dbAvailable)('identity repository — sessions', () => {
  const testEmail = `sess-test-${Date.now()}@test.hmn.local`;
  let userId = '';

  afterAll(async () => {
    if (userId !== '') {
      // Cascade removes the session rows; the user row is test-only.
      await migrator.$executeRaw`DELETE FROM "users" WHERE "id" = ${userId}::uuid`;
    }
  });

  it('creates a user and a session, then finds the session by token hash', async () => {
    const user = await client.user.create({
      data: { email: testEmail, displayName: 'Session Test User' },
    });
    userId = user.id;

    const token = rawToken();
    const now = new Date();
    const session = await createSession(client, {
      userId,
      tokenHash: hashToken(token),
      expiresAt: new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000),
      idleExpiresAt: new Date(now.getTime() + 12 * 60 * 60 * 1000),
    });

    expect(session.userId).toBe(userId);
    expect(session.revokedAt).toBeNull();

    const found = await findSessionByTokenHash(client, hashToken(token));

    expect(found).toBeDefined();
    expect(found?.id).toBe(session.id);
    expect(found?.revokedAt).toBeNull();
  });

  it('returns undefined for an unknown token hash (non-enumerable contract)', async () => {
    expect(await findSessionByTokenHash(client, hashToken(rawToken()))).toBeUndefined();
  });

  it('bumps lastSeenAt on touch', async () => {
    const token = rawToken();
    const session = await createSession(client, {
      userId,
      tokenHash: hashToken(token),
      expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      idleExpiresAt: new Date(Date.now() + 12 * 60 * 60 * 1000),
    });

    // Small delay so the timestamp difference is observable.
    await new Promise((resolve) => setTimeout(resolve, 20));
    await touchSession(client, session.id);

    const found = await findSessionByTokenHash(client, hashToken(token));
    expect(found?.id).toBe(session.id);
  });

  it('revokes a single session', async () => {
    const token = rawToken();
    const session = await createSession(client, {
      userId,
      tokenHash: hashToken(token),
      expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      idleExpiresAt: new Date(Date.now() + 12 * 60 * 60 * 1000),
    });

    await revokeSession(client, session.id);

    const found = await findSessionByTokenHash(client, hashToken(token));
    expect(found?.revokedAt).not.toBeNull();
  });

  it('revokes every live session for a user and reports the count', async () => {
    for (let index = 0; index < 3; index += 1) {
      await createSession(client, {
        userId,
        tokenHash: hashToken(rawToken()),
        expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
        idleExpiresAt: new Date(Date.now() + 12 * 60 * 60 * 1000),
      });
    }

    const revokedCount = await revokeAllSessions(client, userId);
    expect(revokedCount).toBeGreaterThanOrEqual(3);

    // A previously-live session is now revoked.
    const anySession = await findSessionByTokenHash(client, hashToken(rawToken()));
    expect(anySession).toBeUndefined();
  });
});
