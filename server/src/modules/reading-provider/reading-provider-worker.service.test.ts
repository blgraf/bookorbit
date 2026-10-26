import {
  AchievementEventsService,
  ACHIEVEMENT_EVENT_BOOK_PROGRESS_CHANGED,
  ACHIEVEMENT_EVENT_BOOK_STATUS_CHANGED,
  ACHIEVEMENT_EVENT_READING_SESSION_SAVED,
  ACHIEVEMENT_EVENT_BOOK_RATING_CHANGED,
} from '../achievement/achievement-events.service';
import { ReadingProviderWorker } from './reading-provider-worker.service';
import { ReadingProviderRepository } from './reading-provider.repository';
import { ReadingProviderService } from './reading-provider.service';
function fixture() {
  const events = new AchievementEventsService();
  const enqueueAutomatic = vi.fn().mockResolvedValue(undefined);
  const repo = { bookIdForFile: vi.fn().mockResolvedValue(3), claim: vi.fn().mockResolvedValue(null) };
  const sync = { enqueueAutomatic, process: vi.fn() };
  const worker = new ReadingProviderWorker(events, repo as unknown as ReadingProviderRepository, sync as unknown as ReadingProviderService);
  worker.onModuleInit();
  return { events, enqueueAutomatic, repo, sync, worker };
}
describe('source-independent reading events', () => {
  it.each(['web_reader', 'kobo', 'koreader'])('queues progress from %s without persisting an old event percentage', (source) => {
    const f = fixture();
    f.events.emit(ACHIEVEMENT_EVENT_BOOK_PROGRESS_CHANGED, { userId: 2, bookId: 3, progress: 10, source });
    expect(f.enqueueAutomatic).toHaveBeenCalledExactlyOnceWith(2, 3);
    f.worker.onModuleDestroy();
  });
  it('queues status and rating changes with the owning user', async () => {
    const f = fixture();
    f.events.emit(ACHIEVEMENT_EVENT_BOOK_STATUS_CHANGED, { userId: 2, bookId: 3, newStatus: 'read' });
    f.events.emit(ACHIEVEMENT_EVENT_BOOK_RATING_CHANGED, { userId: 2, bookIds: [3, 4], rating: 5 });
    await vi.waitFor(() => expect(f.enqueueAutomatic).toHaveBeenCalledWith(2, 4));
    f.worker.onModuleDestroy();
  });
  it('resolves reading-session file IDs to books', async () => {
    const f = fixture();
    f.events.emit(ACHIEVEMENT_EVENT_READING_SESSION_SAVED, { userId: 2, bookFileId: 8 });
    await vi.waitFor(() => expect(f.enqueueAutomatic).toHaveBeenCalledWith(2, 3));
    expect(f.repo.bookIdForFile).toHaveBeenCalledWith(8);
    f.worker.onModuleDestroy();
  });
  it('does not leave listeners or start work after shutdown', async () => {
    const f = fixture();
    f.worker.onModuleDestroy();
    f.events.emit(ACHIEVEMENT_EVENT_BOOK_PROGRESS_CHANGED, { userId: 2, bookId: 3 });
    await f.worker.tick();
    expect(f.enqueueAutomatic).not.toHaveBeenCalled();
    expect(f.repo.claim).not.toHaveBeenCalled();
  });
});
