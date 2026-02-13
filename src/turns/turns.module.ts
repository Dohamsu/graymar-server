import { Module } from '@nestjs/common';
import { EngineModule } from '../engine/engine.module.js';
import { TurnsController } from './turns.controller.js';
import { TurnsService } from './turns.service.js';

@Module({
  imports: [EngineModule],
  controllers: [TurnsController],
  providers: [TurnsService],
  exports: [TurnsService],
})
export class TurnsModule {}
