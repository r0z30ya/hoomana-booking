import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { InternalError } from './errors.js';

export interface SecretEncryptionConfig {
  readonly key: Buffer;
  readonly keyVersion: number;
}

export interface EncryptedSecret {
  readonly ciphertext: Uint8Array;
  readonly iv: Uint8Array;
  readonly authTag: Uint8Array;
  readonly keyVersion: number;
}

export function encryptSecret(
  value: string,
  aad: string,
  config: SecretEncryptionConfig,
): EncryptedSecret {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', config.key, iv);
  cipher.setAAD(Buffer.from(aad, 'utf8'));
  const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);

  return {
    ciphertext: new Uint8Array(ciphertext),
    iv: new Uint8Array(iv),
    authTag: new Uint8Array(cipher.getAuthTag()),
    keyVersion: config.keyVersion,
  };
}

export function decryptSecret(
  encrypted: Omit<EncryptedSecret, 'keyVersion'>,
  aad: string,
  config: SecretEncryptionConfig,
): string {
  try {
    const decipher = createDecipheriv('aes-256-gcm', config.key, encrypted.iv);
    decipher.setAAD(Buffer.from(aad, 'utf8'));
    decipher.setAuthTag(Buffer.from(encrypted.authTag));
    return Buffer.concat([
      decipher.update(Buffer.from(encrypted.ciphertext)),
      decipher.final(),
    ]).toString('utf8');
  } catch (error) {
    throw new InternalError('Stored tenant secret could not be decrypted', {
      code: 'TENANT_SECRET_DECRYPT_FAILED',
      cause: error,
    });
  }
}
