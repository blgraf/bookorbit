import { Module } from '@nestjs/common';
import { AchievementModule } from '../achievement/achievement.module';
import { BookModule } from '../book/book.module';
import { LibraryModule } from '../library/library.module';
import { UserModule } from '../user/user.module';
import { GoodreadsModule } from '../goodreads/goodreads.module';
import { GoodreadsController } from '../goodreads/goodreads.controller';
import { PageboundModule } from '../pagebound/pagebound.module';
import { PageboundController } from '../pagebound/pagebound.controller';
import { ProviderCredentialService } from './provider-credential.service';
import { ReadingProviderRepository } from './reading-provider.repository';
import { ReadingProviderService } from './reading-provider.service';
import { ReadingProviderWorker } from './reading-provider-worker.service';
@Module({
  imports: [AchievementModule, BookModule, LibraryModule, UserModule, GoodreadsModule, PageboundModule],
  controllers: [GoodreadsController, PageboundController],
  providers: [ProviderCredentialService, ReadingProviderRepository, ReadingProviderService, ReadingProviderWorker],
})
export class ReadingProviderModule {}
