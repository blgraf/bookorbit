import { BadRequestException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import {
  Permission,
  type ReadingProvider,
  type ReadingProviderBook,
  type ReadingProviderCandidate,
  type ReadingProviderConnectPayload,
  type ReadingProviderSettings,
} from '@bookorbit/types';
import type { RequestUser } from '../../common/types/request-user';
import { BookService } from '../book/book.service';
import { LibraryService } from '../library/library.service';
import { UserService } from '../user/user.service';
import { PageboundClientService } from '../pagebound/pagebound-client.service';
import { GoodreadsClientService } from '../goodreads/goodreads-client.service';
import { ProviderCredentialService } from './provider-credential.service';
import { chooseMatch, planSync } from './provider-policy';
import { ProviderFailure, type ProviderSession, type ReadingProviderClient } from './provider.types';
import { ReadingProviderRepository, type ClaimedSync } from './reading-provider.repository';

const PERMISSION = { pagebound: Permission.PageboundSync, goodreads: Permission.GoodreadsSync };
@Injectable()
export class ReadingProviderService {
  private readonly logger = new Logger(ReadingProviderService.name);
  constructor(
    private readonly repo: ReadingProviderRepository,
    private readonly secrets: ProviderCredentialService,
    private readonly pagebound: PageboundClientService,
    private readonly goodreads: GoodreadsClientService,
    private readonly users: UserService,
    private readonly libraries: LibraryService,
    private readonly books: BookService,
  ) {}
  client(provider: ReadingProvider): ReadingProviderClient {
    return provider === 'pagebound' ? this.pagebound : this.goodreads;
  }
  async user(userId: number, provider: ReadingProvider): Promise<RequestUser> {
    const user = await this.users.findByIdWithPermissions(userId);
    if (!user?.active || (!user.isSuperuser && !user.permissions.includes(PERMISSION[provider])))
      throw new ForbiddenException('Provider sync permission is required.');
    return user;
  }
  async access(user: RequestUser) {
    return { libraryIds: await this.libraries.findAccessibleLibraryIds(user), contentFilters: user.isSuperuser ? undefined : user.contentFilters };
  }
  async settings(userId: number, provider: ReadingProvider): Promise<ReadingProviderSettings> {
    await this.user(userId, provider);
    const row = await this.repo.connection(userId, provider);
    return {
      provider,
      connected: Boolean(row?.credentialsEnc),
      enabled: row?.enabled ?? false,
      reconnectRequired: row?.reconnectRequired ?? false,
      accountId: row?.accountId ?? null,
      encryptionConfigured: this.secrets.isConfigured(),
      lastSyncedAt: row?.lastSyncedAt?.toISOString() ?? null,
      error: row?.error ?? null,
      capabilities: this.client(provider).capabilities,
    };
  }
  private session(connection: NonNullable<Awaited<ReturnType<ReadingProviderRepository['connection']>>>): ProviderSession {
    if (!connection.credentialsEnc) throw new BadRequestException('Connect this provider first.');
    return {
      credentials: this.secrets.decrypt(connection.userId, connection.provider, connection.credentialsEnc),
      saveCredentials: async (credentials) => {
        if (
          !(await this.repo.patchConnection(connection.userId, connection.provider, connection.version, {
            credentialsEnc: this.secrets.encrypt(connection.userId, connection.provider, credentials),
          }))
        )
          throw new ProviderFailure('connection_changed', 'Provider connection changed. Retry with the current connection.');
      },
      beforeWrite: () => Promise.reject(new ProviderFailure('read_only', 'This operation cannot modify remote reading data.')),
    };
  }
  private publicFailure(error: unknown): never {
    throw new BadRequestException(
      error instanceof ProviderFailure
        ? { message: error.message, errorCode: error.code, reconnectRequired: error.reconnect }
        : 'Provider request failed. Credentials and provider response bodies have not been logged.',
    );
  }
  async connect(userId: number, provider: ReadingProvider, input: ReadingProviderConnectPayload) {
    await this.user(userId, provider);
    // Reject before sending a password when secure persistence is not configured.
    if (!this.secrets.isConfigured()) throw new BadRequestException('Configure READING_PROVIDER_ENCRYPTION_KEY before connecting.');
    try {
      const credentials = await this.client(provider).connect(input);
      const existing = await this.repo.connection(userId, provider);
      if (existing?.accountId && existing.accountId !== credentials.accountId)
        throw new ProviderFailure('account_changed', 'Disconnect before connecting a different account.');
      await this.repo.replaceCredentials(userId, provider, this.secrets.encrypt(userId, provider, credentials), credentials.accountId);
      if (!existing?.accountId) await this.repo.resetAccount(userId, provider);
      return this.settings(userId, provider);
    } catch (error) {
      this.publicFailure(error);
    }
  }
  async validate(userId: number, provider: ReadingProvider) {
    await this.user(userId, provider);
    const connection = await this.repo.connection(userId, provider);
    if (!connection?.credentialsEnc) throw new BadRequestException('Connect this provider first.');
    try {
      await this.client(provider).validate(this.session(connection));
      await this.repo.patchConnection(userId, provider, connection.version, { reconnectRequired: false, error: null });
      return this.settings(userId, provider);
    } catch (error) {
      if (error instanceof ProviderFailure && error.reconnect)
        await this.repo.patchConnection(userId, provider, connection.version, { reconnectRequired: true, enabled: false, error: error.message });
      this.publicFailure(error);
    }
  }
  async setEnabled(userId: number, provider: ReadingProvider, enabled: boolean) {
    await this.user(userId, provider);
    const connection = await this.repo.connection(userId, provider);
    if (!connection?.credentialsEnc) throw new BadRequestException('Connect this provider first.');
    if (enabled) await this.validate(userId, provider);
    await this.repo.clearQueue(userId, provider);
    if (
      !(await this.repo.patchConnection(userId, provider, connection.version, {
        enabled,
        enabledAt: enabled ? new Date() : null,
        dateCursorAt: enabled ? new Date() : null,
        dateCursorBookId: 0,
        bulkActive: false,
        version: connection.version + 1,
      }))
    )
      throw new BadRequestException('Connection changed. Reload settings and try again.');
    return this.settings(userId, provider);
  }
  async disconnect(userId: number, provider: ReadingProvider) {
    await this.user(userId, provider);
    await this.repo.disconnect(userId, provider);
  }
  private async bookUser(userId: number, provider: ReadingProvider, bookId: number) {
    const user = await this.user(userId, provider);
    await this.books.verifyBookAccess(bookId, user);
    return user;
  }
  private bookView(
    provider: ReadingProvider,
    bookId: number,
    title: string | null,
    state: Awaited<ReturnType<ReadingProviderRepository['state']>>,
  ): ReadingProviderBook {
    return {
      bookId,
      title,
      excluded: state?.excluded ?? false,
      remoteId: state?.resourceId ?? null,
      remoteUrl: state?.resourceId
        ? provider === 'goodreads'
          ? `https://www.goodreads.com/book/show/${state.resourceId}`
          : `https://pagebound.co/books/${state.resourceId}`
        : null,
      matchMethod: state?.matchMethod ?? null,
      lastSyncedAt: state?.lastSyncedAt?.toISOString() ?? null,
      error: state?.error ?? null,
      warning: state?.warning ?? null,
      pending: Boolean(state?.dueAt),
    };
  }
  async bookState(userId: number, provider: ReadingProvider, bookId: number) {
    await this.bookUser(userId, provider, bookId);
    return this.bookView(provider, bookId, null, await this.repo.state(userId, provider, bookId));
  }
  async listBooks(userId: number, provider: ReadingProvider, afterBookId: number) {
    const user = await this.user(userId, provider);
    const rows = await this.repo.listBooks(userId, provider, await this.access(user), afterBookId);
    return rows.map((row) => this.bookView(provider, row.state.bookId, row.title, row.state));
  }
  async exclude(userId: number, provider: ReadingProvider, bookId: number, excluded: boolean) {
    await this.bookUser(userId, provider, bookId);
    await this.repo.saveBook(userId, provider, bookId, {
      excluded,
      dueAt: null,
      revision: ((await this.repo.state(userId, provider, bookId))?.revision ?? 0) + 1,
    });
    return this.bookState(userId, provider, bookId);
  }
  async candidates(userId: number, provider: ReadingProvider, bookId: number, query: string) {
    await this.bookUser(userId, provider, bookId);
    const connection = await this.repo.connection(userId, provider);
    if (!connection) throw new NotFoundException('Provider is not connected.');
    try {
      return await this.client(provider).search(this.session(connection), query);
    } catch (error) {
      this.publicFailure(error);
    }
  }
  async link(userId: number, provider: ReadingProvider, bookId: number, resourceId: string) {
    await this.bookUser(userId, provider, bookId);
    const connection = await this.repo.connection(userId, provider);
    if (!connection) throw new NotFoundException('Provider is not connected.');
    try {
      const candidate = await this.client(provider).getBook(this.session(connection), resourceId);
      await this.repo.saveBook(userId, provider, bookId, {
        remoteId: candidate.id,
        resourceId: candidate.resourceId,
        matchMethod: 'manual',
        lastLocal: null,
        lastRemote: null,
        lastSyncedAt: null,
        lastRemoteReadId: null,
        uncertainWrite: false,
        error: null,
        warning: null,
        dueAt: null,
        revision: ((await this.repo.state(userId, provider, bookId))?.revision ?? 0) + 1,
      });
      return this.bookState(userId, provider, bookId);
    } catch (error) {
      this.publicFailure(error);
    }
  }
  async queueBook(userId: number, provider: ReadingProvider, bookId: number) {
    const user = await this.bookUser(userId, provider, bookId);
    const connection = await this.repo.connection(userId, provider);
    if (!connection?.enabled || connection.reconnectRequired) throw new BadRequestException('Enable and validate this provider before syncing.');
    if ((await this.repo.state(userId, provider, bookId))?.excluded) throw new BadRequestException('This book is excluded from synchronization.');
    try {
      await this.repo.loadBook(userId, provider, bookId, await this.access(user));
    } catch (error) {
      this.publicFailure(error);
    }
    await this.repo.enqueue(userId, provider, bookId, 0, connection.version);
    return this.bookState(userId, provider, bookId);
  }
  async bulk(userId: number, provider: ReadingProvider, enabled: boolean) {
    await this.user(userId, provider);
    const connection = await this.repo.connection(userId, provider);
    if (!connection?.enabled || connection.reconnectRequired) throw new BadRequestException('Enable and validate this provider first.');
    await this.repo.patchConnection(userId, provider, connection.version, {
      bulkActive: enabled,
      bulkAfterBookId: 0,
      ...(!enabled ? { version: connection.version + 1 } : {}),
    });
    if (!enabled) await this.repo.clearQueue(userId, provider);
    return this.summary(userId, provider);
  }
  async summary(userId: number, provider: ReadingProvider) {
    const user = await this.user(userId, provider);
    const summary = await this.repo.summary(userId, provider, await this.access(user));
    return { ...summary, bulkActive: (await this.repo.connection(userId, provider))?.bulkActive ?? false };
  }
  async enqueueAutomatic(userId: number, bookId: number) {
    for (const provider of ['pagebound', 'goodreads'] as const) {
      const connection = await this.repo.connection(userId, provider);
      if (!connection?.enabled || connection.reconnectRequired) continue;
      if ((await this.repo.state(userId, provider, bookId))?.excluded) continue;
      await this.repo.enqueue(userId, provider, bookId, 3000, connection.version);
    }
  }
  async process(claim: ClaimedSync): Promise<void> {
    const { userId, provider } = claim.connection;
    const { bookId } = claim.book;
    const start = Date.now();
    this.logger.log(`[reading_provider.sync] [start] userId=${userId} provider=${provider} bookId=${bookId} - outbound sync started`);
    try {
      const user = await this.user(userId, provider);
      const access = await this.access(user);
      const local = await this.repo.loadBook(userId, provider, bookId, access);
      if (
        claim.book.lastLocal &&
        JSON.stringify(local.snapshot) === JSON.stringify(claim.book.lastLocal) &&
        !claim.book.error &&
        !claim.book.warning &&
        !claim.book.uncertainWrite
      ) {
        await this.repo.finish(claim, {}, null);
        this.logger.log(
          `[reading_provider.sync] [end] userId=${userId} provider=${provider} bookId=${bookId} durationMs=${Date.now() - start} skipped=true - reading state is unchanged`,
        );
        return;
      }
      const session = this.session(claim.connection);
      const client = this.client(provider);
      let candidate: ReadingProviderCandidate;
      if (claim.book.resourceId) candidate = await client.getBook(session, claim.book.resourceId);
      else {
        if (provider === 'goodreads' && local.goodreadsId) candidate = chooseMatch(local, [await client.getBook(session, local.goodreadsId)]);
        else {
          let matches: ReadingProviderCandidate[] = [];
          if (provider === 'goodreads' && (local.isbn13 || local.isbn10)) matches = await client.search(session, local.isbn13 ?? local.isbn10!);
          if (!matches.length) matches = await client.search(session, `${local.title} ${local.authors[0] ?? ''}`.trim());
          candidate = chooseMatch(local, matches);
        }
        await this.repo.saveBook(userId, provider, bookId, {
          remoteId: candidate.id,
          resourceId: candidate.resourceId,
          matchMethod: provider === 'goodreads' && local.goodreadsId ? 'metadata' : 'matched',
        });
      }
      session.beforeWrite = async () => {
        const current = await this.repo.connection(userId, provider);
        const state = await this.repo.state(userId, provider, bookId);
        if (
          !current?.enabled ||
          current.version !== claim.connection.version ||
          current.leaseToken !== claim.token ||
          !current.leaseUntil ||
          current.leaseUntil.getTime() <= Date.now() ||
          state?.excluded ||
          state?.resourceId !== candidate.resourceId
        )
          throw new ProviderFailure('sync_cancelled', 'Sync settings or book link changed. The queued write was cancelled.');
        const freshUser = await this.user(userId, provider);
        const fresh = await this.repo.loadBook(userId, provider, bookId, await this.access(freshUser));
        if (fresh.sourceVersion !== local.sourceVersion)
          throw new ProviderFailure('local_state_changed', 'Newer reading information arrived; the latest state will be synchronized.', true);
        await this.repo.saveBook(userId, provider, bookId, { uncertainWrite: true });
      };
      const remote = await client.read(session, candidate);
      if (
        claim.book.lastRemoteReadId &&
        remote.identity &&
        remote.identity !== claim.book.lastRemoteReadId &&
        !(
          local.snapshot.startedOn &&
          remote.startedOn &&
          local.snapshot.startedOn >= remote.startedOn &&
          claim.book.lastLocal?.startedOn &&
          local.snapshot.startedOn > claim.book.lastLocal.startedOn
        )
      )
        throw new ProviderFailure('read_changed', 'The remote reading instance changed. Check the current read and relink before syncing.');
      const { changes, warnings } = planSync(local.snapshot, remote, claim.book.lastLocal, claim.book.lastRemote, client.capabilities);
      let result = remote;
      if (Object.keys(changes).length) {
        await client.write(session, candidate, remote, changes);
        result = await client.read(session, candidate);
        for (const field of ['status', 'progress', 'rating', 'startedOn', 'finishedOn'] as const) {
          if (changes[field] === undefined) continue;
          if (field === 'progress' ? result.progress === null || result.progress < (changes.progress ?? 0) : result[field] !== changes[field])
            throw new ProviderFailure(
              'unconfirmed_write',
              'Provider did not confirm the requested update. Check its reading state before retrying.',
              false,
              false,
              true,
            );
        }
      }
      await this.repo.finish(
        claim,
        {
          lastLocal: local.snapshot,
          lastRemoteReadId: result.identity,
          lastRemote: {
            status: result.status,
            progress: result.progress,
            rating: result.rating,
            startedOn: result.startedOn,
            finishedOn: result.finishedOn,
          },
          lastSyncedAt: new Date(),
          error: null,
          warning: warnings.join(' ') || null,
          attempts: 0,
          uncertainWrite: false,
        },
        null,
      );
      await this.repo.patchConnection(userId, provider, claim.connection.version, { lastSyncedAt: new Date(), error: null });
      this.logger.log(
        `[reading_provider.sync] [end] userId=${userId} provider=${provider} bookId=${bookId} durationMs=${Date.now() - start} - outbound sync completed`,
      );
    } catch (error) {
      const failure =
        error instanceof ProviderFailure
          ? error
          : new ProviderFailure(
              'sync_failed',
              error instanceof ForbiddenException
                ? 'User no longer has access to sync this book.'
                : 'Synchronization failed. Check the connection and retry.',
            );
      const attempts = claim.book.attempts + 1;
      if (failure.reconnect)
        await this.repo.patchConnection(userId, provider, claim.connection.version, {
          enabled: false,
          reconnectRequired: true,
          error: failure.message,
          bulkActive: false,
        });
      const retry = failure.retryable && attempts < 6 ? Math.min(300_000, 5000 * 2 ** (attempts - 1)) : null;
      await this.repo.finish(claim, { error: failure.message, attempts, uncertainWrite: failure.uncertain || claim.book.uncertainWrite }, retry);
      this.logger.warn(
        `[reading_provider.sync] [fail] userId=${userId} provider=${provider} bookId=${bookId} durationMs=${Date.now() - start} errorClass=${failure.code} - outbound sync stopped`,
      );
    }
  }
}
