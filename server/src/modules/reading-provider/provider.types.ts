import type { ProviderReadingSnapshot, ReadingProviderCapabilities, ReadingProviderCandidate } from '@bookorbit/types';

export interface ProviderCredentials {
  accountId: string;
  cookies?: string;
  csrf?: string;
  apiToken?: string;
  refreshToken?: string;
  expiresAt?: number;
}
export interface ProviderBookInput {
  bookId: number;
  title: string;
  authors: string[];
  isbn13: string | null;
  isbn10: string | null;
  goodreadsId: string | null;
  snapshot: ProviderReadingSnapshot;
  sourceVersion: string;
}
export interface ProviderRemoteState extends ProviderReadingSnapshot {
  exists: boolean;
  progressKnown: boolean;
  ratingKnown: boolean;
  datesKnown: boolean;
  identity: string | null;
  raw: Record<string, unknown>;
}
export interface ProviderSession {
  credentials: ProviderCredentials;
  saveCredentials: (credentials: ProviderCredentials) => Promise<void>;
  beforeWrite: () => Promise<void>;
}
export interface ReadingProviderClient {
  capabilities: ReadingProviderCapabilities;
  connect(input: { email?: string; password?: string; cookies?: string }): Promise<ProviderCredentials>;
  validate(session: ProviderSession): Promise<void>;
  search(session: ProviderSession, query: string): Promise<ReadingProviderCandidate[]>;
  getBook(session: ProviderSession, resourceId: string): Promise<ReadingProviderCandidate>;
  read(session: ProviderSession, book: ReadingProviderCandidate): Promise<ProviderRemoteState>;
  write(
    session: ProviderSession,
    book: ReadingProviderCandidate,
    remote: ProviderRemoteState,
    changes: Partial<ProviderReadingSnapshot>,
  ): Promise<void>;
}
export class ProviderFailure extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly retryable = false,
    public readonly reconnect = false,
    public readonly uncertain = false,
  ) {
    super(message);
    this.name = 'ProviderFailure';
  }
}
