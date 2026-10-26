import type { ProviderReadStatus, ProviderReadingSnapshot, ReadingProviderCapabilities, ReadingProviderCandidate } from '@bookorbit/types';
import { ProviderFailure, type ProviderBookInput, type ProviderRemoteState } from './provider.types';

export function mapReadStatus(status: string, provider: 'pagebound' | 'goodreads'): ProviderReadStatus | null {
  const common: Record<string, ProviderReadStatus> = { want_to_read: 'to_read', reading: 'reading', rereading: 'reading', read: 'read' };
  if (common[status]) return common[status];
  if (provider === 'pagebound') return ({ on_hold: 'paused', abandoned: 'dnf' } as Record<string, ProviderReadStatus>)[status] ?? null;
  return null;
}
export function normalized(value: string): string {
  return value
    .normalize('NFKC')
    .toLocaleLowerCase('en')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}
export function chooseMatch(book: ProviderBookInput, candidates: ReadingProviderCandidate[]): ReadingProviderCandidate {
  const isbn = new Set([book.isbn13, book.isbn10].filter(Boolean));
  const exact = candidates.filter((candidate) => candidate.isbn && isbn.has(candidate.isbn.replace(/[-\s]/g, '')));
  const matches = exact.length
    ? exact
    : candidates.filter(
        (candidate) =>
          !(isbn.size && candidate.isbn && !isbn.has(candidate.isbn.replace(/[-\s]/g, ''))) &&
          normalized(candidate.title) === normalized(book.title) &&
          book.authors.some((author) => candidate.authors.some((remote) => normalized(author) === normalized(remote))),
      );
  const unique = [...new Map(matches.map((candidate) => [candidate.resourceId, candidate])).values()];
  if (unique.length !== 1)
    throw new ProviderFailure(
      unique.length ? 'ambiguous_match' : 'no_match',
      'No unique edition match. Select and link the correct provider edition manually.',
    );
  return unique[0]!;
}
export function planSync(
  local: ProviderReadingSnapshot,
  remote: ProviderRemoteState,
  lastLocal: ProviderReadingSnapshot | null,
  lastRemote: ProviderReadingSnapshot | null,
  capabilities: ReadingProviderCapabilities,
) {
  const changes: Partial<ProviderReadingSnapshot> = {};
  const warnings: string[] = [];
  if (remote.exists && remote.startedOn && local.startedOn && remote.startedOn > local.startedOn) {
    throw new ProviderFailure(
      'remote_newer_read',
      'The provider has a newer reading instance. BookOrbit progress was not applied to a different read.',
    );
  }
  if (remote.exists && remote.status === 'read' && local.status !== 'read') {
    throw new ProviderFailure(
      'remote_completed',
      'Remote book is already finished. Start a new read on the provider, then sync; existing reading history was preserved.',
    );
  }
  if (remote.status !== local.status || !remote.exists) {
    const advance = local.status === 'read' || (local.status === 'reading' && remote.status === 'to_read');
    const changedSinceBaseline = lastLocal && lastRemote && lastLocal.status !== local.status && lastRemote.status === remote.status;
    if (!remote.exists || advance || changedSinceBaseline) changes.status = local.status;
    else warnings.push('Remote status differs without a trusted change baseline; status was preserved.');
  }
  if (local.progress !== null && local.progress > 0) {
    if (!capabilities.progress || (remote.exists && !remote.progressKnown))
      warnings.push('Remote progress cannot be read reliably; progress was preserved.');
    else if ((remote.progress ?? 0) < local.progress) changes.progress = Math.min(100, local.progress);
    else if ((remote.progress ?? 0) > local.progress) warnings.push('Remote progress is ahead of BookOrbit; it was preserved.');
  }
  if (local.rating !== null && local.rating !== remote.rating) {
    if (!capabilities.ratings || !remote.ratingKnown) warnings.push('Safe rating-only updates are unavailable; set this rating on the provider.');
    else if (remote.rating === null || (lastLocal && lastRemote && lastLocal.rating !== local.rating && lastRemote.rating === remote.rating))
      changes.rating = local.rating;
    else warnings.push('Remote rating differs without a trusted change baseline; rating was preserved.');
  }
  for (const field of ['startedOn', 'finishedOn'] as const) {
    if (!local[field] || local[field] === remote[field]) continue;
    if (!capabilities.readingDates || !remote.datesKnown) warnings.push('Reading dates could not be checked safely; remote history was preserved.');
    else if (!remote[field]) changes[field] = local[field];
    else warnings.push('Existing remote reading dates were preserved.');
  }
  return { changes, warnings: [...new Set(warnings)] };
}
export function progressPage(percent: number, remotePages: number | null): number | null {
  return remotePages && remotePages > 0 ? Math.min(remotePages, Math.floor((Math.max(0, Math.min(100, percent)) * remotePages) / 100)) : null;
}
