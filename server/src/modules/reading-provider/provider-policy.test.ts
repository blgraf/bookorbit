import { chooseMatch, mapReadStatus, planSync, progressPage } from './provider-policy';
import type { ProviderBookInput, ProviderRemoteState } from './provider.types';
import type { ProviderReadingSnapshot, ReadingProviderCapabilities } from '@bookorbit/types';
const local: ProviderReadingSnapshot = { status: 'reading', progress: 50, rating: 4, startedOn: '2026-10-01', finishedOn: null };
const remote: ProviderRemoteState = {
  ...local,
  progress: 10,
  rating: null,
  startedOn: null,
  exists: true,
  progressKnown: true,
  ratingKnown: true,
  datesKnown: true,
  identity: 'read-1',
  raw: {},
};
const capabilities: ReadingProviderCapabilities = { progress: true, ratings: true, readingDates: true, limitations: [] };
const book: ProviderBookInput = {
  bookId: 1,
  title: 'A Book',
  authors: ['An Author'],
  isbn13: '9781234567890',
  isbn10: null,
  goodreadsId: null,
  snapshot: local,
  sourceVersion: '1',
};
const candidate = {
  id: '1',
  resourceId: 'edition-1',
  title: 'A Book',
  authors: ['An Author'],
  isbn: null,
  pages: 300,
  url: 'https://pagebound.co/books/edition-1',
};
describe('reading provider safety policy', () => {
  it.each(['unread', 'skimmed', 'unknown', 'abandoned', 'on_hold'])('does not invent Goodreads status for %s', (status) => {
    expect(mapReadStatus(status, 'goodreads')).toBeNull();
  });
  it.each([
    ['want_to_read', 'to_read'],
    ['reading', 'reading'],
    ['rereading', 'reading'],
    ['read', 'read'],
    ['on_hold', 'paused'],
    ['abandoned', 'dnf'],
  ])('maps Pagebound %s explicitly', (status, expected) => {
    expect(mapReadStatus(status!, 'pagebound')).toBe(expected);
  });
  it('never overwrites a completed remote read with an older in-progress read', () => {
    expect(() => planSync(local, { ...remote, status: 'read', progress: 100 }, null, null, capabilities)).toThrow('already finished');
  });
  it('does not send an old reading attempt to a newer remote instance', () => {
    expect(() => planSync(local, { ...remote, startedOn: '2026-10-20' }, null, null, capabilities)).toThrow('newer reading instance');
  });
  it('never regresses remote progress', () => {
    const result = planSync(local, { ...remote, progress: 90 }, null, null, capabilities);
    expect(result.changes.progress).toBeUndefined();
    expect(result.warnings.join()).toContain('ahead');
  });
  it('fails closed for unreadable progress', () => {
    expect(planSync(local, { ...remote, progress: null, progressKnown: false }, null, null, capabilities).changes.progress).toBeUndefined();
  });
  it('only advances progress and fills missing dates', () => {
    expect(planSync(local, remote, null, null, capabilities).changes).toEqual({ progress: 50, rating: 4, startedOn: '2026-10-01' });
  });
  it('deduplicates equal remote values', () => {
    expect(planSync(local, { ...remote, ...local }, local, local, capabilities).changes).toEqual({});
  });
  it('preserves a pre-existing remote rating without a trusted baseline', () => {
    expect(planSync(local, { ...remote, rating: 5 }, null, null, capabilities).changes.rating).toBeUndefined();
  });
  it('allows a new local rating only if remote rating still matches the saved baseline', () => {
    const previous = { ...local, rating: 3 };
    expect(planSync(local, { ...remote, rating: 3 }, previous, previous, capabilities).changes.rating).toBe(4);
    expect(planSync(local, { ...remote, rating: 5 }, previous, previous, capabilities).changes.rating).toBeUndefined();
  });
  it('does not clear remote ratings or existing dates', () => {
    const result = planSync({ ...local, rating: null }, { ...remote, rating: 5, startedOn: '2026-09-01' }, local, local, capabilities);
    expect(result.changes.rating).toBeUndefined();
    expect(result.changes.startedOn).toBeUndefined();
  });
  it('does not publish Pagebound reviews in order to sync ratings', () => {
    expect(planSync(local, remote, null, null, { ...capabilities, ratings: false }).changes.rating).toBeUndefined();
  });
  it('protects non-monotonic status changes until a local change has a baseline', () => {
    const paused = { ...local, status: 'paused' as const };
    expect(planSync(paused, remote, null, null, capabilities).changes.status).toBeUndefined();
    expect(planSync(paused, remote, local, local, capabilities).changes.status).toBe('paused');
  });
  it('refuses ambiguous matches even if titles and authors match', () => {
    expect(() => chooseMatch(book, [candidate, { ...candidate, resourceId: 'edition-2' }])).toThrow('unique edition');
  });
  it('rejects a clearly different ISBN instead of silently choosing the wrong edition', () => {
    expect(() => chooseMatch(book, [{ ...candidate, isbn: '9780000000000' }])).toThrow('unique edition');
  });
  it('matches exact ISBN before title and author fallbacks', () => {
    expect(chooseMatch(book, [{ ...candidate, title: 'A Different Translated Title', isbn: book.isbn13 }]).id).toBe('1');
  });
  it('requires an author for title matching and supports missing ISBNs', () => {
    expect(chooseMatch({ ...book, isbn13: null }, [candidate])).toEqual(candidate);
    expect(() => chooseMatch({ ...book, authors: [] }, [candidate])).toThrow('unique edition');
  });
  it.each([
    [50, 300, 150],
    [33.3, 200, 66],
    [110, 400, 400],
    [-10, 400, 0],
    [50, null, null],
  ])('converts percentage using the remote edition page count', (percent, pages, expected) => {
    expect(progressPage(percent!, pages)).toBe(expected);
  });
});
