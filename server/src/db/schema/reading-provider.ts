import { sql } from 'drizzle-orm';
import { boolean, check, index, integer, jsonb, pgTable, primaryKey, text, timestamp, uuid, varchar } from 'drizzle-orm/pg-core';
import type { ProviderReadingSnapshot, ReadingProvider } from '@bookorbit/types';
import { users } from './auth';
import { books } from './books';

export const readingProviderConnections = pgTable(
  'reading_provider_connections',
  {
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    provider: varchar('provider', { length: 20 }).$type<ReadingProvider>().notNull(),
    credentialsEnc: text('credentials_enc'),
    accountId: varchar('account_id', { length: 255 }),
    enabled: boolean('enabled').notNull().default(false),
    reconnectRequired: boolean('reconnect_required').notNull().default(false),
    version: integer('version').notNull().default(1),
    dateCursorAt: timestamp('date_cursor_at', { withTimezone: true }),
    dateCursorBookId: integer('date_cursor_book_id').notNull().default(0),
    enabledAt: timestamp('enabled_at', { withTimezone: true }),
    lastSyncedAt: timestamp('last_synced_at', { withTimezone: true }),
    error: text('error'),
    leaseToken: uuid('lease_token'),
    leaseUntil: timestamp('lease_until', { withTimezone: true }),
    bulkActive: boolean('bulk_active').notNull().default(false),
    bulkAfterBookId: integer('bulk_after_book_id').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.provider] }),
    check('reading_provider_connection_provider_chk', sql`${t.provider} in ('goodreads', 'pagebound')`),
  ],
);

export const readingProviderBooks = pgTable(
  'reading_provider_books',
  {
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    provider: varchar('provider', { length: 20 }).$type<ReadingProvider>().notNull(),
    bookId: integer('book_id')
      .notNull()
      .references(() => books.id, { onDelete: 'cascade' }),
    excluded: boolean('excluded').notNull().default(false),
    remoteId: varchar('remote_id', { length: 255 }),
    resourceId: varchar('resource_id', { length: 255 }),
    matchMethod: varchar('match_method', { length: 20 }),
    lastLocal: jsonb('last_local').$type<ProviderReadingSnapshot>(),
    lastRemote: jsonb('last_remote').$type<ProviderReadingSnapshot>(),
    lastSyncedAt: timestamp('last_synced_at', { withTimezone: true }),
    error: text('error'),
    warning: text('warning'),
    dueAt: timestamp('due_at', { withTimezone: true }),
    connectionVersion: integer('connection_version').notNull().default(1),
    lastRemoteReadId: varchar('last_remote_read_id', { length: 255 }),
    attempts: integer('attempts').notNull().default(0),
    revision: integer('revision').notNull().default(0),
    uncertainWrite: boolean('uncertain_write').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.provider, t.bookId] }),
    index('reading_provider_books_book_idx').on(t.bookId),
    index('reading_provider_books_due_idx')
      .on(t.dueAt, t.userId, t.provider)
      .where(sql`${t.dueAt} is not null`),
    check('reading_provider_book_provider_chk', sql`${t.provider} in ('goodreads', 'pagebound')`),
  ],
);
