import { Module, type OnModuleInit } from '@nestjs/common';
import { ContextBuilderService } from './context-builder.service.js';
import { LlmWorkerService } from './llm-worker.service.js';
import { LlmConfigService } from './llm-config.service.js';
import { PromptBuilderService } from './prompts/prompt-builder.service.js';
import { LlmCallerService } from './llm-caller.service.js';
import { AiTurnLogService } from './ai-turn-log.service.js';
import { MemoryRendererService } from './memory-renderer.service.js';
import { TokenBudgetService } from './token-budget.service.js';
import { MidSummaryService } from './mid-summary.service.js';
import { LlmProviderRegistryService } from './providers/llm-provider-registry.service.js';
import { LlmSettingsController } from './llm-settings.controller.js';
import { MockProvider } from './providers/mock.provider.js';
import { OpenAIProvider } from './providers/openai.provider.js';
import { ClaudeProvider } from './providers/claude.provider.js';
import { GeminiProvider } from './providers/gemini.provider.js';
import { NpcDialogueMarkerService } from './npc-dialogue-marker.service.js';
import { NanoDirectorService } from './nano-director.service.js';
import { NanoEventDirectorService } from './nano-event-director.service.js';
import { FactExtractorService } from './fact-extractor.service.js';
import { DialogueGeneratorService } from './dialogue-generator.service.js';
import { LorebookService } from './lorebook.service.js';
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
    TokenBudgetService,
    MidSummaryService,
    LlmProviderRegistryService,
    NpcDialogueMarkerService,
    NanoDirectorService,
    NanoEventDirectorService,
    FactExtractorService,
    DialogueGeneratorService,
    LorebookService,
  ],
  exports: [
    ContextBuilderService,
    LlmConfigService,
    LlmCallerService,
    LlmProviderRegistryService,
    NanoEventDirectorService,
    FactExtractorService,
  ],
})
export class LlmModule implements OnModuleInit {
  constructor(
    private readonly registry: LlmProviderRegistryService,
    private readonly configService: LlmConfigService,
  ) {}

  onModuleInit(): void {
    const config = this.configService.get();

    this.registry.register(new MockProvider());
    this.registry.register(new OpenAIProvider(config, () => this.configService.get()));
    this.registry.register(new ClaudeProvider(config));
    this.registry.register(new GeminiProvider(config));
  }
}
