import { ValidationError } from '@hmn/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from './generated/prisma/client.js';
import { withTenantTx } from './tenant.js';

/**
 * Unit tests U2 and U3 (ADR-0003 Phase 3 security test plan).
 *
 * The client is spied, not connected: U2/U3 assert the helper's own contract —
 * validation before any query, and `set_config(..., is_local => true)` as the
 * transaction's first statement. The database-level effect of that contract is
 * proven by the integration tests (S2–S5) in `tenant-rls.integration.test.ts`.
 */

interface RecordedCall {
  readonly tag: string;
  readonly sql: readonly unknown[];
}

const recorded: RecordedCall[] = [];

const executeRawMock = vi.fn((_query: TemplateStringsArray, ...values: unknown[]) => {
  recorded.push({ tag: 'tx.$executeRaw', sql: [...values] });
  return Promise.resolve(0);
});

const createMock = vi.fn(() => Promise.resolve({}));

const txSpy = {
  $executeRaw: executeRawMock,
  tenantMembership: {
    create: createMock,
  },
};

const transactionMock = vi.fn((fn: (tx: unknown) => Promise<unknown>) => fn(txSpy));

const clientSpy = {
  $transaction: transactionMock,
} as unknown as PrismaClient;

const UUID_A = '11111111-1111-4111-8111-111111111111';

beforeEach(() => {
  recorded.length = 0;
  executeRawMock.mockClear();
  createMock.mockClear();
  transactionMock.mockClear();
});

describe('withTenantTx (U2, U3)', () => {
  it('U2: rejects a missing tenant id before any query executes', async () => {
    await expect(
      withTenantTx(clientSpy, '', () => Promise.resolve('unused')),
    ).rejects.toBeInstanceOf(ValidationError);

    expect(transactionMock).not.toHaveBeenCalled();
    expect(executeRawMock).not.toHaveBeenCalled();
  });

  it('U2: rejects a non-UUID tenant id before any query executes', async () => {
    await expect(
      withTenantTx(clientSpy, "'; DROP TABLE users; --", () => Promise.resolve('unused')),
    ).rejects.toBeInstanceOf(ValidationError);

    expect(transactionMock).not.toHaveBeenCalled();
    expect(executeRawMock).not.toHaveBeenCalled();
  });

  it('U2: carries the INVALID_TENANT_CONTEXT code', async () => {
    const error = await withTenantTx(clientSpy, 'not-a-uuid', () =>
      Promise.resolve('unused'),
    ).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ValidationError);
    expect((error as ValidationError).code).toBe('INVALID_TENANT_CONTEXT');
  });

  it('U3: issues set_config with is_local=true as the transaction FIRST statement', async () => {
    await withTenantTx(clientSpy, UUID_A, async (tx) => {
      await tx.tenantMembership.create({
        data: {
          tenantId: UUID_A,
          userId: '00000000-0000-4000-8000-000000000001',
          role: 'RECEPTION',
        },
      });
      return 'done';
    });

    expect(transactionMock).toHaveBeenCalledTimes(1);
    expect(executeRawMock).toHaveBeenCalledTimes(1);
    // The tenant id is the single bound parameter; `is_local => true` is fixed
    // SQL text in the template (it must never be caller-controlled).
    expect(recorded).toEqual([{ tag: 'tx.$executeRaw', sql: [UUID_A] }]);
  });

  it('U3: never interpolates the tenant id into SQL text (parameterized only)', async () => {
    await withTenantTx(clientSpy, UUID_A, () => Promise.resolve('done'));

    // The tagged-template contract: the tenant id is a bound parameter, while
    // `is_local => true` is fixed SQL text — the caller cannot weaken it.
    const call = executeRawMock.mock.calls[0];
    expect(call).toBeDefined();
    const sqlText = (call?.[0] as readonly string[]).join('?');
    expect(sqlText).toContain("set_config('app.current_tenant_id', ");
    expect(sqlText).toContain(', true)');
    expect(sqlText).not.toContain(UUID_A);
  });

  it('returns the callback result and runs inside one transaction', async () => {
    const result = await withTenantTx(clientSpy, UUID_A, () => Promise.resolve(42));

    expect(result).toBe(42);
    expect(transactionMock).toHaveBeenCalledTimes(1);
  });
});
