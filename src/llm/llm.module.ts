import { Module, type OnModuleInit } from '@nestjs/common';
import { ContextBuilderService } from './context-builder.service.js';
import { LlmWorkerService } from './llm-worker.service.js';
import { LlmConfigService } from './llm-config.service.js';
import { PromptBuilderService } from './prompts/prompt-builder.service.js';
import { LlmCallerService } from './llm-caller.service.js';
import { AiTurnLogService } from './ai-turn-log.service.js';
import { MemoryRendererService } from './memory-renderer.service.js';
import { LlmProviderRegistryService } from './providers/llm-provider-registry.service.js';
import { LlmSettingsController } from './llm-settings.controller.js';
import { MockProvider } from './providers/mock.provider.js';
import { OpenAIProvider } from './providers/openai.provider.js';
import { ClaudeProvider } from './providers/claude.provider.js';
import { GeminiProvider } from './providers/gemini.provider.js';
import { HubEngineModule } from '../engine/hub/hub-engine.module.js';
import { ContentModule } from '../content/content.module.js';

@Module({
  imports: [HubEngineModule, ContentModule],
  controllers: [LlmSettingsController],
  providers: [
    ContextBuilderService,
    LlmWorkerService,
    LlmConfigService,
    PromptBuilderService,
    LlmCallerService,
    AiTurnLogService,
    MemoryRendererService,
    LlmProviderRegistryService,
  ],
  exports: [ContextBuilderService, LlmConfigService, LlmCallerService],
})
export class LlmModule implements OnModuleInit {
  constructor(
    private readonly registry: LlmProviderRegistryService,
    private readonly configService: LlmConfigService,
  ) {}

  onModuleInit(): void {
    const config = this.configService.get();

    this.registry.register(new MockProvider());
    this.registry.register(new OpenAIProvider(config));
    this.registry.register(new ClaudeProvider(config));
    this.registry.register(new GeminiProvider(config));
  }
}
