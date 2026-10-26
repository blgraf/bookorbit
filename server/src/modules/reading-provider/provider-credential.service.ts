import { BadRequestException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import type { ReadingProvider } from '@bookorbit/types';
import type { ProviderCredentials } from './provider.types';

@Injectable()
export class ProviderCredentialService {
  private readonly key: Buffer | null;
  constructor(config: ConfigService) {
    const value = config.get<string>('readingProvider.encryptionKey') ?? '';
    this.key = /^[a-f0-9]{64}$/i.test(value) ? Buffer.from(value, 'hex') : null;
  }
  isConfigured() {
    return this.key !== null;
  }
  private requireKey(): Buffer {
    if (!this.key) throw new BadRequestException('Set READING_PROVIDER_ENCRYPTION_KEY to a 64-character hex key before connecting providers.');
    return this.key;
  }
  encrypt(userId: number, provider: ReadingProvider, credentials: ProviderCredentials): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.requireKey(), iv);
    cipher.setAAD(Buffer.from(`reading-provider:v1:${userId}:${provider}`));
    const encrypted = Buffer.concat([cipher.update(JSON.stringify(credentials), 'utf8'), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('base64');
  }
  decrypt(userId: number, provider: ReadingProvider, value: string): ProviderCredentials {
    const key = this.requireKey();
    try {
      const bytes = Buffer.from(value, 'base64');
      const decipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12));
      decipher.setAAD(Buffer.from(`reading-provider:v1:${userId}:${provider}`));
      decipher.setAuthTag(bytes.subarray(12, 28));
      return JSON.parse(Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString('utf8')) as ProviderCredentials;
    } catch {
      throw new BadRequestException('Stored provider credentials cannot be decrypted. Restore the encryption key or reconnect.');
    }
  }
}
