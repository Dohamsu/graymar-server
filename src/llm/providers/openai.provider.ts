// OpenAI LLM 공급자 — openai SDK v6
// GPT-5/o-series reasoning 모델: Responses API 사용
// GPT-4o 등 기존 모델: Chat Completions API 사용

import type {
  LlmProvider,
  LlmProviderRequest,
  LlmProviderResponse,
} from '../types/index.js';
import type { LlmConfig } from '../types/index.js';

/** Responses API 응답 타입 (필요 필드만 정의) */
interface ResponsesApiResponse {
  output_text?: string;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
  };
  status?: string;
  model?: string;
}

// GPT-5, o1, o3 등 reasoning 모델 판별 (nano는 reasoning 미지원 → Chat Completions 사용)
const isReasoningModel = (model: string) =>
  /^(gpt-5|o[1-9])/.test(model) && !model.includes('nano');

export class OpenAIProvider implements LlmProvider {
  readonly name = 'openai';
  private client: import('openai').default | null = null;

  constructor(private readonly config: LlmConfig) {}

  private getClient(): import('openai').default {
    if (!this.client) {
      /* eslint-disable @typescript-eslint/no-require-imports */
      const OpenAI = (
        require('openai') as {
          default: new (opts: {
            apiKey?: string;
            baseURL?: string;
            timeout?: number;
          }) => import('openai').default;
        }
      ).default;
      /* eslint-enable @typescript-eslint/no-require-imports */
      this.client = new OpenAI({
        apiKey: this.config.openaiApiKey,
        ...(this.config.openaiBaseUrl ? { baseURL: this.config.openaiBaseUrl } : {}),
        timeout: this.config.timeoutMs,
      });
    }
    return this.client;
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
      role: m.role,
      content: m.content,
    }));

    // reasoning 모델은 max_output_tokens에 추론 토큰이 포함되므로 effort에 따라 배율 조정
    const effort = request.reasoningEffort ?? 'medium';
    const budgetMultiplier = effort === 'low' ? 3 : effort === 'medium' ? 5 : 8;
    const reasoningBudget = Math.max(
      request.maxTokens * budgetMultiplier,
      4096,
    );

    const response = (await client.responses.create({
      model,
      input,
      max_output_tokens: reasoningBudget,
      reasoning: { effort },
    })) as unknown as ResponsesApiResponse;

    const text: string = response.output_text ?? '';
    const usage = response.usage ?? {};

    if (!text) {
      console.warn(
        `[OpenAIProvider/Responses] Empty output_text. Status: ${String(response.status)}, model: ${String(response.model)}`,
      );
    }

    return {
      text,
      model: response.model ?? model,
      promptTokens: usage.input_tokens ?? 0,
      completionTokens: usage.output_tokens ?? 0,
      cachedTokens: 0,
      cacheCreationTokens: 0,
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

    // GPT-5 계열은 max_completion_tokens, 이전 모델은 max_tokens
    const isGpt5 = /^gpt-5/.test(model);
    const completion = await client.chat.completions.create({
      model,
      messages: request.messages.map((m) => ({
        role: m.role,
        content: m.content,
      })),
      ...(isGpt5
        ? { max_completion_tokens: request.maxTokens }
        : { max_tokens: request.maxTokens }),
      temperature: request.temperature,
    });

    const choice = completion.choices[0];
    const text = choice?.message?.content ?? '';

    const usageWithDetails = completion.usage as
      | (typeof completion.usage & {
          prompt_tokens_details?: { cached_tokens?: number };
        })
      | undefined;
    const cachedTokens =
      usageWithDetails?.prompt_tokens_details?.cached_tokens ?? 0;

    return {
      text,
      model: completion.model,
      promptTokens: completion.usage?.prompt_tokens ?? 0,
      completionTokens: completion.usage?.completion_tokens ?? 0,
      cachedTokens,
      cacheCreationTokens: 0,
      latencyMs: Date.now() - start,
    };
  }

  isAvailable(): boolean {
    return !!this.config.openaiApiKey;
  }
}
