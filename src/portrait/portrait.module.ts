import { Module } from '@nestjs/common';
import { PortraitController } from './portrait.controller.js';
import { PortraitService } from './portrait.service.js';

@Module({
  controllers: [PortraitController],
  providers: [PortraitService],
  exports: [PortraitService],
})
export class PortraitModule {}
