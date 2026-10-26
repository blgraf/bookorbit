import { Inject, Injectable } from '@nestjs/common';
import type { ContentFilterRules, ProviderReadingSnapshot, ReadingProvider } from '@bookorbit/types';
import { and, asc, desc, eq, gt, inArray, isNotNull, isNull, lte, ne, or, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { randomUUID } from 'node:crypto';
import { DB } from '../../db';
import * as schema from '../../db/schema';
import { buildContentFilterClauses } from '../../common/utils/content-filter-sql.utils';
import { mapReadStatus } from './provider-policy';
import { ProviderFailure, type ProviderBookInput } from './provider.types';

type Connection = typeof schema.readingProviderConnections.$inferSelect;
type BookState = typeof schema.readingProviderBooks.$inferSelect;
type ConnectionPatch = Partial<typeof schema.readingProviderConnections.$inferInsert>;
type BookPatch = Partial<typeof schema.readingProviderBooks.$inferInsert>;
export interface ProviderAccess {
  libraryIds: number[];
  contentFilters?: ContentFilterRules;
}
export interface ClaimedSync {
  connection: Connection;
  book: BookState;
  token: string;
}
const c = schema.readingProviderConnections;
const b = schema.readingProviderBooks;
function day(value: string | Date | null): string | null {
  return value ? (value instanceof Date ? value.toISOString() : value).slice(0, 10) : null;
}

@Injectable()
export class ReadingProviderRepository {
  constructor(@Inject(DB) private readonly db: NodePgDatabase<typeof schema>) {}
  connection(userId: number, provider: ReadingProvider) {
    return this.db.query.readingProviderConnections.findFirst({ where: and(eq(c.userId, userId), eq(c.provider, provider)) });
  }
  async saveConnection(userId: number, provider: ReadingProvider, patch: ConnectionPatch) {
    const [row] = await this.db
      .insert(c)
      .values({ userId, provider, ...patch })
      .onConflictDoUpdate({ target: [c.userId, c.provider], set: { ...patch, updatedAt: new Date() } })
      .returning();
    return row!;
  }
  async patchConnection(userId: number, provider: ReadingProvider, version: number, patch: ConnectionPatch): Promise<boolean> {
    const rows = await this.db
      .update(c)
      .set({ ...patch, updatedAt: new Date() })
      .where(and(eq(c.userId, userId), eq(c.provider, provider), eq(c.version, version)))
      .returning({ userId: c.userId });
    return rows.length === 1;
  }
  async replaceCredentials(userId: number, provider: ReadingProvider, credentialsEnc: string, accountId: string) {
    await this.db
      .insert(c)
      .values({ userId, provider, credentialsEnc, accountId })
      .onConflictDoUpdate({
        target: [c.userId, c.provider],
        set: { credentialsEnc, accountId, enabled: false, reconnectRequired: false, error: null, bulkActive: false, version: sql`${c.version} + 1` },
      });
    await this.clearQueue(userId, provider);
  }
  async clearQueue(userId: number, provider: ReadingProvider) {
    await this.db
      .update(b)
      .set({ dueAt: null })
      .where(and(eq(b.userId, userId), eq(b.provider, provider)));
  }
  async resetAccount(userId: number, provider: ReadingProvider) {
    await this.db
      .update(b)
      .set({
        remoteId: null,
        resourceId: null,
        lastLocal: null,
        lastRemote: null,
        lastSyncedAt: null,
        lastRemoteReadId: null,
        error: null,
        warning: null,
        uncertainWrite: false,
        dueAt: null,
      })
      .where(and(eq(b.userId, userId), eq(b.provider, provider)));
  }
  async disconnect(userId: number, provider: ReadingProvider) {
    await this.db.transaction(async (tx) => {
      await tx
        .update(c)
        .set({
          credentialsEnc: null,
          accountId: null,
          enabled: false,
          reconnectRequired: false,
          error: null,
          bulkActive: false,
          version: sql`${c.version} + 1`,
        })
        .where(and(eq(c.userId, userId), eq(c.provider, provider)));
      await tx
        .update(b)
        .set({ dueAt: null, error: null })
        .where(and(eq(b.userId, userId), eq(b.provider, provider)));
    });
  }
  state(userId: number, provider: ReadingProvider, bookId: number) {
    return this.db.query.readingProviderBooks.findFirst({ where: and(eq(b.userId, userId), eq(b.provider, provider), eq(b.bookId, bookId)) });
  }
  async saveBook(userId: number, provider: ReadingProvider, bookId: number, patch: BookPatch) {
    const [row] = await this.db
      .insert(b)
      .values({ userId, provider, bookId, ...patch })
      .onConflictDoUpdate({ target: [b.userId, b.provider, b.bookId], set: { ...patch, updatedAt: new Date() } })
      .returning();
    return row!;
  }
  async enqueue(userId: number, provider: ReadingProvider, bookId: number, delayMs = 3000, expectedVersion?: number) {
    await this.db.transaction(async (tx) => {
      const [connection] = await tx
        .select({ version: c.version, enabled: c.enabled, reconnectRequired: c.reconnectRequired })
        .from(c)
        .where(and(eq(c.userId, userId), eq(c.provider, provider)))
        .for('update');
      if (!connection?.enabled || connection.reconnectRequired || (expectedVersion !== undefined && connection.version !== expectedVersion)) return;
      await tx
        .insert(b)
        .values({ userId, provider, bookId, dueAt: new Date(Date.now() + delayMs), revision: 1, connectionVersion: connection.version })
        .onConflictDoUpdate({
          target: [b.userId, b.provider, b.bookId],
          set: {
            dueAt: new Date(Date.now() + delayMs),
            connectionVersion: connection.version,
            revision: sql`${b.revision} + 1`,
            attempts: 0,
            error: null,
          },
        });
    });
  }
  private scope(access: ProviderAccess) {
    return [
      inArray(schema.books.libraryId, access.libraryIds),
      ...(access.contentFilters ? buildContentFilterClauses(access.contentFilters, this.db) : []),
    ];
  }
  async loadBook(userId: number, provider: ReadingProvider, bookId: number, access: ProviderAccess): Promise<ProviderBookInput> {
    const [row] = await this.db
      .select({
        title: schema.bookMetadata.title,
        isbn13: schema.bookMetadata.isbn13,
        isbn10: schema.bookMetadata.isbn10,
        goodreadsId: schema.bookMetadata.goodreadsId,
        status: schema.userBookStatus.status,
        startedAt: schema.userBookStatus.startedAt,
        finishedAt: schema.userBookStatus.finishedAt,
        statusUpdatedAt: schema.userBookStatus.updatedAt,
        rating: schema.userBookRatings.rating,
        ratingUpdatedAt: schema.userBookRatings.updatedAt,
      })
      .from(schema.books)
      .leftJoin(schema.bookMetadata, eq(schema.bookMetadata.bookId, schema.books.id))
      .leftJoin(schema.userBookStatus, and(eq(schema.userBookStatus.userId, userId), eq(schema.userBookStatus.bookId, schema.books.id)))
      .leftJoin(schema.userBookRatings, and(eq(schema.userBookRatings.userId, userId), eq(schema.userBookRatings.bookId, schema.books.id)))
      .where(and(eq(schema.books.id, bookId), ...this.scope(access)))
      .limit(1);
    if (!row) throw new ProviderFailure('access_denied', 'Book is no longer accessible to this user.');
    const status = mapReadStatus(row.status ?? 'unread', provider);
    if (!status) throw new ProviderFailure('unsupported_status', 'This reading status is not supported by the provider. Remote state was preserved.');
    const authors = await this.db
      .select({ name: schema.authors.name })
      .from(schema.bookAuthors)
      .innerJoin(schema.authors, eq(schema.authors.id, schema.bookAuthors.authorId))
      .where(eq(schema.bookAuthors.bookId, bookId))
      .limit(20);
    const [progress] = await this.db
      .select({ percentage: schema.readingProgress.percentage, lastReadAt: schema.readingProgress.lastReadAt })
      .from(schema.readingProgress)
      .innerJoin(schema.bookFiles, eq(schema.bookFiles.id, schema.readingProgress.bookFileId))
      .where(and(eq(schema.readingProgress.userId, userId), eq(schema.bookFiles.bookId, bookId)))
      .orderBy(desc(schema.readingProgress.lastReadAt))
      .limit(1);
    const [attempt] = await this.db
      .select({
        id: schema.readingAttempts.id,
        createdAt: schema.readingAttempts.createdAt,
        outcome: schema.readingAttempts.outcome,
        updatedAt: schema.readingAttempts.updatedAt,
      })
      .from(schema.readingAttempts)
      .where(and(eq(schema.readingAttempts.userId, userId), eq(schema.readingAttempts.bookId, bookId), isNull(schema.readingAttempts.deletedAt)))
      .orderBy(desc(sql`${schema.readingAttempts.outcome} is null`), desc(schema.readingAttempts.id))
      .limit(1);
    const startedOn = day(row.startedAt);
    const startThreshold = Math.max(
      row.startedAt ? new Date(row.startedAt).getTime() : 0,
      row.status === 'rereading' ? (attempt?.outcome === null ? attempt.createdAt.getTime() : Number.POSITIVE_INFINITY) : 0,
    );
    const progressIsCurrent = Boolean(progress?.lastReadAt && progress.lastReadAt.getTime() >= startThreshold);
    const snapshot: ProviderReadingSnapshot = {
      status,
      progress: status === 'read' ? 100 : progressIsCurrent ? (progress?.percentage ?? null) : null,
      rating: row.rating,
      startedOn,
      finishedOn: status === 'read' ? day(row.finishedAt) : null,
    };
    return {
      bookId,
      title: row.title ?? '',
      authors: authors.map((author) => author.name),
      isbn13: row.isbn13,
      isbn10: row.isbn10,
      goodreadsId: row.goodreadsId,
      snapshot,
      sourceVersion: JSON.stringify([snapshot, row.statusUpdatedAt, row.ratingUpdatedAt, progress?.lastReadAt, attempt?.id, attempt?.updatedAt]),
    };
  }
  async accessibleBooks(userId: number, access: ProviderAccess, afterBookId: number, limit = 50) {
    return this.db
      .select({ bookId: schema.books.id, title: schema.bookMetadata.title })
      .from(schema.books)
      .innerJoin(schema.userBookStatus, and(eq(schema.userBookStatus.bookId, schema.books.id), eq(schema.userBookStatus.userId, userId)))
      .leftJoin(schema.bookMetadata, eq(schema.bookMetadata.bookId, schema.books.id))
      .where(and(...this.scope(access), gt(schema.books.id, afterBookId), ne(schema.userBookStatus.status, 'unread')))
      .orderBy(asc(schema.books.id))
      .limit(limit);
  }
  async listBooks(userId: number, provider: ReadingProvider, access: ProviderAccess, afterBookId: number) {
    return this.db
      .select({ state: b, title: schema.bookMetadata.title })
      .from(b)
      .innerJoin(schema.books, eq(schema.books.id, b.bookId))
      .leftJoin(schema.bookMetadata, eq(schema.bookMetadata.bookId, b.bookId))
      .where(and(eq(b.userId, userId), eq(b.provider, provider), gt(b.bookId, afterBookId), ...this.scope(access)))
      .orderBy(asc(b.bookId))
      .limit(50);
  }
  async summary(userId: number, provider: ReadingProvider, access: ProviderAccess) {
    const [row] = await this.db
      .select({
        pending: sql<number>`count(*) filter (where ${b.dueAt} is not null)::int`,
        failed: sql<number>`count(*) filter (where ${b.error} is not null)::int`,
        synced: sql<number>`count(*) filter (where ${b.lastSyncedAt} is not null)::int`,
      })
      .from(b)
      .innerJoin(schema.books, eq(schema.books.id, b.bookId))
      .where(and(eq(b.userId, userId), eq(b.provider, provider), ...this.scope(access)));
    return row ?? { pending: 0, failed: 0, synced: 0 };
  }
  async connections(afterUserId = 0, limit = 25) {
    return this.db
      .select()
      .from(c)
      .where(and(eq(c.enabled, true), eq(c.reconnectRequired, false), gt(c.userId, afterUserId)))
      .orderBy(asc(c.userId), asc(c.provider))
      .limit(limit);
  }
  async changedDates(connection: Connection) {
    const s = schema.userBookStatus;
    const cursor = connection.dateCursorAt ?? connection.enabledAt ?? connection.createdAt;
    return this.db
      .select({ bookId: s.bookId, updatedAt: s.updatedAt })
      .from(s)
      .where(
        and(eq(s.userId, connection.userId), or(gt(s.updatedAt, cursor), and(eq(s.updatedAt, cursor), gt(s.bookId, connection.dateCursorBookId)))),
      )
      .orderBy(asc(s.updatedAt), asc(s.bookId))
      .limit(50);
  }
  async bookIdForFile(bookFileId: number) {
    const [row] = await this.db
      .select({ bookId: schema.bookFiles.bookId })
      .from(schema.bookFiles)
      .where(eq(schema.bookFiles.id, bookFileId))
      .limit(1);
    return row?.bookId;
  }
  async claim(): Promise<ClaimedSync | null> {
    return this.db.transaction(async (tx) => {
      const now = new Date();
      const [row] = await tx
        .select({ connection: c, book: b })
        .from(c)
        .innerJoin(b, and(eq(b.userId, c.userId), eq(b.provider, c.provider), eq(b.connectionVersion, c.version)))
        .where(
          and(
            eq(c.enabled, true),
            eq(c.reconnectRequired, false),
            isNotNull(c.credentialsEnc),
            eq(b.excluded, false),
            lte(b.dueAt, now),
            or(isNull(c.leaseUntil), lte(c.leaseUntil, now)),
          ),
        )
        .orderBy(asc(b.dueAt))
        .limit(1)
        .for('update', { skipLocked: true });
      if (!row) return null;
      const token = randomUUID();
      await tx
        .update(c)
        .set({ leaseToken: token, leaseUntil: new Date(Date.now() + 600_000) })
        .where(and(eq(c.userId, row.connection.userId), eq(c.provider, row.connection.provider)));
      return { ...row, token };
    });
  }
  async finish(claim: ClaimedSync, patch: BookPatch, retryMs: number | null) {
    await this.db.transaction(async (tx) => {
      const own = and(eq(c.userId, claim.connection.userId), eq(c.provider, claim.connection.provider), eq(c.leaseToken, claim.token));
      const [connection] = await tx.select({ version: c.version }).from(c).where(own).for('update');
      if (!connection) return;
      if (connection.version === claim.connection.version) {
        const owner = and(eq(b.userId, claim.book.userId), eq(b.provider, claim.book.provider), eq(b.bookId, claim.book.bookId));
        const [current] = await tx.select({ revision: b.revision, excluded: b.excluded, dueAt: b.dueAt }).from(b).where(owner).for('update');
        if (current) {
          const revised = current.revision !== claim.book.revision;
          const dueAt =
            current.excluded || (revised && !current.dueAt)
              ? null
              : revised
                ? new Date(Date.now() + 3000)
                : retryMs === null
                  ? null
                  : new Date(Date.now() + retryMs);
          await tx
            .update(b)
            .set({ ...(revised ? {} : patch), dueAt, updatedAt: new Date() })
            .where(owner);
        }
      }
      await tx
        .update(c)
        .set({ leaseToken: null, leaseUntil: new Date(Date.now() + 750) })
        .where(own);
    });
  }
}
