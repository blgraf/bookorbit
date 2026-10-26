import { ProviderHttpService } from './provider-http.service';
afterEach(() => vi.unstubAllGlobals());
describe('provider HTTP boundary', () => {
  it('does not send credentials to untrusted destinations', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    await expect(new ProviderHttpService().request('https://evil.example/books', { headers: { Cookie: 'test' } })).rejects.toMatchObject({
      code: 'unsafe_url',
    });
    expect(fetch).not.toHaveBeenCalled();
  });
  it('refuses cross-origin redirects without forwarding authentication', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response('', { status: 302, headers: { location: 'https://evil.example/' } }));
    vi.stubGlobal('fetch', fetch);
    await expect(new ProviderHttpService().request('https://www.goodreads.com/review/list', { headers: { Cookie: 'test' } })).rejects.toMatchObject({
      code: 'unexpected_redirect',
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0]![1]).toMatchObject({ redirect: 'manual' });
  });
  it('detects expired login redirects', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', { status: 302, headers: { location: '/user/sign_in' } })));
    await expect(new ProviderHttpService().request('https://www.goodreads.com/review/list')).rejects.toMatchObject({
      reconnect: true,
      retryable: false,
    });
  });
  it('never bypasses WAF challenges', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('challenge', { status: 202 })));
    await expect(new ProviderHttpService().request('https://www.goodreads.com/review/list')).rejects.toMatchObject({
      code: 'challenge',
      reconnect: true,
    });
  });
  it('does not replay uncertain mutations automatically', async () => {
    const fetch = vi.fn().mockRejectedValue(new TypeError('test network failure with sensitive response'));
    vi.stubGlobal('fetch', fetch);
    await expect(new ProviderHttpService().request('https://www.goodreads.com/user_status.json', { method: 'POST' })).rejects.toMatchObject({
      code: 'network_error',
      uncertain: true,
      message: expect.not.stringContaining('sensitive'),
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('uses bounded backoff classification without exposing provider error bodies', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('sensitive debug response', { status: 503 })));
    await expect(new ProviderHttpService().request('https://prod-pagebound-api.onrender.com/api/v1/books/id')).rejects.toMatchObject({
      retryable: true,
      message: expect.not.stringContaining('sensitive'),
    });
  });
  it('serializes concurrent requests with provider rate spacing', async () => {
    const times: number[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(() => {
        times.push(Date.now());
        return Promise.resolve(new Response('{}'));
      }),
    );
    const service = new ProviderHttpService();
    await Promise.all([1, 2, 3].map(() => service.request('https://www.goodreads.com/review/list')));
    expect(times).toHaveLength(3);
    expect(times[1]! - times[0]!).toBeGreaterThanOrEqual(450);
    expect(times[2]! - times[1]!).toBeGreaterThanOrEqual(450);
  });
  it('bounds response size', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('x'.repeat(8 * 1024 * 1024 + 1))));
    await expect(new ProviderHttpService().request('https://www.goodreads.com/search')).rejects.toMatchObject({ code: 'response_too_large' });
  });
});
