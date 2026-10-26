import { ForbiddenException } from '@nestjs/common';
import { ReadingProviderService } from './reading-provider.service';
import { ReadingProviderRepository, type ClaimedSync } from './reading-provider.repository';
import { ProviderCredentialService } from './provider-credential.service';
import { PageboundClientService } from '../pagebound/pagebound-client.service';
import { GoodreadsClientService } from '../goodreads/goodreads-client.service';
import { UserService } from '../user/user.service';
import { LibraryService } from '../library/library.service';
import { BookService } from '../book/book.service';
import { ProviderFailure, type ProviderSession } from './provider.types';
const snapshot = { status: 'reading' as const, progress: 50, rating: null, startedOn: null, finishedOn: null };
function fixture() {
  const connection = {
    userId: 1,
    provider: 'pagebound' as const,
    credentialsEnc: 'encrypted',
    accountId: 'account',
    enabled: true,
    version: 1,
    reconnectRequired: false,
    leaseToken: 'lease',
    leaseUntil: new Date(Date.now() + 600000),
    createdAt: new Date(),
    updatedAt: new Date(),
    bulkActive: false,
    lastSyncedAt: null,
  };
  const book = {
    userId: 1,
    provider: 'pagebound' as const,
    bookId: 3,
    resourceId: 'edition',
    remoteId: '42',
    excluded: false,
    lastLocal: null,
    lastRemote: null,
    revision: 1,
    attempts: 0,
    error: null,
    uncertainWrite: false,
  };
  let remote = { ...snapshot, progress: 10, exists: true, progressKnown: true, ratingKnown: true, datesKnown: true, identity: 'read-1', raw: {} };
  const repo = {
    connection: vi.fn().mockResolvedValue(connection),
    state: vi.fn().mockResolvedValue(book),
    loadBook: vi.fn().mockResolvedValue({
      bookId: 3,
      title: 'Book',
      authors: ['Author'],
      isbn13: null,
      isbn10: null,
      goodreadsId: null,
      snapshot,
      sourceVersion: 'current',
    }),
    saveBook: vi.fn(),
    finish: vi.fn(),
    patchConnection: vi.fn().mockResolvedValue(true),
    enqueue: vi.fn(),
    clearQueue: vi.fn(),
    disconnect: vi.fn(),
    resetAccount: vi.fn(),
    replaceCredentials: vi.fn(),
  };
  const secrets = {
    isConfigured: vi.fn().mockReturnValue(true),
    encrypt: vi.fn().mockReturnValue('encrypted'),
    decrypt: vi.fn().mockReturnValue({ accountId: 'account', apiToken: 'test', refreshToken: 'test', expiresAt: Date.now() + 3600000 }),
  };
  const client = {
    capabilities: { progress: true, ratings: true, readingDates: true, limitations: [] },
    getBook: vi.fn().mockResolvedValue({
      id: '42',
      resourceId: 'edition',
      title: 'Book',
      authors: ['Author'],
      isbn: null,
      pages: 300,
      url: 'https://pagebound.co/books/edition',
    }),
    read: vi.fn().mockImplementation(() => Promise.resolve(remote)),
    write: vi.fn().mockImplementation(async (session: ProviderSession, _book: unknown, _remote: unknown, changes: object) => {
      await session.beforeWrite();
      remote = { ...remote, ...changes };
    }),
    validate: vi.fn(),
    connect: vi.fn().mockResolvedValue({ accountId: 'account', apiToken: 'test', refreshToken: 'test' }),
    search: vi.fn(),
  };
  const users = { findByIdWithPermissions: vi.fn().mockResolvedValue({ id: 1, active: true, isSuperuser: true, permissions: [] }) };
  const libraries = { findAccessibleLibraryIds: vi.fn().mockResolvedValue([7]) };
  const books = { verifyBookAccess: vi.fn() };
  const service = new ReadingProviderService(
    repo as unknown as ReadingProviderRepository,
    secrets as unknown as ProviderCredentialService,
    client as unknown as PageboundClientService,
    client as unknown as GoodreadsClientService,
    users as unknown as UserService,
    libraries as unknown as LibraryService,
    books as unknown as BookService,
  );
  const claim = { connection, book, token: 'lease' } as unknown as ClaimedSync;
  return { service, repo, secrets, client, users, libraries, books, claim, connection, book };
}
describe('durable reading provider synchronization', () => {
  it('loads current local state, verifies the remote write, then stores successful snapshots', async () => {
    const f = fixture();
    await f.service.process(f.claim);
    expect(f.client.write).toHaveBeenCalledTimes(1);
    expect(f.repo.loadBook).toHaveBeenCalledTimes(2);
    expect(f.repo.finish).toHaveBeenCalledWith(
      f.claim,
      expect.objectContaining({ lastLocal: snapshot, lastRemote: expect.objectContaining({ progress: 50 }), error: null, uncertainWrite: false }),
      null,
    );
  });
  it('does not call a provider when the local snapshot has not changed', async () => {
    const f = fixture();
    f.claim.book.lastLocal = snapshot;
    await f.service.process(f.claim);
    expect(f.client.getBook).not.toHaveBeenCalled();
    expect(f.repo.finish).toHaveBeenCalledWith(f.claim, {}, null);
  });
  it('rechecks a previously withheld field when the user retries unchanged local progress', async () => {
    const f = fixture();
    f.claim.book.lastLocal = snapshot;
    f.claim.book.warning = 'Remote progress was previously unreadable';
    await f.service.process(f.claim);
    expect(f.client.write).toHaveBeenCalledTimes(1);
  });
  it('refuses an old queued snapshot when newer local progress arrives before the write', async () => {
    const f = fixture();
    f.repo.loadBook
      .mockResolvedValueOnce({ bookId: 3, title: 'Book', authors: ['Author'], snapshot, sourceVersion: 'old' })
      .mockResolvedValue({ snapshot: { ...snapshot, progress: 80 }, sourceVersion: 'new' });
    await f.service.process(f.claim);
    expect(f.repo.saveBook).not.toHaveBeenCalledWith(1, 'pagebound', 3, { uncertainWrite: true });
    expect(f.repo.finish).toHaveBeenCalledWith(
      f.claim,
      expect.objectContaining({ error: expect.stringContaining('Newer reading information'), attempts: 1 }),
      5000,
    );
  });
  it.each(['disabled', 'excluded', 'connection-replaced', 'link-replaced', 'lease-expired'])('stops an in-flight write after %s', async (change) => {
    const f = fixture();
    if (change === 'disabled') f.connection.enabled = false;
    if (change === 'excluded') f.book.excluded = true;
    if (change === 'connection-replaced') f.repo.connection.mockResolvedValue({ ...f.connection, version: 2 });
    if (change === 'link-replaced') f.repo.state.mockResolvedValue({ ...f.book, resourceId: 'different-edition' });
    if (change === 'lease-expired') f.connection.leaseUntil = new Date(0);
    await f.service.process(f.claim);
    expect(f.repo.saveBook).not.toHaveBeenCalledWith(1, 'pagebound', 3, { uncertainWrite: true });
    expect(f.repo.finish).toHaveBeenCalledWith(f.claim, expect.objectContaining({ error: expect.stringContaining('cancelled') }), null);
  });
  it('rechecks user access at execution time instead of trusting old queue ownership', async () => {
    const f = fixture();
    f.users.findByIdWithPermissions.mockResolvedValue({ id: 1, active: true, isSuperuser: false, permissions: [] });
    await f.service.process(f.claim);
    expect(f.client.getBook).not.toHaveBeenCalled();
    expect(f.repo.finish).toHaveBeenCalledWith(f.claim, expect.objectContaining({ error: expect.stringContaining('no longer has access') }), null);
  });
  it('does not update success markers after a partial provider failure', async () => {
    const f = fixture();
    f.client.write.mockRejectedValue(new ProviderFailure('network_error', 'Temporary failure', true, false, true));
    await f.service.process(f.claim);
    expect(f.repo.finish).toHaveBeenCalledWith(f.claim, { error: 'Temporary failure', attempts: 1, uncertainWrite: true }, 5000);
    expect(f.repo.patchConnection).not.toHaveBeenCalledWith(1, 'pagebound', 1, expect.objectContaining({ lastSyncedAt: expect.anything() }));
  });
  it('does not mark a 200 response successful when read-back does not confirm the write', async () => {
    const f = fixture();
    f.client.write.mockResolvedValue(undefined);
    await f.service.process(f.claim);
    expect(f.repo.finish).toHaveBeenCalledWith(
      f.claim,
      expect.objectContaining({ error: expect.stringContaining('did not confirm'), uncertainWrite: true }),
      null,
    );
  });
  it('stops permanent authentication retries and exposes reconnection', async () => {
    const f = fixture();
    f.client.read.mockRejectedValue(new ProviderFailure('session_expired', 'Reconnect', false, true));
    await f.service.process(f.claim);
    expect(f.repo.patchConnection).toHaveBeenCalledWith(1, 'pagebound', 1, expect.objectContaining({ enabled: false, reconnectRequired: true }));
    expect(f.repo.finish).toHaveBeenCalledWith(f.claim, expect.anything(), null);
  });
  it('caps retry attempts instead of retrying forever', async () => {
    const f = fixture();
    f.claim.book.attempts = 5;
    f.client.read.mockRejectedValue(new ProviderFailure('busy', 'Try later', true));
    await f.service.process(f.claim);
    expect(f.repo.finish).toHaveBeenCalledWith(f.claim, expect.objectContaining({ attempts: 6 }), null);
  });
  it('enabling validates the connection but never starts an initial bulk sync', async () => {
    const f = fixture();
    await f.service.setEnabled(1, 'pagebound', true);
    expect(f.client.validate).toHaveBeenCalled();
    expect(f.repo.patchConnection).toHaveBeenCalledWith(1, 'pagebound', 1, expect.objectContaining({ enabled: true, bulkActive: false, version: 2 }));
    expect(f.repo.enqueue).not.toHaveBeenCalled();
  });
  it('queues only enabled providers and respects per-book exclusions', async () => {
    const f = fixture();
    f.repo.connection.mockImplementation((_user, provider) => Promise.resolve({ ...f.connection, enabled: provider === 'pagebound' }));
    await f.service.enqueueAutomatic(1, 3);
    expect(f.repo.enqueue).toHaveBeenCalledExactlyOnceWith(1, 'pagebound', 3, 3000, 1);
    f.repo.enqueue.mockClear();
    f.repo.state.mockResolvedValue({ ...f.book, excluded: true });
    await f.service.enqueueAutomatic(1, 3);
    expect(f.repo.enqueue).not.toHaveBeenCalled();
  });
  it('rejects credentials before network sign-in if secure storage is not configured', async () => {
    const f = fixture();
    f.secrets.isConfigured.mockReturnValue(false);
    await expect(f.service.connect(1, 'pagebound', { email: 'test@example.com', password: 'test' })).rejects.toThrow('ENCRYPTION_KEY');
    expect(f.client.connect).not.toHaveBeenCalled();
  });
  it('uses optimistic credential persistence so a disconnected session cannot restore secrets', async () => {
    const f = fixture();
    f.client.validate.mockImplementation(async (session: ProviderSession) => session.saveCredentials({ accountId: 'account', apiToken: 'new' }));
    f.repo.patchConnection.mockResolvedValue(false);
    await expect(f.service.validate(1, 'pagebound')).rejects.toThrow('connection changed');
    expect(f.repo.patchConnection).toHaveBeenCalledWith(1, 'pagebound', 1, { credentialsEnc: 'encrypted' });
  });
  it('checks book access before manual linking or exclusion', async () => {
    const f = fixture();
    f.books.verifyBookAccess.mockRejectedValue(new ForbiddenException());
    await expect(f.service.link(1, 'pagebound', 99, 'edition')).rejects.toBeInstanceOf(ForbiddenException);
    expect(f.client.getBook).not.toHaveBeenCalled();
    expect(f.repo.saveBook).not.toHaveBeenCalled();
  });
});
