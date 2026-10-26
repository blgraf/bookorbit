export const READING_PROVIDERS = ["pagebound", "goodreads"] as const;
export type ReadingProvider = (typeof READING_PROVIDERS)[number];
export type ProviderReadStatus = "to_read" | "reading" | "read" | "paused" | "dnf";
export interface ProviderReadingSnapshot {
  status: ProviderReadStatus;
  progress: number | null;
  rating: number | null;
  startedOn: string | null;
  finishedOn: string | null;
}
export interface ReadingProviderCapabilities {
  progress: boolean;
  ratings: boolean;
  readingDates: boolean;
  limitations: string[];
}
export interface ReadingProviderSettings {
  provider: ReadingProvider;
  connected: boolean;
  enabled: boolean;
  reconnectRequired: boolean;
  encryptionConfigured: boolean;
  accountId: string | null;
  lastSyncedAt: string | null;
  error: string | null;
  capabilities: ReadingProviderCapabilities;
}
export interface ReadingProviderConnectPayload {
  email?: string;
  password?: string;
  cookies?: string;
}
export interface ReadingProviderBook {
  bookId: number;
  title: string | null;
  excluded: boolean;
  remoteId: string | null;
  remoteUrl: string | null;
  matchMethod: string | null;
  lastSyncedAt: string | null;
  error: string | null;
  warning: string | null;
  pending: boolean;
}
export interface ReadingProviderCandidate {
  id: string;
  resourceId: string;
  title: string;
  authors: string[];
  isbn: string | null;
  pages: number | null;
  url: string;
}
export interface ReadingProviderSummary {
  pending: number;
  failed: number;
  synced: number;
  bulkActive: boolean;
}
