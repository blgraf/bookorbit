import { Controller } from '@nestjs/common';
import { Permission } from '@bookorbit/types';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';
import { ReadingProviderController } from '../reading-provider/reading-provider.controller';
import { ReadingProviderService } from '../reading-provider/reading-provider.service';
@Controller('goodreads')
@RequirePermission(Permission.GoodreadsSync)
export class GoodreadsController extends ReadingProviderController {
  constructor(sync: ReadingProviderService) {
    super('goodreads', sync);
  }
}
