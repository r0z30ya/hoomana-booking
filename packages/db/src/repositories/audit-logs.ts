import type { TenantTx } from '../tenant.js';

/**
 * Tenant-scoped repository: `audit_logs` (tenant-owned rows).
 *
 * Same boundary rules as the other tenant repositories (ADR-0003 D4): a
 * `TenantTx` handle is the only accepted argument type and this module must not
 * import the generated client or `../database.js`.
 *
 * `tenantId` is nullable in the schema for platform-level rows; this
 * tenant-scoped repository deliberately requires a non-null tenant so an
 * audit entry is always written inside the same tenant-contextualised
 * transaction as the operation it describes (ADR-0003 D5).
 */

/**
 * JSON-serializable value for audit `details`. Structurally mirrors Prisma's
 * `InputJsonValue` so no assertion is needed at the create call — this module
 * must not import the generated client (ESLint boundary, ADR-0003 D4).
 */
export type JsonDetail =
  | string
  | number
  | boolean
  | readonly JsonDetail[]
  | { readonly [key: string]: JsonDetail | undefined };

export interface RecordAuditEventInput {
  readonly tenantId: string;
  readonly actorUserId?: string;
  readonly actorRole?: 'OWNER' | 'DOCTOR' | 'RECEPTION' | 'CUSTOM';
  readonly action: string;
  readonly targetType?: string;
  readonly targetId?: string;
  readonly details?: JsonDetail;
}

export async function recordAuditEvent(tx: TenantTx, input: RecordAuditEventInput) {
  return tx.auditLog.create({
    data: {
      tenantId: input.tenantId,
      action: input.action,
      // Conditional spreads keep exactOptionalPropertyTypes happy: optional
      // fields are omitted entirely rather than passed as explicit undefined.
      ...(input.actorUserId !== undefined && { actorUserId: input.actorUserId }),
      ...(input.actorRole !== undefined && { actorRole: input.actorRole }),
      ...(input.targetType !== undefined && { targetType: input.targetType }),
      ...(input.targetId !== undefined && { targetId: input.targetId }),
      ...(input.details !== undefined && { details: input.details }),
    },
  });
}

export async function listAuditEvents(tx: TenantTx, tenantId: string, limit = 100) {
  return tx.auditLog.findMany({
    where: { tenantId },
    orderBy: { createdAt: 'desc' },
    take: limit,
  });
}
