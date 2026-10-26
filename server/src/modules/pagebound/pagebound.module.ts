import { Module } from '@nestjs/common';
import { ProviderHttpService } from '../reading-provider/provider-http.service';
import { PageboundClientService } from './pagebound-client.service';
@Module({ providers: [ProviderHttpService, PageboundClientService], exports: [PageboundClientService] })
export class PageboundModule {}
