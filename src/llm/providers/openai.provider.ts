// OpenAI LLM 공급자 — openai SDK v6

import type {
  LlmProvider,
  LlmProviderRequest,
  LlmProviderResponse,
} from '../types/index.js';
import type { LlmConfig } from '../types/index.js';

export class OpenAIProvider implements LlmProvider {
  readonly name = 'openai';
  private client: import('openai').default | null = null;

  constructor(private readonly config: LlmConfig) {}

  private getClient(): import('openai').default {
    if (!this.client) {
      // Dynamic import 대신 require 사용 — openai는 CommonJS 호환
      // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access
      const OpenAI = require('openai').default;
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call
      this.client = new OpenAI({
        apiKey: this.config.openaiApiKey,
        timeout: this.config.timeoutMs,
      });
    }
    return this.client!;
  }

  async generate(request: LlmProviderRequest): Promise<LlmProviderResponse> {
    const start = Date.now();
    const model = request.model ?? this.config.openaiModel;

    const client = this.getClient();
    const completion = await client.chat.completions.create({
      model,
      messages: request.messages.map((m) => ({
        role: m.role,
        content: m.content,
      })),
      max_tokens: request.maxTokens,
      temperature: request.temperature,
    });

    const choice = completion.choices[0];
    const text = choice?.message?.content ?? '';

    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-explicit-any
    const cachedTokens = (completion.usage as any)?.prompt_tokens_details?.cached_tokens ?? 0;

    return {
      text,
      model: completion.model,
      promptTokens: completion.usage?.prompt_tokens ?? 0,
      completionTokens: completion.usage?.completion_tokens ?? 0,
      cachedTokens: cachedTokens as number,
      latencyMs: Date.now() - start,
    };
  }

  isAvailable(): boolean {
    return !!this.config.openaiApiKey;
  }
}
