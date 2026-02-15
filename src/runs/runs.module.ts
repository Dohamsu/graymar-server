import { Module } from '@nestjs/common';
import { EngineModule } from '../engine/engine.module.js';
import { RunsController } from './runs.controller.js';
import { RunsService } from './runs.service.js';

@Module({
  imports: [EngineModule],
  controllers: [RunsController],
  providers: [RunsService],
  exports: [RunsService],
})
export class RunsModule {}
