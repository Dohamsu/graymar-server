// LLM 공급자 레지스트리 — Strategy 패턴으로 공급자 관리

import { Injectable, Logger } from '@nestjs/common';
import type { LlmProvider } from '../types/index.js';
import { LlmConfigService } from '../llm-config.service.js';

@Injectable()
export class LlmProviderRegistryService {
  private readonly logger = new Logger(LlmProviderRegistryService.name);
  private readonly providers = new Map<string, LlmProvider>();

  constructor(private readonly configService: LlmConfigService) {}

  register(provider: LlmProvider): void {
    this.providers.set(provider.name, provider);
    this.logger.log(
      `Registered LLM provider: ${provider.name} (available: ${provider.isAvailable()})`,
    );
  }

  getPrimary(): LlmProvider {
    const name = this.configService.get().provider;
    const provider = this.providers.get(name);
    if (!provider) {
      throw new Error(`LLM provider "${name}" not registered`);
    }
    return provider;
  }

  getFallback(): LlmProvider {
    const name = this.configService.get().fallbackProvider;
    const provider = this.providers.get(name);
    if (!provider) {
      throw new Error(`Fallback LLM provider "${name}" not registered`);
    }
    return provider;
  }

  getByName(name: string): LlmProvider | undefined {
    return this.providers.get(name);
  }
}
