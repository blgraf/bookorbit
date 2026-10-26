import { Body, Delete, Get, Param, ParseIntPipe, Patch, Post, Query } from '@nestjs/common';
import type { ReadingProvider } from '@bookorbit/types';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { RequestUser } from '../../common/types/request-user';
import { ReadingProviderService } from './reading-provider.service';
import {
  ConnectReadingProviderDto,
  EnableReadingProviderDto,
  ExcludeReadingProviderBookDto,
  LinkReadingProviderBookDto,
} from './reading-provider.dto';

export abstract class ReadingProviderController {
  constructor(
    private readonly provider: ReadingProvider,
    protected readonly sync: ReadingProviderService,
  ) {}
  @Get('settings') settings(@CurrentUser() user: RequestUser) {
    return this.sync.settings(user.id, this.provider);
  }
  @Post('connect') connect(@CurrentUser() user: RequestUser, @Body() dto: ConnectReadingProviderDto) {
    return this.sync.connect(user.id, this.provider, dto);
  }
  @Post('validate') validate(@CurrentUser() user: RequestUser) {
    return this.sync.validate(user.id, this.provider);
  }
  @Patch('settings') enabled(@CurrentUser() user: RequestUser, @Body() dto: EnableReadingProviderDto) {
    return this.sync.setEnabled(user.id, this.provider, dto.enabled);
  }
  @Delete('settings') disconnect(@CurrentUser() user: RequestUser) {
    return this.sync.disconnect(user.id, this.provider);
  }
  @Post('sync') syncAll(@CurrentUser() user: RequestUser) {
    return this.sync.bulk(user.id, this.provider, true);
  }
  @Delete('sync') cancel(@CurrentUser() user: RequestUser) {
    return this.sync.bulk(user.id, this.provider, false);
  }
  @Get('sync/status') summary(@CurrentUser() user: RequestUser) {
    return this.sync.summary(user.id, this.provider);
  }
  @Get('books') books(@CurrentUser() user: RequestUser, @Query('after', new ParseIntPipe({ optional: true })) after?: number) {
    return this.sync.listBooks(user.id, this.provider, Math.max(0, after ?? 0));
  }
  @Get('books/:bookId') book(@CurrentUser() user: RequestUser, @Param('bookId', ParseIntPipe) bookId: number) {
    return this.sync.bookState(user.id, this.provider, bookId);
  }
  @Patch('books/:bookId') exclude(
    @CurrentUser() user: RequestUser,
    @Param('bookId', ParseIntPipe) bookId: number,
    @Body() dto: ExcludeReadingProviderBookDto,
  ) {
    return this.sync.exclude(user.id, this.provider, bookId, dto.excluded);
  }
  @Post('books/:bookId/sync') syncBook(@CurrentUser() user: RequestUser, @Param('bookId', ParseIntPipe) bookId: number) {
    return this.sync.queueBook(user.id, this.provider, bookId);
  }
  @Get('books/:bookId/candidates') candidates(
    @CurrentUser() user: RequestUser,
    @Param('bookId', ParseIntPipe) bookId: number,
    @Query('q') query: string,
  ) {
    return this.sync.candidates(user.id, this.provider, bookId, (query ?? '').slice(0, 300));
  }
  @Patch('books/:bookId/link') link(
    @CurrentUser() user: RequestUser,
    @Param('bookId', ParseIntPipe) bookId: number,
    @Body() dto: LinkReadingProviderBookDto,
  ) {
    return this.sync.link(user.id, this.provider, bookId, dto.resourceId);
  }
}
