import { Injectable } from '@nestjs/common';
import { load } from 'cheerio';
import type { ProviderReadingSnapshot, ReadingProviderCandidate } from '@bookorbit/types';
import { ProviderHttpService } from '../reading-provider/provider-http.service';
import {
  ProviderFailure,
  type ProviderCredentials,
  type ProviderRemoteState,
  type ProviderSession,
  type ReadingProviderClient,
} from '../reading-provider/provider.types';
import { apolloBook, flightText, flightValue, fullDate, object, resolve } from './goodreads-parser';

const ORIGIN = 'https://www.goodreads.com';
const STATUS = { to_read: 'to-read', reading: 'currently-reading', read: 'read' } as const;
@Injectable()
export class GoodreadsClientService implements ReadingProviderClient {
  readonly capabilities = {
    progress: true,
    ratings: true,
    readingDates: true,
    limitations: [
      'Unofficial Goodreads endpoints may change or require a browser challenge. Cookies must be replaced manually when expired.',
      'Progress is sent only when the logged-in page exposes a reliable remote percentage. Unreadable progress is never overwritten.',
      'Goodreads progress updates may appear in its activity feed; no journal text, reviews, or notes are submitted.',
      'Paused, abandoned, skimmed, and unread are not mapped to Goodreads shelves. Rereads must first be started on Goodreads.',
      'Reading dates are written only when the current editor action and complete existing review state can be read and preserved.',
    ],
  };
  constructor(private readonly http: ProviderHttpService) {}
  private async request(session: ProviderSession, path: string, init: RequestInit = {}) {
    if (init.method && init.method !== 'GET') await session.beforeWrite();
    const response = await this.http.request(ORIGIN + path, {
      ...init,
      headers: { Cookie: session.credentials.cookies ?? '', Accept: 'text/html,application/json', ...init.headers },
    });
    if (/id=["']sign_in|action=["'][^"']*sign_in|<title>Sign in/i.test(response.body))
      throw new ProviderFailure('session_expired', 'Goodreads session expired. Paste fresh browser cookies to reconnect.', false, true);
    const $ = load(response.body);
    const csrf = $('meta[name="csrf-token"]').attr('content') ?? $('input[name="authenticity_token"]').attr('value');
    if (csrf) session.credentials.csrf = csrf;
    return response;
  }
  async connect(input: { cookies?: string }): Promise<ProviderCredentials> {
    const cookies = input.cookies?.trim().replace(/^cookie:\s*/i, '');
    if (!cookies || cookies.length > 16_384 || /[\r\n]/.test(cookies) || !cookies.includes('='))
      throw new ProviderFailure('invalid_cookies', 'Paste a single Goodreads Cookie request-header value.');
    const credentials: ProviderCredentials = { accountId: '', cookies };
    const session: ProviderSession = {
      credentials,
      saveCredentials: () => Promise.resolve(),
      beforeWrite: () => Promise.reject(new ProviderFailure('validation_write', 'Connection validation cannot write remote data.')),
    };
    const response = await this.request(session, '/review/list');
    const id = response.body.match(/\/user\/show\/(\d+)/)?.[1];
    if (!id || !credentials.csrf)
      throw new ProviderFailure('invalid_session', 'Goodreads session could not be validated. Reconnect with current browser cookies.', false, true);
    credentials.accountId = id;
    return credentials;
  }
  async validate(session: ProviderSession) {
    const result = await this.connect({ cookies: session.credentials.cookies });
    if (result.accountId !== session.credentials.accountId)
      throw new ProviderFailure('account_changed', 'Goodreads account changed. Disconnect before connecting a different account.', false, true);
    session.credentials = result;
    await session.saveCredentials(result);
  }
  async getBook(session: ProviderSession, resourceId: string): Promise<ReadingProviderCandidate> {
    if (!/^\d{1,20}$/.test(resourceId)) throw new ProviderFailure('invalid_link', 'Enter the numeric Goodreads edition ID.');
    const response = await this.request(session, `/book/show/${resourceId}`);
    const $ = load(response.body);
    let data: Record<string, unknown> = {};
    $('script[type="application/ld+json"]').each((_index, element) => {
      try {
        const parsed = object(JSON.parse($(element).text()));
        if (parsed['@type'] === 'Book') data = parsed;
      } catch {
        /* Ignore unrelated structured data. */
      }
    });
    const title = typeof data.name === 'string' ? data.name : $('h1[data-testid="bookTitle"]').text().trim();
    const rawAuthors = Array.isArray(data.author) ? data.author : [data.author];
    const authors = rawAuthors.map((author) => object(author).name).filter((name): name is string => typeof name === 'string');
    if (!authors.length)
      $('[data-testid="name"]')
        .slice(0, 5)
        .each((_index, element) => {
          authors.push($(element).text().trim());
        });
    if (!title) throw new ProviderFailure('invalid_book', 'Goodreads edition could not be read.');
    return {
      id: resourceId,
      resourceId,
      title,
      authors,
      isbn: typeof data.isbn === 'string' ? data.isbn : null,
      pages: typeof data.numberOfPages === 'number' ? data.numberOfPages : null,
      url: `${ORIGIN}/book/show/${resourceId}`,
    };
  }
  async search(session: ProviderSession, query: string): Promise<ReadingProviderCandidate[]> {
    const response = await this.request(session, `/search?q=${encodeURIComponent(query)}`);
    const redirected = new URL(response.url).pathname.match(/^\/book\/show\/(\d+)/)?.[1];
    if (redirected) return [await this.getBook(session, redirected)];
    const $ = load(response.body);
    const candidates = new Map<string, ReadingProviderCandidate>();
    $('[data-testid="book-item-title"] a, a.bookTitle').each((_index, element) => {
      const id = $(element)
        .attr('href')
        ?.match(/\/book\/show\/(\d+)/)?.[1];
      if (!id || candidates.size >= 10) return;
      const row = $(element).closest('tr');
      const author = row.length
        ? row.find('.authorName').first().text().trim()
        : $(element).parent().parent().find('[data-testid="name"]').first().text().trim();
      candidates.set(id, {
        id,
        resourceId: id,
        title: $(element).text().trim(),
        authors: author ? [author] : [],
        isbn: null,
        pages: null,
        url: `${ORIGIN}/book/show/${id}`,
      });
    });
    return [...candidates.values()];
  }
  private async editor(session: ProviderSession, book: ReadingProviderCandidate) {
    const response = await this.request(session, `/review/edit/${book.id}`);
    const text = flightText(response.body);
    const sessions = flightValue(text, 'readingSessions');
    const internalId = (Array.isArray(sessions) ? object(sessions[0]).bookId : undefined) ?? /"bookId":"(kca:\/\/book\/[^"\s]+)"/.exec(text)?.[1];
    return {
      html: response.body,
      text,
      sessions: Array.isArray(sessions) ? sessions.map(object) : null,
      internalId: typeof internalId === 'string' ? internalId : null,
    };
  }
  async read(session: ProviderSession, candidate: ReadingProviderCandidate): Promise<ProviderRemoteState> {
    const response = await this.request(session, `/book/show/${candidate.id}`);
    const { book, cache } = apolloBook(response.body, candidate.id);
    if (!Object.hasOwn(book, 'viewerShelving'))
      throw new ProviderFailure('unknown_shelf', 'Goodreads did not expose your shelf. No remote state was changed.');
    const exists = book.viewerShelving !== null;
    const shelving = resolve(cache, book.viewerShelving);
    const shelf = resolve(cache, shelving.shelf);
    const status = exists
      ? ({ 'to-read': 'to_read', 'currently-reading': 'reading', read: 'read' } as const)[String(shelf.name) as keyof typeof STATUS]
      : 'to_read';
    if (!status) throw new ProviderFailure('unsupported_remote_status', 'Goodreads shelf could not be mapped safely.');
    const progressData = resolve(cache, shelving.readingProgress);
    const percentage = progressData.percentage ?? progressData.percent;
    const progress = !exists
      ? 0
      : status === 'read'
        ? 100
        : typeof percentage === 'number' && percentage >= 0 && percentage <= 100
          ? percentage
          : null;
    const review = resolve(cache, shelving.review);
    const rating = typeof review.rating === 'number' && review.rating > 0 ? review.rating : null;
    const editor = exists ? await this.editor(session, candidate) : null;
    const reads = editor?.sessions ?? [];
    const active = reads.filter((read) => read.state === 'READING' && !fullDate(read.endedDate));
    const completed = reads
      .filter((read) => fullDate(read.endedDate) && read.bookId === editor?.internalId)
      .sort((left, right) => fullDate(right.endedDate)!.localeCompare(fullDate(left.endedDate)!));
    const latestCompleted =
      completed.length && (completed.length === 1 || fullDate(completed[0]!.endedDate) !== fullDate(completed[1]!.endedDate))
        ? completed[0]
        : undefined;
    const current =
      active.length === 1 ? active[0] : active.length > 1 ? undefined : (latestCompleted ?? (reads.length === 1 ? reads[0] : undefined));
    const datesKnown = !exists || Boolean(current && editor?.internalId && current.bookId === editor.internalId && editor.internalId === book.id);
    return {
      exists,
      status,
      progress,
      rating,
      startedOn: fullDate(current?.startedDate),
      finishedOn: fullDate(current?.endedDate),
      progressKnown: progress !== null,
      ratingKnown:
        !exists ||
        shelving.review === null ||
        review.rating === null ||
        (typeof review.rating === 'number' && review.rating >= 0 && review.rating <= 5),
      datesKnown,
      identity: typeof current?.id === 'string' ? current.id : null,
      raw: { editor, current, internalId: book.id },
    };
  }
  private async csrf(session: ProviderSession) {
    await this.request(session, '/review/list');
    if (!session.credentials.csrf) throw new ProviderFailure('missing_csrf', 'Goodreads session lacks a CSRF token. Reconnect.', false, true);
    return session.credentials.csrf;
  }
  private async form(session: ProviderSession, path: string, values: Record<string, string>) {
    const csrf = await this.csrf(session);
    await this.request(session, path, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'X-CSRF-Token': csrf,
        'X-Requested-With': 'XMLHttpRequest',
        Origin: ORIGIN,
        Referer: ORIGIN + '/',
      },
      body: new URLSearchParams(values).toString(),
    });
  }
  async write(session: ProviderSession, book: ReadingProviderCandidate, remote: ProviderRemoteState, changes: Partial<ProviderReadingSnapshot>) {
    if (changes.status !== undefined) {
      const shelf = STATUS[changes.status as keyof typeof STATUS];
      if (!shelf) throw new ProviderFailure('unsupported_status', 'Goodreads does not support this status safely.');
      await this.form(session, '/shelf/add_to_shelf', { book_id: book.id, name: shelf, a: '' });
    }
    if (changes.progress !== undefined && changes.progress !== null) {
      const current = await this.read(session, book);
      if (!current.progressKnown) throw new ProviderFailure('unknown_progress', 'Goodreads remote progress is unreadable. Progress was preserved.');
      if (current.status !== 'read' && (current.progress ?? 0) < changes.progress) {
        await this.form(session, '/user_status.json', {
          'user_status[book_id]': book.id,
          'user_status[percent]': String(changes.progress),
          'user_status[body]': '',
        });
      }
    }
    if (changes.rating !== undefined && changes.rating !== null) {
      const current = await this.read(session, book);
      if (!current.ratingKnown || current.rating !== remote.rating)
        throw new ProviderFailure('rating_changed', 'Goodreads rating changed during synchronization. Rating was preserved.');
      await this.form(session, `/review/rate/${book.id}?no_lightbox=true&queue=false&stars_click=true&rating=${changes.rating}&ref=undefined`, {});
    }
    if (changes.startedOn || changes.finishedOn) await this.writeDates(session, book, changes, remote.raw.internalId);
  }
  private async writeDates(
    session: ProviderSession,
    book: ReadingProviderCandidate,
    changes: Partial<ProviderReadingSnapshot>,
    expectedInternalId: unknown,
  ) {
    const editor = await this.editor(session, book);
    if (!editor.sessions || !editor.internalId || editor.internalId !== expectedInternalId)
      throw new ProviderFailure('dates_unsupported', 'Goodreads reading history could not be read. Set reading dates on Goodreads.');
    const active = editor.sessions.filter((read) => read.bookId === editor.internalId && !fullDate(read.endedDate));
    if (active.length !== 1) throw new ProviderFailure('ambiguous_read', 'Goodreads has no unique active read. Existing history was preserved.');
    const current = active[0]!;
    const updated = { ...current };
    for (const [field, key] of [
      ['startedOn', 'startedDate'],
      ['finishedOn', 'endedDate'],
    ] as const) {
      const value = changes[field];
      if (!value) continue;
      if (current[key] !== null && current[key] !== undefined) {
        if (fullDate(current[key]) !== value)
          throw new ProviderFailure('date_changed', 'Goodreads reading dates changed. Existing history was preserved.');
      } else {
        const [year, month, day] = value.split('-').map(Number);
        updated[key] = { __typename: 'NullableDate', year, month, day };
      }
    }
    const required = [
      'userFormattedText',
      'initialPrivateNotes',
      'spoilerStatus',
      'isAlreadyOwned',
      'initialPostToBlog',
      'initialAddToUpdateFeed',
    ] as const;
    const preserved = Object.fromEntries(required.map((key) => [key, flightValue(editor.text, key)]));
    if (required.some((key) => preserved[key] === undefined))
      throw new ProviderFailure('editor_changed', 'Goodreads review editor changed. Dates were not written to protect reviews and notes.');
    const $ = load(editor.html);
    const paths = $('script[src]')
      .map((_index, element) => $(element).attr('src'))
      .get()
      .filter((path) => path.startsWith('/_next/static/chunks/') && !path.includes('..'))
      .slice(-10);
    let action: string | undefined;
    for (const path of paths.reverse()) {
      const source = await this.request(session, path);
      action = /createServerReference[^()]*\(\s*["']([a-f0-9]{32,})["'][\s\S]{0,180}?"submitReviewFormAction"/.exec(source.body)?.[1];
      if (action) break;
    }
    if (!action) throw new ProviderFailure('editor_changed', 'Goodreads date-save action is unavailable. Set reading dates on Goodreads.');
    const freshEditor = await this.editor(session, book);
    if (freshEditor.text !== editor.text)
      throw new ProviderFailure(
        'editor_changed',
        'Goodreads review or reading history changed during synchronization. Existing content was preserved.',
      );
    const tree = [
      '',
      {
        children: [
          'review',
          { children: ['edit', { children: [['id', book.id, 'd'], { children: ['__PAGE__', {}, null, null] }, null, null] }] },
          null,
          null,
        ],
      },
      null,
      null,
      true,
    ];
    await this.request(session, `/review/edit/${book.id}`, {
      method: 'POST',
      headers: {
        Accept: 'text/x-component',
        'Content-Type': 'text/plain;charset=UTF-8',
        'Next-Action': action,
        'Next-Router-State-Tree': encodeURIComponent(JSON.stringify(tree)),
        Origin: ORIGIN,
        Referer: `${ORIGIN}/review/edit/${book.id}`,
      },
      body: JSON.stringify([
        {
          bookId: editor.internalId,
          reviewText: preserved.userFormattedText,
          privateNotes: preserved.initialPrivateNotes,
          spoilerStatus: preserved.spoilerStatus,
          isOwnedEdition: preserved.isAlreadyOwned,
          postToBlog: false,
          addToUpdateFeed: false,
          readingSessions: editor.sessions.map((read) => (read === current ? updated : read)),
          initialReadingSessions: editor.sessions,
        },
        '/review/edit/[id]',
      ]),
    });
    const verified = await this.editor(session, book);
    const saved = verified.sessions?.find((read) => read.id === current.id);
    if (
      !saved ||
      (changes.startedOn && fullDate(saved.startedDate) !== changes.startedOn) ||
      (changes.finishedOn && fullDate(saved.endedDate) !== changes.finishedOn)
    )
      throw new ProviderFailure('unconfirmed_dates', 'Goodreads did not confirm saving the reading dates.', false, false, true);
  }
}
