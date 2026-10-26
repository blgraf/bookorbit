import { Injectable } from '@nestjs/common';
import type { ProviderReadingSnapshot, ReadingProviderCandidate } from '@bookorbit/types';
import { ProviderHttpService } from '../reading-provider/provider-http.service';
import {
  ProviderFailure,
  type ProviderCredentials,
  type ProviderRemoteState,
  type ProviderSession,
  type ReadingProviderClient,
} from '../reading-provider/provider.types';
import { progressPage } from '../reading-provider/provider-policy';

const API = 'https://prod-pagebound-api.onrender.com';
// Published web-client configuration, not a user credential. See docs/READING_PROVIDER_SYNC.md.
const FIREBASE_KEY = 'AIzaSyDCfBJ51pRZgHueBfBz0KNDiPNev1ClnGg';
const SEARCH = 'https://hztadco4ku1vqi6lp.a1.typesense.net';
const SEARCH_KEY = 'SgSrp2Vx4V4wjJAwnME6uWUufNdi9BxM';
interface ReadingInstance {
  id: number;
  current?: boolean;
  user_book_id?: number;
  started_reading_at_date?: string;
  started_reading_at?: string;
  finished_reading_at_date?: string;
  finished_reading_at?: string;
  progress_method?: string;
  total_page_count?: number;
}
interface UserBook {
  id: number;
  uuid: string;
  status: string;
  progress?: number;
  current_page?: number;
  total_page_count?: number;
  total_minutes?: number;
  current_minute?: number;
  current_reading_instance?: ReadingInstance;
  reading_instances?: ReadingInstance[];
  owned?: boolean;
  muted?: boolean;
  date_added?: string;
  format?: string;
  tracking_mode?: string;
  challenge_year?: number;
  shelves?: (number | { id: number })[];
}
interface Book {
  id: number;
  uuid: string;
  title: string;
  author_name?: string;
  author?: string;
  isbn?: string;
  page_count?: number;
  user_book?: UserBook | null;
}
interface FirebaseToken {
  idToken: string;
  refreshToken: string;
  expiresIn: string;
}
interface FirebaseRefresh {
  id_token: string;
  refresh_token: string;
  expires_in: string;
}
interface Auth {
  token: string;
  user: { id: number | string };
}
const TO_REMOTE = { to_read: 'interested', reading: 'current', read: 'finished', paused: 'paused', dnf: 'dnf' };
const FROM_REMOTE = { interested: 'to_read', current: 'reading', finished: 'read', paused: 'paused', dnf: 'dnf' } as const;
function dateOnly(value: string | undefined): string | null {
  if (!value) return null;
  if (/^\d{4}-\d{2}-\d{2}/.test(value)) return value.slice(0, 10);
  const parts = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(value);
  return parts ? `${parts[3]}-${parts[1]!.padStart(2, '0')}-${parts[2]!.padStart(2, '0')}` : null;
}
function formDate(value: string | null) {
  if (!value) return '';
  const [year, month, day] = value.split('-');
  return `${Number(month)}/${Number(day)}/${year}`;
}

@Injectable()
export class PageboundClientService implements ReadingProviderClient {
  readonly capabilities = {
    progress: true,
    ratings: false,
    readingDates: true,
    limitations: [
      'Pagebound exposes ratings through review publication. This integration does not publish reviews, so ratings require manual entry.',
      'Search does not provide a verified ISBN lookup; ambiguous editions require manual selection.',
      'Start rereads in Pagebound first. Existing reading instances and history are never deleted.',
    ],
  };
  constructor(private readonly http: ProviderHttpService) {}
  async connect(input: { email?: string; password?: string }): Promise<ProviderCredentials> {
    if (!input.email || !input.password) throw new ProviderFailure('missing_credentials', 'Email and password are required.');
    const firebase = await this.http.json<FirebaseToken>(
      `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${FIREBASE_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: input.email, password: input.password, returnSecureToken: true, clientType: 'CLIENT_TYPE_WEB' }),
      },
    );
    return this.exchange(firebase.idToken, firebase.refreshToken, Number(firebase.expiresIn));
  }
  private async exchange(idToken: string, refreshToken: string, expiresIn: number): Promise<ProviderCredentials> {
    if (!idToken || !refreshToken || !Number.isFinite(expiresIn))
      throw new ProviderFailure('invalid_auth_response', 'Pagebound sign-in did not return a renewable session.');
    const auth = await this.http.json<Auth>(`${API}/api/v1/auth/firebase_auth`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer null' },
      body: JSON.stringify({ id_token: idToken }),
    });
    if (!auth.token || !auth.user?.id) throw new ProviderFailure('invalid_auth_response', 'Pagebound sign-in did not return an account.');
    return { accountId: String(auth.user.id), apiToken: auth.token, refreshToken, expiresAt: Date.now() + expiresIn * 1000 };
  }
  private async renew(session: ProviderSession): Promise<void> {
    let fresh: FirebaseRefresh;
    try {
      fresh = await this.http.json<FirebaseRefresh>(`https://securetoken.googleapis.com/v1/token?key=${FIREBASE_KEY}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: session.credentials.refreshToken ?? '' }).toString(),
      });
    } catch (error) {
      if (error instanceof ProviderFailure && error.code === 'provider_rejected')
        throw new ProviderFailure('refresh_expired', 'Pagebound session expired. Reconnect with your email and password.', false, true);
      throw error;
    }
    const credentials = await this.exchange(fresh.id_token, fresh.refresh_token, Number(fresh.expires_in));
    if (credentials.accountId !== session.credentials.accountId)
      throw new ProviderFailure('account_changed', 'Pagebound account changed. Reconnect to continue.', false, true);
    await session.saveCredentials(credentials);
    session.credentials = credentials;
  }
  private async request<T>(session: ProviderSession, path: string, method = 'GET', payload?: unknown): Promise<T> {
    if ((session.credentials.expiresAt ?? 0) < Date.now() + 60_000) await this.renew(session);
    const send = () =>
      this.http.json<T>(API + path, {
        method,
        headers: { Authorization: `Bearer ${session.credentials.apiToken}`, 'Content-Type': 'application/json' },
        ...(payload !== undefined ? { body: JSON.stringify(payload) } : {}),
      });
    if (method !== 'GET') await session.beforeWrite();
    try {
      return await send();
    } catch (error) {
      if (!(error instanceof ProviderFailure) || !error.reconnect) throw error;
      await this.renew(session);
      if (method !== 'GET') await session.beforeWrite();
      return send();
    }
  }
  async validate(session: ProviderSession) {
    await this.renew(session);
  }
  async search(_session: ProviderSession, query: string): Promise<ReadingProviderCandidate[]> {
    const params = new URLSearchParams({ q: query, query_by: 'title,author_name', per_page: '10', num_typos: '0' });
    const response = await this.http.json<{ hits: { document: Book }[] }>(`${SEARCH}/collections/books/documents/search?${params}`, {
      headers: { 'X-TYPESENSE-API-KEY': SEARCH_KEY },
    });
    if (!Array.isArray(response.hits)) throw new ProviderFailure('search_changed', 'Pagebound search response changed.');
    return response.hits.slice(0, 10).map(({ document }) => this.candidate(document));
  }
  private candidate(book: Book): ReadingProviderCandidate {
    if (!book.id || !book.uuid || !book.title) throw new ProviderFailure('invalid_book', 'Pagebound book is missing its edition identity.');
    return {
      id: String(book.id),
      resourceId: book.uuid,
      title: book.title,
      authors: [book.author_name ?? book.author ?? ''],
      isbn: book.isbn ?? null,
      pages: book.page_count ?? null,
      url: `https://pagebound.co/books/${book.uuid}`,
    };
  }
  async getBook(session: ProviderSession, resourceId: string) {
    if (!/^[a-zA-Z0-9-]{1,128}$/.test(resourceId)) throw new ProviderFailure('invalid_link', 'Enter a Pagebound book UUID.');
    const response = await this.request<{ book: Book }>(session, `/api/v1/books/${encodeURIComponent(resourceId)}`);
    return this.candidate(response.book);
  }
  async read(session: ProviderSession, candidate: ReadingProviderCandidate): Promise<ProviderRemoteState> {
    const { book } = await this.request<{ book: Book }>(session, `/api/v1/books/${encodeURIComponent(candidate.resourceId)}`);
    if (String(book?.id) !== candidate.id || book?.uuid !== candidate.resourceId)
      throw new ProviderFailure('identity_mismatch', 'Pagebound returned a different book. Relink the correct edition.');
    if (!Object.hasOwn(book, 'user_book'))
      throw new ProviderFailure(
        'unknown_library_state',
        'Pagebound did not expose whether this book is in your library. No remote data was changed.',
      );
    const ub = book.user_book;
    if (ub !== null && (!ub || !Number.isSafeInteger(ub.id) || ub.id <= 0 || typeof ub.status !== 'string'))
      throw new ProviderFailure('unknown_library_state', 'Pagebound reading-list state is incomplete.');
    const active = ub?.current_reading_instance?.current !== false ? ub?.current_reading_instance : undefined;
    const instances = ub?.reading_instances?.filter((read) => read.current) ?? [];
    if (instances.length > 1)
      throw new ProviderFailure('ambiguous_read', 'Pagebound returned multiple current reading instances. Select the active read on Pagebound.');
    const read = active ?? instances[0];
    if (read && (!Number.isSafeInteger(read.id) || read.id <= 0))
      throw new ProviderFailure('invalid_read', 'Pagebound returned an invalid reading instance. No history was changed.');
    const status = ub ? FROM_REMOTE[ub.status as keyof typeof FROM_REMOTE] : 'to_read';
    if (!status) throw new ProviderFailure('unsupported_remote_status', 'Pagebound returned an unknown reading status.');
    const total = Number(ub?.total_page_count ?? read?.total_page_count ?? book.page_count);
    const progress =
      status === 'read'
        ? 100
        : typeof ub?.progress === 'number'
          ? ub.progress
          : typeof ub?.current_page === 'number' && total > 0
            ? (ub.current_page * 100) / total
            : ub
              ? null
              : 0;
    return {
      exists: Boolean(ub),
      status,
      progress,
      rating: null,
      startedOn: dateOnly(read?.started_reading_at_date ?? read?.started_reading_at),
      finishedOn: dateOnly(read?.finished_reading_at_date ?? read?.finished_reading_at),
      progressKnown: progress !== null && Number.isFinite(progress) && progress >= 0 && progress <= 100,
      ratingKnown: false,
      datesKnown: !ub || Boolean(read),
      identity: read ? String(read.id) : null,
      raw: { book, userBook: ub, readingInstance: read, totalPages: total },
    };
  }
  async write(
    session: ProviderSession,
    book: ReadingProviderCandidate,
    remote: ProviderRemoteState,
    changes: Partial<ProviderReadingSnapshot>,
  ): Promise<void> {
    if (changes.rating !== undefined)
      throw new ProviderFailure('rating_unsupported', 'Pagebound rating publication is disabled to preserve reviews.');
    if (changes.status !== undefined || changes.startedOn || changes.finishedOn) {
      const ub = remote.raw.userBook as UserBook | undefined;
      const read = remote.raw.readingInstance as ReadingInstance | undefined;
      if (ub && !read && (changes.startedOn || changes.finishedOn))
        throw new ProviderFailure('missing_read', 'No unambiguous current Pagebound reading instance. Reading history was preserved.');
      if (
        ub &&
        (typeof ub.owned !== 'boolean' ||
          typeof ub.muted !== 'boolean' ||
          !Array.isArray(ub.shelves) ||
          typeof ub.date_added !== 'string' ||
          typeof ub.format !== 'string' ||
          typeof ub.tracking_mode !== 'string')
      )
        throw new ProviderFailure(
          'incomplete_remote_state',
          'Pagebound did not expose the fields needed to preserve your existing reading-list settings.',
        );
      const shelfIds = (ub?.shelves ?? []).map((shelf) => (typeof shelf === 'number' ? shelf : shelf.id));
      if (shelfIds.some((id) => !Number.isSafeInteger(id) || id <= 0))
        throw new ProviderFailure('incomplete_remote_state', 'Pagebound shelves could not be preserved safely.');
      const status = TO_REMOTE[changes.status ?? remote.status];
      const payload: Record<string, unknown> = {
        user_book: { owned: ub?.owned === true, muted: ub?.muted === true, ...(!ub ? { book_id: Number(book.id), status } : {}) },
        shelf_ids: shelfIds,
        ...(ub ? { status } : {}),
        date: ub?.date_added ?? formDate(new Date().toISOString().slice(0, 10)),
        started_reading_at: formDate(changes.startedOn ?? remote.startedOn),
        finished_reading_at: formDate(changes.finishedOn ?? remote.finishedOn),
        challenge_year: ub?.challenge_year ?? null,
        format: ub?.format ?? 'print',
        tracking_mode: ub?.tracking_mode ?? 'pages',
        total_page_count: ub?.total_page_count ?? '',
        total_minutes: ub?.total_minutes ?? null,
      };
      await this.request(
        session,
        ub ? `/api/v1/user_books/${encodeURIComponent(ub.uuid || String(ub.id))}` : '/api/v1/user_books',
        ub ? 'PUT' : 'POST',
        payload,
      );
    }
    if (changes.progress !== undefined && changes.progress !== null) {
      const current = await this.read(session, book);
      if (!current.progressKnown || (current.progress ?? 0) >= changes.progress) return;
      if (current.status === 'read') return;
      const ub = current.raw.userBook as UserBook | undefined;
      const read = current.raw.readingInstance as ReadingInstance | undefined;
      if (!ub || !read) throw new ProviderFailure('missing_read', 'Start a reading instance on Pagebound before sending progress.');
      if (remote.identity && remote.identity !== current.identity)
        throw new ProviderFailure('read_changed', 'Pagebound reading instance changed. Sync again after checking the active read.');
      const totalPages = Number(current.raw.totalPages);
      const page = progressPage(changes.progress, Number.isFinite(totalPages) && totalPages > 0 ? totalPages : null);
      await this.request(session, '/api/v1/reading_updates', 'POST', {
        reading_update: {
          user_book_id: ub.id,
          date: formDate(new Date().toISOString().slice(0, 10)),
          reading_instance_id: read.id,
          total_progress: changes.progress,
          total_pages_read: page === null ? null : String(page),
        },
        user_book: {
          ...(page === null ? {} : { current_page: String(page) }),
          ...(totalPages > 0 ? { total_page_count: totalPages } : {}),
          ...(Object.hasOwn(ub, 'current_minute') ? { current_minute: ub.current_minute } : {}),
          ...(Object.hasOwn(ub, 'total_minutes') ? { total_minutes: ub.total_minutes } : {}),
        },
        no_broadcast: true,
        progress_method: 'percent',
      });
    }
  }
}
