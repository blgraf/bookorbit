import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import {
  AchievementEventsService,
  ACHIEVEMENT_EVENT_BOOK_PROGRESS_CHANGED,
  ACHIEVEMENT_EVENT_BOOK_STATUS_CHANGED,
  ACHIEVEMENT_EVENT_BOOK_RATING_CHANGED,
  ACHIEVEMENT_EVENT_READING_SESSION_SAVED,
  type BookProgressChangedPayload,
  type BookStatusChangedPayload,
  type BookRatingChangedPayload,
  type ReadingSessionSavedPayload,
} from '../achievement/achievement-events.service';
import { ReadingProviderRepository } from './reading-provider.repository';
import { ReadingProviderService } from './reading-provider.service';

@Injectable()
export class ReadingProviderWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ReadingProviderWorker.name);
  private running = false;
  private scanning = false;
  private stopping = false;
  private scanAfterUserId = 0;
  private readonly statusListener = (event: BookStatusChangedPayload | BookProgressChangedPayload) => {
    this.enqueue(event.userId, event.bookId);
  };
  private readonly ratingListener = (event: BookRatingChangedPayload) => {
    void this.enqueueRatings(event).catch(() => this.logFailure());
  };
  private readonly sessionListener = (event: ReadingSessionSavedPayload) => {
    void this.enqueueSession(event).catch(() => this.logFailure());
  };
  constructor(
    private readonly events: AchievementEventsService,
    private readonly repo: ReadingProviderRepository,
    private readonly sync: ReadingProviderService,
  ) {}
  onModuleInit() {
    this.events.on(ACHIEVEMENT_EVENT_BOOK_PROGRESS_CHANGED, this.statusListener);
    this.events.on(ACHIEVEMENT_EVENT_BOOK_STATUS_CHANGED, this.statusListener);
    this.events.on(ACHIEVEMENT_EVENT_BOOK_RATING_CHANGED, this.ratingListener);
    this.events.on(ACHIEVEMENT_EVENT_READING_SESSION_SAVED, this.sessionListener);
  }
  onModuleDestroy() {
    this.stopping = true;
    this.events.off(ACHIEVEMENT_EVENT_BOOK_PROGRESS_CHANGED, this.statusListener);
    this.events.off(ACHIEVEMENT_EVENT_BOOK_STATUS_CHANGED, this.statusListener);
    this.events.off(ACHIEVEMENT_EVENT_BOOK_RATING_CHANGED, this.ratingListener);
    this.events.off(ACHIEVEMENT_EVENT_READING_SESSION_SAVED, this.sessionListener);
  }
  private logFailure() {
    this.logger.warn('[reading_provider.queue] [fail] errorClass=QueueError - reading update could not be queued');
  }
  private enqueue(userId: number, bookId: number) {
    void this.sync.enqueueAutomatic(userId, bookId).catch(() => this.logFailure());
  }
  private async enqueueRatings(event: BookRatingChangedPayload) {
    for (const bookId of event.bookIds) await this.sync.enqueueAutomatic(event.userId, bookId);
  }
  private async enqueueSession(event: ReadingSessionSavedPayload) {
    const bookId = await this.repo.bookIdForFile(event.bookFileId);
    if (bookId) await this.sync.enqueueAutomatic(event.userId, bookId);
  }
  @Interval(1000)
  async tick() {
    if (this.running || this.stopping) return;
    this.running = true;
    try {
      const claim = await this.repo.claim();
      if (claim) await this.sync.process(claim);
    } catch {
      this.logFailure();
    } finally {
      this.running = false;
    }
  }
  @Interval(10_000)
  async scan() {
    if (this.scanning || this.stopping) return;
    this.scanning = true;
    try {
      const connections = await this.repo.connections(this.scanAfterUserId);
      this.scanAfterUserId = connections.length === 25 ? Math.max(0, connections[24]!.userId - 1) : 0;
      for (const connection of connections) {
        try {
          const user = await this.sync.user(connection.userId, connection.provider);
          const access = await this.sync.access(user);
          const changes = await this.repo.changedDates(connection);
          for (const change of changes) await this.sync.enqueueAutomatic(connection.userId, change.bookId);
          const last = changes.at(-1);
          if (last)
            await this.repo.patchConnection(connection.userId, connection.provider, connection.version, {
              dateCursorAt: last.updatedAt,
              dateCursorBookId: last.bookId,
            });
          if (!connection.bulkActive) continue;
          const books = await this.repo.accessibleBooks(connection.userId, access, connection.bulkAfterBookId);
          for (const book of books) {
            if (!(await this.repo.state(connection.userId, connection.provider, book.bookId))?.excluded)
              await this.repo.enqueue(connection.userId, connection.provider, book.bookId, 0, connection.version);
          }
          await this.repo.patchConnection(connection.userId, connection.provider, connection.version, {
            bulkAfterBookId: books.at(-1)?.bookId ?? connection.bulkAfterBookId,
            bulkActive: books.length === 50,
          });
        } catch {
          this.logFailure();
        }
      }
    } catch {
      this.logFailure();
    } finally {
      this.scanning = false;
    }
  }
}
