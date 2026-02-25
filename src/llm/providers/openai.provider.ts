// OpenAI LLM 공급자 — openai SDK v6
// GPT-5/o-series reasoning 모델: Responses API 사용
// GPT-4o 등 기존 모델: Chat Completions API 사용

import type {
  LlmProvider,
  LlmProviderRequest,
  LlmProviderResponse,
} from '../types/index.js';
import type { LlmConfig } from '../types/index.js';

// GPT-5, o1, o3 등 reasoning 모델 판별
const isReasoningModel = (model: string) => /^(gpt-5|o[1-9])/.test(model);

export class OpenAIProvider implements LlmProvider {
  readonly name = 'openai';
  private client: import('openai').default | null = null;

  constructor(private readonly config: LlmConfig) {}

  private getClient(): import('openai').default {
    if (!this.client) {
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
    const model = request.model ?? this.config.openaiModel;

    if (isReasoningModel(model)) {
      return this.generateWithResponses(request, model);
    }
    return this.generateWithChatCompletions(request, model);
  }

  /** Responses API — GPT-5/o-series reasoning 모델용 */
  private async generateWithResponses(
    request: LlmProviderRequest,
    model: string,
  ): Promise<LlmProviderResponse> {
    const start = Date.now();
    const client = this.getClient();

    const input = request.messages.map((m) => ({
      role: m.role as 'system' | 'user' | 'assistant',
      content: m.content,
    }));

    // reasoning 모델은 max_output_tokens에 추론 토큰이 포함되므로 effort에 따라 배율 조정
    const effort = request.reasoningEffort ?? 'medium';
    const budgetMultiplier = effort === 'low' ? 3 : effort === 'medium' ? 5 : 8;
    const reasoningBudget = Math.max(request.maxTokens * budgetMultiplier, 4096);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const response: any = await client.responses.create({
      model,
      input,
      max_output_tokens: reasoningBudget,
      reasoning: { effort },
    });

    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    const text: string = response.output_text ?? '';
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    const usage = response.usage ?? {};

    if (!text) {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
      console.warn(`[OpenAIProvider/Responses] Empty output_text. Status: ${response.status}, model: ${response.model}`);
    }

    return {
      text,
      // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
      model: response.model ?? model,
      // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
      promptTokens: usage.input_tokens ?? 0,
      // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
      completionTokens: usage.output_tokens ?? 0,
      cachedTokens: 0,
      latencyMs: Date.now() - start,
    };
  }

  /** Chat Completions API — GPT-4o 등 기존 모델용 */
  private async generateWithChatCompletions(
    request: LlmProviderRequest,
    model: string,
  ): Promise<LlmProviderResponse> {
    const start = Date.now();
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
