import { PageboundClientService } from './pagebound-client.service';
import { ProviderHttpService } from '../reading-provider/provider-http.service';
import { ProviderFailure, type ProviderSession } from '../reading-provider/provider.types';
const candidate = {
  id: '42',
  resourceId: 'book-uuid',
  title: 'A Book',
  authors: ['Author'],
  isbn: null,
  pages: 300,
  url: 'https://pagebound.co/books/book-uuid',
};
const book = {
  id: 42,
  uuid: 'book-uuid',
  title: 'A Book',
  page_count: 300,
  user_book: {
    id: 7,
    uuid: 'user-book',
    status: 'current',
    progress: 20,
    total_page_count: 200,
    owned: true,
    muted: true,
    date_added: '10/1/2026',
    format: 'print',
    tracking_mode: 'pages',
    shelves: [{ id: 8 }],
    current_reading_instance: { id: 9, current: true, user_book_id: 7, started_reading_at: '10/1/2026' },
  },
};
function fixture() {
  const json = vi.fn();
  const client = new PageboundClientService({ json } as unknown as ProviderHttpService);
  const session: ProviderSession = {
    credentials: { accountId: '1', apiToken: 'test-api', refreshToken: 'test-refresh', expiresAt: Date.now() + 3600000 },
    saveCredentials: vi.fn(),
    beforeWrite: vi.fn(),
  };
  return { json, client, session };
}
describe('Pagebound native client', () => {
  it('signs in without retaining the password', async () => {
    const { client, json } = fixture();
    json
      .mockResolvedValueOnce({ idToken: 'firebase', refreshToken: 'refresh', expiresIn: '3600' })
      .mockResolvedValueOnce({ token: 'api', user: { id: 1 } });
    const result = await client.connect({ email: 'test@example.com', password: 'test-password' });
    expect(result).toEqual({ accountId: '1', apiToken: 'api', refreshToken: 'refresh', expiresAt: expect.any(Number) });
    expect(result).not.toHaveProperty('password');
    expect(json.mock.calls[1]![0]).toContain('/auth/firebase_auth');
  });
  it('refreshes expired tokens and persists only renewable credentials', async () => {
    const { client, json, session } = fixture();
    session.credentials.expiresAt = 0;
    json
      .mockResolvedValueOnce({ id_token: 'firebase', refresh_token: 'new-refresh', expires_in: '3600' })
      .mockResolvedValueOnce({ token: 'new-api', user: { id: 1 } })
      .mockResolvedValueOnce({ book });
    await client.read(session, candidate);
    expect(session.saveCredentials).toHaveBeenCalledWith(expect.objectContaining({ apiToken: 'new-api', refreshToken: 'new-refresh' }));
  });
  it('requires reconnect after the refresh credential expires', async () => {
    const { client, json, session } = fixture();
    session.credentials.expiresAt = 0;
    json.mockRejectedValue(new ProviderFailure('provider_rejected', 'HTTP 400'));
    await expect(client.read(session, candidate)).rejects.toMatchObject({ code: 'refresh_expired', reconnect: true, retryable: false });
  });
  it('does not treat missing user_book information as an empty remote library', async () => {
    const { client, json, session } = fixture();
    json.mockResolvedValue({ book: { id: 42, uuid: 'book-uuid', title: 'A Book' } });
    await expect(client.read(session, candidate)).rejects.toMatchObject({ code: 'unknown_library_state' });
  });
  it('does not mistake an unreadable library state for a missing book', async () => {
    const { client, json, session } = fixture();
    json.mockResolvedValue({ book: { ...book, uuid: 'other-edition' } });
    await expect(client.read(session, candidate)).rejects.toMatchObject({ code: 'identity_mismatch' });
  });
  it('rejects ambiguous active reading instances', async () => {
    const { client, json, session } = fixture();
    json.mockResolvedValue({
      book: {
        ...book,
        user_book: {
          ...book.user_book,
          reading_instances: [
            { id: 8, current: true },
            { id: 9, current: true },
          ],
        },
      },
    });
    await expect(client.read(session, candidate)).rejects.toMatchObject({ code: 'ambiguous_read' });
  });
  it('uses remote edition pages and suppresses broadcasts without creating posts or reviews', async () => {
    const { client, json, session } = fixture();
    json.mockResolvedValue({ book });
    const remote = await client.read(session, candidate);
    await client.write(session, candidate, remote, { progress: 50 });
    const call = json.mock.calls.find(([url]) => String(url).endsWith('/reading_updates'));
    expect(JSON.parse(call![1].body)).toMatchObject({
      reading_update: { user_book_id: 7, reading_instance_id: 9, total_progress: 50, total_pages_read: '100' },
      no_broadcast: true,
      progress_method: 'percent',
    });
    expect(session.beforeWrite).toHaveBeenCalledTimes(1);
    expect(json.mock.calls.every(([url]) => !/reviews|posts/.test(String(url)))).toBe(true);
  });
  it('does not create duplicate progress records when remote is already ahead', async () => {
    const { client, json, session } = fixture();
    json.mockResolvedValue({ book });
    const remote = await client.read(session, candidate);
    await client.write(session, candidate, remote, { progress: 10 });
    expect(session.beforeWrite).not.toHaveBeenCalled();
  });
  it('preserves shelves, ownership, dates and the exact user book on status changes', async () => {
    const { client, json, session } = fixture();
    json.mockResolvedValue({ book });
    const remote = await client.read(session, candidate);
    await client.write(session, candidate, remote, { status: 'paused' });
    const mutation = json.mock.calls.find(([, init]) => init.method === 'PUT');
    expect(mutation![0]).toContain('/user_books/user-book');
    expect(JSON.parse(mutation![1].body)).toMatchObject({
      user_book: { owned: true, muted: true },
      shelf_ids: [8],
      status: 'paused',
      started_reading_at: '10/1/2026',
    });
  });
  it('refuses rating publication', async () => {
    const { client, json, session } = fixture();
    json.mockResolvedValue({ book });
    const remote = await client.read(session, candidate);
    await expect(client.write(session, candidate, remote, { rating: 5 })).rejects.toMatchObject({ code: 'rating_unsupported' });
    expect(session.beforeWrite).not.toHaveBeenCalled();
  });
});
