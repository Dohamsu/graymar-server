import { Global, Module } from '@nestjs/common';
import { ContentLoaderService } from './content-loader.service.js';
import { EventContentProvider } from './event-content.provider.js';

@Global()
@Module({
  providers: [ContentLoaderService, EventContentProvider],
  exports: [ContentLoaderService, EventContentProvider],
})
export class ContentModule {}
