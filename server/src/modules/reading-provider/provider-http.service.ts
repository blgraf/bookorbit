import { setTimeout as delay } from 'node:timers/promises';
import { Injectable } from '@nestjs/common';
import { ProviderFailure } from './provider.types';

const ALLOWED_ORIGINS = new Set([
  'https://www.goodreads.com',
  'https://identitytoolkit.googleapis.com',
  'https://securetoken.googleapis.com',
  'https://prod-pagebound-api.onrender.com',
  'https://hztadco4ku1vqi6lp.a1.typesense.net',
]);
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

@Injectable()
export class ProviderHttpService {
  private readonly queues = new Map<string, Promise<unknown>>();
  private readonly nextRequestAt = new Map<string, number>();
  private async limitedFetch(origin: string, url: string, init: RequestInit): Promise<Response> {
    const previous = this.queues.get(origin) ?? Promise.resolve();
    const current = previous
      .catch(() => undefined)
      .then(async () => {
        const wait = (this.nextRequestAt.get(origin) ?? 0) - Date.now();
        if (wait > 0) await delay(wait);
        try {
          return await fetch(url, init);
        } finally {
          this.nextRequestAt.set(origin, Date.now() + 500);
        }
      });
    this.queues.set(origin, current);
    try {
      return await current;
    } finally {
      if (this.queues.get(origin) === current) this.queues.delete(origin);
    }
  }
  async request(url: string, init: RequestInit = {}): Promise<{ body: string; status: number; headers: Headers; url: string }> {
    const mutation = init.method !== undefined && init.method !== 'GET';
    for (let redirects = 0; redirects <= 3; redirects++) {
      const target = new URL(url);
      if (!ALLOWED_ORIGINS.has(target.origin) || target.username || target.password)
        throw new ProviderFailure('unsafe_url', 'Provider URL is not allowed.');
      let response: Response;
      try {
        response = await this.limitedFetch(target.origin, url, { ...init, redirect: 'manual', signal: AbortSignal.timeout(30_000) });
      } catch {
        throw new ProviderFailure(
          'network_error',
          'Provider request did not complete. Remote state will be checked before retrying.',
          true,
          false,
          mutation,
        );
      }
      if (response.headers.has('x-amzn-waf-action') || response.status === 202) {
        await response.body?.cancel();
        throw new ProviderFailure('challenge', 'Provider requires a browser challenge. Reconnect after completing it in your browser.', false, true);
      }
      if (response.status >= 300 && response.status < 400) {
        await response.body?.cancel();
        const next = new URL(response.headers.get('location') ?? '', url);
        if (/sign_in|signin|login|ap\/signin/.test(next.pathname))
          throw new ProviderFailure('session_expired', 'Session expired. Reconnect this provider.', false, true);
        if (mutation || next.origin !== target.origin)
          throw new ProviderFailure(
            'unexpected_redirect',
            'Provider redirected unexpectedly; no credentials were forwarded.',
            false,
            false,
            mutation,
          );
        url = next.toString();
        continue;
      }
      if (response.status === 401 || response.status === 403) {
        await response.body?.cancel();
        throw new ProviderFailure('session_expired', 'Provider authentication failed. Reconnect this provider.', false, true);
      }
      if (response.status === 429 || response.status >= 500) {
        await response.body?.cancel();
        throw new ProviderFailure('provider_unavailable', 'Provider is busy or temporarily unavailable.', true, false, mutation);
      }
      if (!response.ok) {
        await response.body?.cancel();
        throw new ProviderFailure('provider_rejected', `Provider rejected the request (HTTP ${response.status}).`);
      }
      const reader = response.body?.getReader();
      let size = 0;
      const chunks: Uint8Array[] = [];
      if (reader) {
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            size += value.byteLength;
            if (size > MAX_RESPONSE_BYTES)
              throw new ProviderFailure('response_too_large', 'Provider response exceeded the safety limit.', false, false, mutation);
            chunks.push(value);
          }
        } catch (error) {
          await reader.cancel().catch(() => undefined);
          if (error instanceof ProviderFailure) throw error;
          throw new ProviderFailure('network_error', 'Provider response was interrupted.', true, false, mutation);
        } finally {
          reader.releaseLock();
        }
      }
      const body = Buffer.concat(chunks).toString('utf8');
      if (/captcha|challenge-platform|robot check/i.test(body.slice(0, 8000)) && /<html|<!doctype/i.test(body.slice(0, 500))) {
        throw new ProviderFailure('challenge', 'Provider requires a browser challenge. Complete it in your browser and reconnect.', false, true);
      }
      return { body, status: response.status, headers: response.headers, url };
    }
    throw new ProviderFailure('redirect_limit', 'Provider sent too many redirects.');
  }
  async json<T = Record<string, unknown>>(url: string, init: RequestInit = {}): Promise<T> {
    const { body } = await this.request(url, init);
    try {
      return JSON.parse(body) as T;
    } catch {
      throw new ProviderFailure(
        'unexpected_response',
        'Provider returned an unexpected response.',
        false,
        false,
        Boolean(init.method && init.method !== 'GET'),
      );
    }
  }
}
