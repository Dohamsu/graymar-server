// LLM 설정 서비스 — .env 기본값 + 런타임 변경 지원

import { Injectable, Logger } from '@nestjs/common';
import type { LlmConfig } from './types/index.js';

/** PATCH /v1/settings/llm 에서 변경 가능한 필드 */
export type LlmConfigPatch = Partial<
  Pick<
    LlmConfig,
    | 'provider'
    | 'openaiModel'
    | 'claudeModel'
    | 'geminiModel'
    | 'maxRetries'
    | 'timeoutMs'
    | 'maxTokens'
    | 'temperature'
    | 'fallbackProvider'
  >
>;

/** GET 응답 — API 키는 마스킹 처리 */
export interface LlmConfigPublic {
  provider: string;
  openaiModel: string;
  openaiApiKeySet: boolean;
  claudeModel: string;
  claudeApiKeySet: boolean;
  geminiModel: string;
  geminiApiKeySet: boolean;
  maxRetries: number;
  timeoutMs: number;
  maxTokens: number;
  temperature: number;
  fallbackProvider: string;
  availableProviders: string[];
}

@Injectable()
export class LlmConfigService {
  private readonly logger = new Logger(LlmConfigService.name);
  private config: LlmConfig;

  constructor() {
    this.config = {
      provider: process.env.LLM_PROVIDER ?? 'mock',
      openaiApiKey: process.env.OPENAI_API_KEY ?? '',
      openaiModel: process.env.OPENAI_MODEL ?? 'gpt-4o',
      claudeApiKey: process.env.CLAUDE_API_KEY ?? '',
      claudeModel: process.env.CLAUDE_MODEL ?? 'claude-sonnet-4-5-20250929',
      geminiApiKey: process.env.GEMINI_API_KEY ?? '',
      geminiModel: process.env.GEMINI_MODEL ?? 'gemini-2.0-flash',
      maxRetries: parseInt(process.env.LLM_MAX_RETRIES ?? '2', 10),
      timeoutMs: parseInt(process.env.LLM_TIMEOUT_MS ?? '8000', 10),
      maxTokens: parseInt(process.env.LLM_MAX_TOKENS ?? '1024', 10),
      temperature: parseFloat(process.env.LLM_TEMPERATURE ?? '0.8'),
      fallbackProvider: process.env.LLM_FALLBACK_PROVIDER ?? 'mock',
    };
  }

  get(): LlmConfig {
    return this.config;
  }

  /** 런타임 설정 변경 — 다음 poll 사이클부터 반영 */
  update(patch: LlmConfigPatch): LlmConfig {
    this.config = { ...this.config, ...patch };
    this.logger.log(`LLM config updated: ${JSON.stringify(patch)}`);
    return this.config;
  }

  /** API 키를 마스킹한 공개용 설정 반환 */
  getPublic(): LlmConfigPublic {
    return {
      provider: this.config.provider,
      openaiModel: this.config.openaiModel,
      openaiApiKeySet: !!this.config.openaiApiKey,
      claudeModel: this.config.claudeModel,
      claudeApiKeySet: !!this.config.claudeApiKey,
      geminiModel: this.config.geminiModel,
      geminiApiKeySet: !!this.config.geminiApiKey,
      maxRetries: this.config.maxRetries,
      timeoutMs: this.config.timeoutMs,
      maxTokens: this.config.maxTokens,
      temperature: this.config.temperature,
      fallbackProvider: this.config.fallbackProvider,
      availableProviders: this.getAvailableProviders(),
    };
  }

  private getAvailableProviders(): string[] {
    const providers = ['mock'];
    if (this.config.openaiApiKey) providers.push('openai');
    if (this.config.claudeApiKey) providers.push('claude');
    if (this.config.geminiApiKey) providers.push('gemini');
    return providers;
  }
}
