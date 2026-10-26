import { ConfigService } from '@nestjs/config';
import { ProviderCredentialService } from './provider-credential.service';
const make = (key = 'a'.repeat(64)) => new ProviderCredentialService({ get: () => key } as unknown as ConfigService);
const credentials = { accountId: 'account', refreshToken: 'test-refresh-token', cookies: 'test-session=secret' };
describe('provider credential encryption', () => {
  it('encrypts with a random nonce and never includes plaintext', () => {
    const service = make();
    const first = service.encrypt(1, 'pagebound', credentials);
    expect(first).not.toContain('test-refresh-token');
    expect(first).not.toBe(service.encrypt(1, 'pagebound', credentials));
    expect(service.decrypt(1, 'pagebound', first)).toEqual(credentials);
  });
  it('binds ciphertext to the user and provider', () => {
    const service = make();
    const value = service.encrypt(1, 'pagebound', credentials);
    expect(() => service.decrypt(2, 'pagebound', value)).toThrow('cannot be decrypted');
    expect(() => service.decrypt(1, 'goodreads', value)).toThrow('cannot be decrypted');
  });
  it('rejects missing or invalid keys rather than storing plaintext', () => {
    for (const key of ['', 'short', 'z'.repeat(64)]) {
      expect(make(key).isConfigured()).toBe(false);
      expect(() => make(key).encrypt(1, 'pagebound', credentials)).toThrow('READING_PROVIDER_ENCRYPTION_KEY');
    }
  });
  it('rejects tampered ciphertext and rotated keys', () => {
    const value = make().encrypt(1, 'goodreads', credentials);
    const bytes = Buffer.from(value, 'base64');
    bytes[bytes.length - 1] = bytes[bytes.length - 1]! ^ 1;
    expect(() => make().decrypt(1, 'goodreads', bytes.toString('base64'))).toThrow('cannot be decrypted');
    expect(() => make('b'.repeat(64)).decrypt(1, 'goodreads', value)).toThrow('cannot be decrypted');
  });
});
