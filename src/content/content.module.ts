import { Global, Module } from '@nestjs/common';
import { ContentLoaderService } from './content-loader.service.js';
import { ScenariosController } from './scenarios.controller.js';
import { ContentValidatorService } from './content-validator.service.js';
import { EventContentProvider } from './event-content.provider.js';

@Global()
@Module({
  controllers: [ScenariosController],
  providers: [
    ContentLoaderService,
    ContentValidatorService,
    EventContentProvider,
  ],
  exports: [
    ContentLoaderService,
    ContentValidatorService,
    EventContentProvider,
  ],
})
export class ContentModule {}
