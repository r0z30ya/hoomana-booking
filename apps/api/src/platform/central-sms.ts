import type { PrismaClient } from '@hmn/db';
import { createSmsProvider, type SmsProvider } from '@hmn/integrations';
import { decryptSecret, encryptSecret, type SecretEncryptionConfig } from '@hmn/shared';

type Row = { ciphertext: Uint8Array; iv: Uint8Array; auth_tag: Uint8Array; key_version: number; sender: string; otp_body_id: number | null };
const context = 'platform|central-sms';

export function createCentralSmsService(client: PrismaClient, encryption: SecretEncryptionConfig, fallback?: { panelRef: string; sender: string; otpBodyId?: number | undefined }) {
  async function stored(): Promise<Row | undefined> {
    const rows = await client.$queryRaw<Row[]>`SELECT ciphertext, iv, auth_tag, key_version, sender, otp_body_id FROM public.central_sms_settings WHERE id = 1`;
    return rows[0];
  }
  async function config() {
    const row = await stored();
    const templates = await client.$queryRaw<Array<{ body_id: number | null }>>`SELECT body_id FROM public.central_sms_templates WHERE event = 'OTP'`;
    const templateOtp = templates[0];
    if (!row) return fallback ? { ...fallback, otpBodyId: templateOtp ? templateOtp.body_id ?? undefined : fallback.otpBodyId } : undefined;
    if (row.key_version !== encryption.keyVersion) throw new Error('SMS encryption key version unavailable');
    return { panelRef: decryptSecret({ ciphertext: Buffer.from(row.ciphertext), iv: Buffer.from(row.iv), authTag: Buffer.from(row.auth_tag) }, context, encryption), sender: row.sender, otpBodyId: templateOtp ? templateOtp.body_id ?? undefined : row.otp_body_id ?? undefined };
  }
  async function provider(): Promise<SmsProvider> {
    const current = await config();
    if (!current) throw new Error('SMS not configured');
    return createSmsProvider({ provider: 'melipayamak', ...current });
  }
  return {
    async status() {
      const row = await stored();
      const templates = await client.$queryRaw<Array<{ body_id: number | null }>>`SELECT body_id FROM public.central_sms_templates WHERE event = 'OTP'`;
      const sender = row?.sender ?? fallback?.sender ?? '';
      const otpBodyId = templates[0] ? templates[0].body_id : row ? row.otp_body_id : fallback?.otpBodyId ?? null;
      return { configured: !!(row || fallback?.panelRef) && !!sender, sender: sender || null, otpConfigured: otpBodyId !== null, otpBodyId, canEdit: true };
    },
    async save(actor: string, input: { panelRef?: string; sender: string; otpBodyId: number | null }) {
      const old = await config();
      const panelRef = input.panelRef || old?.panelRef;
      if (!panelRef) throw new Error('SMS panel reference required');
      const encrypted = encryptSecret(panelRef, context, encryption);
      await client.$queryRaw`SELECT public.platform_save_central_sms(${actor}::uuid, ${encrypted.ciphertext}, ${encrypted.iv}, ${encrypted.authTag}, ${encrypted.keyVersion}, ${input.sender}, ${input.otpBodyId})`;
    },
    async fetchCredit() { return (await provider()).fetchCredit(); },
    async sendOtp(mobile: string, code: string) { await (await provider()).sendOtp({ to: mobile, code }); },
  };
}
