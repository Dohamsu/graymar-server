import { Module } from '@nestjs/common';
import { EngineModule } from '../engine/engine.module.js';
import { LlmModule } from '../llm/llm.module.js';
import { LlmIntentParserService } from '../engine/hub/llm-intent-parser.service.js';
import { TurnsController } from './turns.controller.js';
import { TurnsService } from './turns.service.js';

@Module({
  imports: [EngineModule, LlmModule],
  controllers: [TurnsController],
  providers: [TurnsService, LlmIntentParserService],
  exports: [TurnsService],
})
export class TurnsModule {}
