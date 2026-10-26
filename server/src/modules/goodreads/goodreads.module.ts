import { Module } from '@nestjs/common';
import { ProviderHttpService } from '../reading-provider/provider-http.service';
import { GoodreadsClientService } from './goodreads-client.service';
@Module({ providers: [ProviderHttpService, GoodreadsClientService], exports: [GoodreadsClientService] })
export class GoodreadsModule {}
