import { loadEnvironment } from '@hmn/shared';
import { afterAll, describe, expect, it } from 'vitest';
import { checkDatabase, createDatabaseClient } from '../../database.js';
import {
  createCredential,
  deleteCredential,
  findCredentialByUserId,
  updatePasswordHash,
} from './credentials.js';
import { hashPassword, verifyPassword } from '@hmn/shared';

const environment = loadEnvironment();
const client = createDatabaseClient({ connectionString: environment.DATABASE_APP_URL });
/** The migrator role cleans up test rows: hmn_app deliberately cannot DELETE global rows. */
const migrator = createDatabaseClient({ connectionString: environment.DATABASE_URL });

afterAll(async () => {
  await client.$disconnect();
  await migrator.$disconnect();
});

const dbAvailable = (await checkDatabase(client, 3_000)).status === 'ok';

describe.skipIf(!dbAvailable)('identity repository — credentials', () => {
  const testEmail = `cred-test-${Date.now()}@test.hmn.local`;
  let userId = '';

  afterAll(async () => {
    if (userId !== '') {
      // Cascade removes the credential row; the user row is test-only.
      await migrator.$executeRaw`DELETE FROM "users" WHERE "id" = ${userId}::uuid`;
    }
  });

  it('creates a user and a credential, then finds the credential by user id', async () => {
    const user = await client.user.create({
      data: {
        email: testEmail,
        mobile: `0912${String(Date.now()).slice(-8)}`,
        displayName: 'Credential Test User',
      },
    });
    userId = user.id;

    const passwordHash = await hashPassword('correct horse battery staple');
    const credential = await createCredential(client, { userId, passwordHash });

    expect(credential.userId).toBe(userId);
    expect(credential.passwordHash).toContain('scrypt$');

    const found = await findCredentialByUserId(client, userId);

    expect(found).toBeDefined();
    expect(found?.passwordHash).toBe(passwordHash);
  });

  it('verifies a password against the stored hash', async () => {
    const stored = await findCredentialByUserId(client, userId);
    expect(stored).toBeDefined();

    const result = await verifyPassword('correct horse battery staple', stored!.passwordHash);
    expect(result.matches).toBe(true);
    expect((await verifyPassword('wrong', stored!.passwordHash)).matches).toBe(false);
  });

  it('updates the password hash and the change timestamp', async () => {
    const before = await findCredentialByUserId(client, userId);
    expect(before).toBeDefined();

    const newHash = await hashPassword('new passphrase entirely');
    await updatePasswordHash(client, userId, newHash);

    const after = await findCredentialByUserId(client, userId);
    expect(after?.passwordHash).toBe(newHash);
    expect(after?.passwordUpdatedAt.getTime()).toBeGreaterThanOrEqual(
      before!.passwordUpdatedAt.getTime(),
    );
  });

  it('returns undefined for a user without a credential (non-enumerable contract)', async () => {
    const ghost = await client.user.create({
      data: {
        email: `no-cred-${Date.now()}@test.hmn.local`,
        displayName: 'No Credential',
      },
    });

    try {
      expect(await findCredentialByUserId(client, ghost.id)).toBeNull();
    } finally {
      await migrator.$executeRaw`DELETE FROM "users" WHERE "id" = ${ghost.id}::uuid`;
    }
  });

  it('deletes a credential', async () => {
    const user = await client.user.create({
      data: {
        email: `del-cred-${Date.now()}@test.hmn.local`,
        displayName: 'Delete Credential',
      },
    });

    try {
      const hash = await hashPassword('to be deleted');
      await createCredential(client, { userId: user.id, passwordHash: hash });
      await deleteCredential(client, user.id);
      expect(await findCredentialByUserId(client, user.id)).toBeNull();
    } finally {
      await migrator.$executeRaw`DELETE FROM "users" WHERE "id" = ${user.id}::uuid`;
    }
  });
});
