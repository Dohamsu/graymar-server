// Claude LLM 공급자 — @anthropic-ai/sdk
//
// 변환 로직:
// - OpenAI의 system 메시지 -> Anthropic API의 top-level system 파라미터로 분리
// - messages에서 system role 제거, user/assistant만 전달
// - cacheControl: 'ephemeral' → cache_control: { type: 'ephemeral' } 변환
// - response: content[0].text, usage.input_tokens, usage.output_tokens

import type {
  LlmProvider,
  LlmProviderRequest,
  LlmProviderResponse,
} from '../types/index.js';
import type { LlmConfig } from '../types/index.js';

// Extended thinking 지원 모델 판별 (claude-3-7-sonnet, claude-4 계열 등)
const isExtendedThinkingModel = (model: string) =>
  /^claude-(3-7|4|sonnet-4|opus-4)/.test(model);

export class ClaudeProvider implements LlmProvider {
  readonly name = 'claude';
  private client: any = null;

  constructor(private readonly config: LlmConfig) {}

  private getClient(): any {
    if (!this.client) {
      // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-unsafe-assignment
      const { default: Anthropic } = require('@anthropic-ai/sdk');
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call
      this.client = new Anthropic({
        apiKey: this.config.claudeApiKey,
        timeout: this.config.timeoutMs,
      });
    }
    return this.client;
  }

  async generate(request: LlmProviderRequest): Promise<LlmProviderResponse> {
    const start = Date.now();
    const model = request.model ?? this.config.claudeModel;
    const client = this.getClient();

    // system 메시지 분리 → top-level system 파라미터
    const systemMessages = request.messages.filter((m) => m.role === 'system');
    const nonSystemMessages = request.messages.filter((m) => m.role !== 'system');

    // system 블록 구성 (cache_control 지원)
    const systemBlocks = systemMessages.map((m) => ({
      type: 'text' as const,
      text: m.content,
      ...(m.cacheControl ? { cache_control: { type: 'ephemeral' as const } } : {}),
    }));

    // user/assistant 메시지 변환
    const messages = nonSystemMessages.map((m) => ({
      role: m.role as 'user' | 'assistant',
      content: m.content,
    }));

    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call
    const response = await client.messages.create({
      model,
      max_tokens: request.maxTokens,
      temperature: request.temperature,
      ...(systemBlocks.length > 0 ? { system: systemBlocks } : {}),
      messages,
    });

    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    const textBlock = response.content?.find((b: any) => b.type === 'text');
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    const text: string = textBlock?.text ?? '';
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    const usage = response.usage ?? {};

    if (!text) {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
      console.warn(`[ClaudeProvider] Empty text. stop_reason: ${response.stop_reason}, model: ${response.model}`);
    }

    return {
      text,
      // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
      model: response.model ?? model,
      // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
      promptTokens: usage.input_tokens ?? 0,
      // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
      completionTokens: usage.output_tokens ?? 0,
      // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
      cachedTokens: usage.cache_read_input_tokens ?? 0,
      // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
      cacheCreationTokens: usage.cache_creation_input_tokens ?? 0,
      latencyMs: Date.now() - start,
    };
  }

  isAvailable(): boolean {
    return !!this.config.claudeApiKey;
  }
}
