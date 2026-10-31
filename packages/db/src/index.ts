export * from './database.js';
export { validateRuntimeDatabaseRole } from './runtime-role.js';
export { withTenantTx, type TenantTx } from './tenant.js';
export {
  createMembership,
  findMembership,
  listMemberships,
  type CreateMembershipInput,
} from './repositories/tenant-memberships.js';
export {
  listAuditEvents,
  recordAuditEvent,
  type RecordAuditEventInput,
} from './repositories/audit-logs.js';
export {
  createCredential,
  deleteCredential,
  findCredentialByUserId,
  updatePasswordHash,
} from './repositories/identity/credentials.js';
export {
  createSession,
  findSessionByTokenHash,
  hashToken,
  revokeAllSessions,
  revokeSession,
  touchSession,
  type CreateSessionInput,
  type SessionLookupResult,
} from './repositories/identity/sessions.js';
export {
  countOtpsSince,
  createOtp,
  findLatestOtp,
  hashOtpCode,
  invalidateOtp,
  consumeOtp,
  addOtpAttempt,
  type ActiveOtp,
  type CreateOtpInput,
  type OtpPurpose,
} from './repositories/identity/otps.js';
export type { PrismaClient } from './generated/prisma/client.js';
