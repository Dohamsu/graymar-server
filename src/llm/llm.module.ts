import { Module } from '@nestjs/common';
import { ContextBuilderService } from './context-builder.service.js';
import { LlmWorkerService } from './llm-worker.service.js';

@Module({
  providers: [ContextBuilderService, LlmWorkerService],
  exports: [ContextBuilderService],
})
export class LlmModule {}
