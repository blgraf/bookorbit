import { and, eq } from 'drizzle-orm';
import { hash } from 'bcryptjs';
import { Permission } from '@bookorbit/types';
import * as schema from '../src/db/schema';
import { createE2EContext, closeE2EContext, seedLibrary, type E2EContext } from './e2e/app-harness';
import { ReadingProviderRepository } from '../src/modules/reading-provider/reading-provider.repository';
import { ReadingProviderService } from '../src/modules/reading-provider/reading-provider.service';
import { ReadingProviderWorker } from '../src/modules/reading-provider/reading-provider-worker.service';
import { PageboundClientService } from '../src/modules/pagebound/pagebound-client.service';
import { GoodreadsClientService } from '../src/modules/goodreads/goodreads-client.service';
import { ProviderCredentialService } from '../src/modules/reading-provider/provider-credential.service';
import type { ProviderSession } from '../src/modules/reading-provider/provider.types';

describe('reading provider persistence and HTTP authorization', () => {
  let ctx: E2EContext;
  let repo: ReadingProviderRepository;
  let service: ReadingProviderService;
  let adminId: number;
  let bookId: number;
  let secondBookId: number;
  let otherToken: string;
  let otherId: number;
  let previousKey: string | undefined;
  const auth = () => ({ authorization: `Bearer ${ctx.adminToken}` });
  const candidate = {
    id: '42',
    resourceId: 'edition',
    title: 'Fixture Book',
    authors: ['Fixture Author'],
    isbn: null,
    pages: 200,
    url: 'https://pagebound.co/books/edition',
  };
  beforeAll(async () => {
    previousKey = process.env.READING_PROVIDER_ENCRYPTION_KEY;
    process.env.READING_PROVIDER_ENCRYPTION_KEY = 'a'.repeat(64);
    ctx = await createE2EContext({ isolateAppData: true });
    ctx.app.get(ReadingProviderWorker).onModuleDestroy();
    repo = ctx.app.get(ReadingProviderRepository);
    service = ctx.app.get(ReadingProviderService);
    adminId = (await ctx.db.query.users.findFirst({ where: eq(schema.users.isSuperuser, true) }))!.id;
    const library = await seedLibrary(ctx.db, { rootPath: '/tmp/reading-provider-e2e-books', mode: 'book_per_file' });
    const created = await ctx.db
      .insert(schema.books)
      .values(
        [1, 2].map((number) => ({
          libraryId: library.libraryId,
          libraryFolderId: library.libraryFolderId,
          folderPath: `/tmp/reading-provider-e2e-books/${number}`,
        })),
      )
      .returning({ id: schema.books.id });
    bookId = created[0]!.id;
    secondBookId = created[1]!.id;
    await ctx.db.insert(schema.bookMetadata).values([
      { bookId, title: 'Fixture Book' },
      { bookId: secondBookId, title: 'Other Fixture' },
    ]);
    const [file] = await ctx.db
      .insert(schema.bookFiles)
      .values({
        bookId,
        libraryId: library.libraryId,
        libraryFolderId: library.libraryFolderId,
        absolutePath: '/tmp/reading-provider-e2e-books/fixture.epub',
        ino: 100n,
        format: 'epub',
      })
      .returning({ id: schema.bookFiles.id });
    await ctx.db.update(schema.books).set({ primaryFileId: file!.id }).where(eq(schema.books.id, bookId));
    await ctx.db.insert(schema.userBookStatus).values([
      { userId: adminId, bookId, status: 'reading' },
      { userId: adminId, bookId: secondBookId, status: 'reading' },
    ]);
    await ctx.db.insert(schema.readingProgress).values({ userId: adminId, bookFileId: file!.id, percentage: 50 });
    const [other] = await ctx.db
      .insert(schema.users)
      .values({ username: 'reading-provider-other', name: 'Other', passwordHash: await hash('TestPassword123', 4), isDefaultPassword: false })
      .returning({ id: schema.users.id });
    otherId = other!.id;
    await ctx.db.insert(schema.userPermissions).values({ userId: otherId, permissionName: Permission.GoodreadsSync });
    const login = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { username: 'reading-provider-other', password: 'TestPassword123' },
    });
    otherToken = (login.json() as { accessToken: string }).accessToken;
    for (const client of [ctx.app.get(PageboundClientService), ctx.app.get(GoodreadsClientService)]) {
      vi.spyOn(client, 'connect').mockResolvedValue({
        accountId: 'fixture-account',
        apiToken: 'fixture-api-token',
        refreshToken: 'fixture-refresh-token',
      });
      vi.spyOn(client, 'validate').mockResolvedValue(undefined);
      vi.spyOn(client, 'getBook').mockResolvedValue(candidate);
    }
  }, 60_000);
  afterAll(async () => {
    vi.restoreAllMocks();
    if (ctx) await closeE2EContext(ctx);
    if (previousKey === undefined) delete process.env.READING_PROVIDER_ENCRYPTION_KEY;
    else process.env.READING_PROVIDER_ENCRYPTION_KEY = previousKey;
  });
  beforeEach(async () => {
    await ctx.db.delete(schema.readingProviderBooks);
    await ctx.db.delete(schema.readingProviderConnections);
  });
  async function enabled() {
    const secrets = ctx.app.get(ProviderCredentialService);
    await repo.saveConnection(adminId, 'pagebound', {
      enabled: true,
      accountId: 'fixture-account',
      credentialsEnc: secrets.encrypt(adminId, 'pagebound', {
        accountId: 'fixture-account',
        apiToken: 'fixture-api-token',
        refreshToken: 'fixture-refresh-token',
      }),
      enabledAt: new Date(),
      dateCursorAt: new Date(),
    });
  }
  it('exposes independent protected provider routes with strict DTO validation', async () => {
    expect((await ctx.app.inject({ method: 'GET', url: '/api/v1/pagebound/settings' })).statusCode).toBe(401);
    expect(
      (await ctx.app.inject({ method: 'GET', url: '/api/v1/pagebound/settings', headers: { authorization: `Bearer ${otherToken}` } })).statusCode,
    ).toBe(403);
    expect(
      (await ctx.app.inject({ method: 'GET', url: '/api/v1/goodreads/settings', headers: { authorization: `Bearer ${otherToken}` } })).statusCode,
    ).toBe(200);
    expect(
      (await ctx.app.inject({ method: 'PATCH', url: '/api/v1/pagebound/settings', headers: auth(), payload: { enabled: true, userId: otherId } }))
        .statusCode,
    ).toBe(400);
  });
  it('encrypts credentials, keeps both providers disabled, and never returns secrets', async () => {
    for (const provider of ['pagebound', 'goodreads'] as const) {
      const response = await ctx.app.inject({
        method: 'POST',
        url: `/api/v1/${provider}/connect`,
        headers: auth(),
        payload: provider === 'pagebound' ? { email: 'test@example.com', password: 'test-password' } : { cookies: 'fixture=session' },
      });
      expect(response.statusCode).toBe(201);
      expect(response.json()).toMatchObject({ connected: true, enabled: false });
      expect(response.body).not.toContain('fixture-api-token');
      const row = await repo.connection(adminId, provider);
      expect(row!.credentialsEnc).not.toContain('fixture-refresh-token');
    }
    expect(await repo.claim()).toBeNull();
  });
  it('checks library access for manual linking, book settings, and sync', async () => {
    for (const path of [`/api/v1/goodreads/books/${bookId}`, `/api/v1/goodreads/books/${bookId}/candidates?q=test`]) {
      const response = await ctx.app.inject({ method: 'GET', url: path, headers: { authorization: `Bearer ${otherToken}` } });
      expect([403, 404]).toContain(response.statusCode);
    }
    expect(await repo.listBooks(otherId, 'goodreads', { libraryIds: [] }, 0)).toEqual([]);
  });
  it('coalesces repeated events and preserves a newer revision arriving during a job', async () => {
    await enabled();
    await repo.enqueue(adminId, 'pagebound', bookId, 0);
    await repo.enqueue(adminId, 'pagebound', bookId, 0);
    const claim = await repo.claim();
    expect(claim).not.toBeNull();
    expect(claim!.book.revision).toBe(2);
    await repo.enqueue(adminId, 'pagebound', bookId, 0);
    await repo.finish(claim!, { error: null }, null);
    const state = await repo.state(adminId, 'pagebound', bookId);
    expect(state!.revision).toBe(3);
    expect(state!.dueAt).not.toBeNull();
  });
  it('serializes a user/provider across competing workers and recovers expired leases', async () => {
    await enabled();
    await repo.enqueue(adminId, 'pagebound', bookId, 0);
    await repo.enqueue(adminId, 'pagebound', secondBookId, 0);
    const claims = await Promise.all([repo.claim(), repo.claim()]);
    expect(claims.filter(Boolean)).toHaveLength(1);
    const old = claims.find(Boolean)!;
    await ctx.db
      .update(schema.readingProviderConnections)
      .set({ leaseUntil: new Date(0) })
      .where(eq(schema.readingProviderConnections.userId, adminId));
    const replacement = await repo.claim();
    expect(replacement).not.toBeNull();
    expect(replacement!.token).not.toBe(old.token);
    await repo.finish(old, { error: 'old worker must not finish new work' }, null);
    expect((await repo.connection(adminId, 'pagebound'))!.leaseToken).toBe(replacement!.token);
  });
  it('processes a real queued book from current DB state and verifies a mocked remote update', async () => {
    await enabled();
    await repo.saveBook(adminId, 'pagebound', bookId, { resourceId: 'edition', remoteId: '42' });
    await repo.enqueue(adminId, 'pagebound', bookId, 0);
    const claim = await repo.claim();
    expect(claim).not.toBeNull();
    let remote = {
      status: 'reading' as const,
      progress: 10,
      rating: null,
      startedOn: null,
      finishedOn: null,
      exists: true,
      progressKnown: true,
      ratingKnown: false,
      datesKnown: true,
      identity: 'read-1',
      raw: {},
    };
    const client = ctx.app.get(PageboundClientService);
    const read = vi.spyOn(client, 'read').mockImplementation(() => Promise.resolve(remote));
    const write = vi.spyOn(client, 'write').mockImplementation(async (session: ProviderSession, _book, _state, changes) => {
      await session.beforeWrite();
      remote = { ...remote, ...changes } as typeof remote;
    });
    await service.process(claim!);
    expect(write).toHaveBeenCalledTimes(1);
    const state = await repo.state(adminId, 'pagebound', bookId);
    expect(state).toMatchObject({ lastLocal: { progress: 50 }, lastRemote: { progress: 50 }, error: null, dueAt: null });
    expect(state!.lastSyncedAt).not.toBeNull();
    read.mockRestore();
    write.mockRestore();
  });
  it('applies exclusions and cancels pending work on disconnect', async () => {
    await enabled();
    await repo.enqueue(adminId, 'pagebound', bookId, 0);
    const excluded = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/v1/pagebound/books/${bookId}`,
      headers: auth(),
      payload: { excluded: true },
    });
    expect(excluded.statusCode).toBe(200);
    expect(await repo.claim()).toBeNull();
    const version = (await repo.connection(adminId, 'pagebound'))!.version;
    await ctx.app.inject({ method: 'DELETE', url: '/api/v1/pagebound/settings', headers: auth() });
    expect(await repo.patchConnection(adminId, 'pagebound', version, { credentialsEnc: 'must-not-return' })).toBe(false);
    expect(await repo.connection(adminId, 'pagebound')).toMatchObject({ credentialsEnc: null, enabled: false });
  });
  it('does not accept late work from a cancelled bulk run', async () => {
    await enabled();
    const version = (await repo.connection(adminId, 'pagebound'))!.version;
    await service.bulk(adminId, 'pagebound', false);
    await repo.enqueue(adminId, 'pagebound', bookId, 0, version);
    expect(await repo.claim()).toBeNull();
    const current = (await repo.connection(adminId, 'pagebound'))!;
    expect(current.version).toBeGreaterThan(version);
    await repo.enqueue(adminId, 'pagebound', bookId, 0, current.version);
    expect(await repo.claim()).not.toBeNull();
  });
  it('never applies an old success baseline to a manually replaced book link', async () => {
    await enabled();
    await repo.saveBook(adminId, 'pagebound', bookId, { resourceId: 'old-edition' });
    await repo.enqueue(adminId, 'pagebound', bookId, 0);
    const claim = (await repo.claim())!;
    await repo.saveBook(adminId, 'pagebound', bookId, { resourceId: 'new-edition', lastLocal: null, revision: claim.book.revision + 1, dueAt: null });
    await repo.finish(claim, { lastLocal: { status: 'reading', progress: 90, rating: null, startedOn: null, finishedOn: null } }, null);
    expect(await repo.state(adminId, 'pagebound', bookId)).toMatchObject({ resourceId: 'new-edition', lastLocal: null, dueAt: null });
  });
  it('does not reuse previous-attempt progress when a same-day reread starts', async () => {
    await ctx.db
      .update(schema.userBookStatus)
      .set({ status: 'rereading', startedAt: new Date('2026-10-26T00:00:00Z') })
      .where(and(eq(schema.userBookStatus.userId, adminId), eq(schema.userBookStatus.bookId, bookId)));
    await ctx.db.insert(schema.readingAttempts).values({ userId: adminId, bookId, startedOn: '2026-10-26', origin: 'bookorbit' });
    const local = await repo.loadBook(adminId, 'pagebound', bookId, {
      libraryIds: [(await ctx.db.query.books.findFirst({ where: eq(schema.books.id, bookId) }))!.libraryId],
    });
    expect(local.snapshot.progress).toBeNull();
    await ctx.db
      .update(schema.userBookStatus)
      .set({ status: 'reading', startedAt: null })
      .where(and(eq(schema.userBookStatus.userId, adminId), eq(schema.userBookStatus.bookId, bookId)));
  });
  it('keeps status/date reconciliation off for history predating enablement', async () => {
    await enabled();
    const connection = (await repo.connection(adminId, 'pagebound'))!;
    expect(await repo.changedDates(connection)).toEqual([]);
    await ctx.db
      .update(schema.userBookStatus)
      .set({ startedAt: new Date('2026-10-01T00:00:00.000Z') })
      .where(and(eq(schema.userBookStatus.userId, adminId), eq(schema.userBookStatus.bookId, bookId)));
    expect((await repo.changedDates(connection)).map((row) => row.bookId)).toEqual([bookId]);
  });
});
