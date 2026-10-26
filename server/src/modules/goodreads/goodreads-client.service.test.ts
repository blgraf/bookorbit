import { GoodreadsClientService } from './goodreads-client.service';
import { ProviderHttpService } from '../reading-provider/provider-http.service';
import type { ProviderSession } from '../reading-provider/provider.types';
import { apolloBook, flightText, flightValue } from './goodreads-parser';
const candidate = {
  id: '42',
  resourceId: '42',
  title: 'A Book',
  authors: ['Author'],
  isbn: null,
  pages: 300,
  url: 'https://www.goodreads.com/book/show/42',
};
function html(shelving: unknown = null) {
  return `<script type="application/json">${JSON.stringify({ props: { cache: { ROOT_QUERY: { 'getBookByLegacyId({"legacyId":"42"})': { __ref: 'Book:42' } }, 'Book:42': { id: 'kca://book/42', viewerShelving: shelving }, 'Shelving:42': { shelf: { name: 'currently-reading' }, review: { rating: 3 } } } } })}</script>`;
}
function fixture() {
  const request = vi.fn().mockResolvedValue({ body: html(), status: 200, headers: new Headers(), url: 'https://www.goodreads.com/book/show/42' });
  const client = new GoodreadsClientService({ request } as unknown as ProviderHttpService);
  const session: ProviderSession = {
    credentials: { accountId: '7', cookies: 'test=session', csrf: 'test-csrf' },
    saveCredentials: vi.fn(),
    beforeWrite: vi.fn(),
  };
  return { request, client, session };
}
describe('Goodreads session client', () => {
  it('validates a browser cookie session without modifying any reading state', async () => {
    const { client, request } = fixture();
    request.mockResolvedValue({ body: '<meta name="csrf-token" content="test-csrf"><a href="/user/show/7">Profile</a>', status: 200 });
    expect(await client.connect({ cookies: 'test=session' })).toMatchObject({ accountId: '7', cookies: 'test=session', csrf: 'test-csrf' });
    expect(request).toHaveBeenCalledTimes(1);
    expect(request.mock.calls[0]![1].method).toBeUndefined();
  });
  it('detects expired sessions and never attempts cookie refresh automation', async () => {
    const { client, request } = fixture();
    request.mockResolvedValue({ body: '<title>Sign in</title>', status: 200 });
    await expect(client.connect({ cookies: 'test=expired' })).rejects.toMatchObject({ code: 'session_expired', reconnect: true });
    expect(request).toHaveBeenCalledTimes(1);
  });
  it('rejects header injection', async () => {
    const { client, request } = fixture();
    await expect(client.connect({ cookies: 'test=value\r\nHost: evil' })).rejects.toMatchObject({ code: 'invalid_cookies' });
    expect(request).not.toHaveBeenCalled();
  });
  it('scopes Apollo state to the linked book instead of reading another book shelf', () => {
    expect(apolloBook(html(), '42').book.viewerShelving).toBeNull();
    expect(() => apolloBook(html(), '43')).toThrow('unreadable');
  });
  it('distinguishes missing viewer state from a confirmed unshelved book', async () => {
    const { client, request, session } = fixture();
    request.mockResolvedValue({ body: html(undefined).replace('"viewerShelving":null', ''), status: 200 });
    await expect(client.read(session, candidate)).rejects.toMatchObject({ code: 'page_changed' });
  });
  it('does not post progress when remote percentage is unknown', async () => {
    const { client, request, session } = fixture();
    request.mockResolvedValue({ body: html({ __ref: 'Shelving:42' }), status: 200 });
    const remote = await client.read(session, candidate);
    expect(remote.progressKnown).toBe(false);
    await expect(client.write(session, candidate, remote, { progress: 50 })).rejects.toMatchObject({ code: 'unknown_progress' });
    expect(session.beforeWrite).not.toHaveBeenCalled();
  });
  it('writes missing dates while preserving existing sessions, reviews, and private notes', async () => {
    const { client, request, session } = fixture();
    const oldRead = {
      id: 'old-read',
      bookId: 'kca://book/42',
      state: 'COMPLETED',
      startedDate: { year: 2024, month: 1, day: 1 },
      endedDate: { year: 2024, month: 1, day: 20 },
    };
    let currentRead: Record<string, unknown> = { id: 'current-read', bookId: 'kca://book/42', state: 'READING', startedDate: null, endedDate: null };
    let submitted: Record<string, unknown> | undefined;
    const editor = () => {
      const data = {
        bookId: 'kca://book/42',
        readingSessions: [oldRead, currentRead],
        userFormattedText: 'Existing review text',
        initialPrivateNotes: 'Existing private note',
        spoilerStatus: true,
        isAlreadyOwned: true,
        initialPostToBlog: true,
        initialAddToUpdateFeed: true,
      };
      return `<script>self.__next_f.push(${JSON.stringify([1, JSON.stringify(data)])})</script><script src="/_next/static/chunks/app/review/edit/dates.js"></script>`;
    };
    request.mockImplementation((url: string, init: RequestInit) => {
      let body = html({ __ref: 'Shelving:42' });
      if (url.includes('/_next/')) body = `createServerReference("${'a'.repeat(64)}",null,null,"submitReviewFormAction")`;
      else if (url.includes('/review/edit/')) {
        if (init.method === 'POST') {
          if (typeof init.body !== 'string') throw new TypeError('Expected a JSON request body');
          submitted = (JSON.parse(init.body) as Record<string, unknown>[])[0]!;
          currentRead = (submitted.readingSessions as Record<string, unknown>[])[1]!;
        }
        body = editor();
      }
      return Promise.resolve({ body, status: 200, headers: new Headers(), url });
    });
    const remote = await client.read(session, candidate);
    expect(remote.datesKnown).toBe(true);
    await client.write(session, candidate, remote, { startedOn: '2026-10-01', finishedOn: '2026-10-26' });
    expect(submitted).toMatchObject({
      reviewText: 'Existing review text',
      privateNotes: 'Existing private note',
      spoilerStatus: true,
      isOwnedEdition: true,
      postToBlog: false,
      addToUpdateFeed: false,
    });
    expect((submitted!.readingSessions as object[])[0]).toEqual(oldRead);
    expect(currentRead).toMatchObject({ startedDate: { year: 2026, month: 10, day: 1 }, endedDate: { year: 2026, month: 10, day: 26 } });
    expect(submitted!.initialReadingSessions).toEqual([oldRead, expect.objectContaining({ startedDate: null, endedDate: null })]);
    expect(session.beforeWrite).toHaveBeenCalledTimes(1);
    const verified = await client.read(session, candidate);
    expect(verified).toMatchObject({ identity: 'current-read', startedOn: '2026-10-01', finishedOn: '2026-10-26', datesKnown: true });
  });
  it('never replaces review text when the editor does not expose complete preservation fields', async () => {
    const { client, request, session } = fixture();
    const data = { readingSessions: [{ id: 'current-read', bookId: 'kca://book/42', state: 'READING', startedDate: null, endedDate: null }] };
    request.mockImplementation((url: string) =>
      Promise.resolve({
        body: url.includes('/review/edit/')
          ? `<script>self.__next_f.push(${JSON.stringify([1, JSON.stringify(data)])})</script>`
          : html({ __ref: 'Shelving:42' }),
        status: 200,
        headers: new Headers(),
        url,
      }),
    );
    const remote = await client.read(session, candidate);
    await expect(client.write(session, candidate, remote, { startedOn: '2026-10-01' })).rejects.toMatchObject({ code: 'editor_changed' });
    expect(session.beforeWrite).not.toHaveBeenCalled();
  });
  it('decodes Flight data without executing scripts', () => {
    const text = '0:{"readingSessions":[{"id":"read-1","bookId":"kca://book/42"}],"initialPrivateNotes":"private"}';
    const source = `<script>self.__next_f.push(${JSON.stringify([1, text])})</script>`;
    expect(flightValue(flightText(source), 'readingSessions')).toEqual([{ id: 'read-1', bookId: 'kca://book/42' }]);
    expect(flightValue(flightText(source), 'initialPrivateNotes')).toBe('private');
    expect(flightValue('malformed', 'readingSessions')).toBeUndefined();
  });
});
