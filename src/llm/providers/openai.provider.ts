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

  constructor(
    private readonly config: LlmConfig,
    private readonly configGetter?: () => LlmConfig,
  ) {}

  /** 런타임 최신 config 반환 (configGetter가 있으면 live, 없으면 초기 스냅샷) */
  private liveConfig(): LlmConfig {
    return this.configGetter ? this.configGetter() : this.config;
  }

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
        ...(this.config.openaiBaseUrl
          ? { baseURL: this.config.openaiBaseUrl }
          : {}),
        timeout: this.config.timeoutMs,
      });
    }
    return this.client;
  }

  async generate(request: LlmProviderRequest): Promise<LlmProviderResponse> {
    const model = request.model ?? this.liveConfig().openaiModel;

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
      costUsd: 0,
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
    // OpenRouter 라우팅 최적화: provider 고정 + 레이턴시 우선 정렬
    const isOpenRouter = !!this.config.openaiBaseUrl?.includes('openrouter');
    const openRouterParams = isOpenRouter
      ? {
          provider: {
            sort: 'latency' as const,
            allow_fallbacks: true,
          },
          // Gemini 2.5 Flash: thinking(reasoning) 비활성화 — OpenRouter는 max_tokens: 0으로 제어
          ...(model.includes('gemini')
            ? {
                reasoning: {
                  max_tokens: parseInt(
                    process.env.GEMINI_REASONING_MAX_TOKENS ?? '0',
                    10,
                  ),
                },
              }
            : {}),
        }
      : {};
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
      ...(request.responseFormat === 'json_object'
        ? { response_format: { type: 'json_object' as const } }
        : {}),
      ...openRouterParams,
    } as any);

    const choice = completion.choices[0];
    const text = choice?.message?.content ?? '';

    const usageWithDetails = completion.usage as
      | (typeof completion.usage & {
          prompt_tokens_details?: { cached_tokens?: number };
          cost?: number;
        })
      | undefined;
    const cachedTokens =
      usageWithDetails?.prompt_tokens_details?.cached_tokens ?? 0;

    // OpenRouter: usage.cost 필드에서 USD 비용 추출
    const costUsd = usageWithDetails?.cost ?? 0;

    return {
      text,
      model: completion.model,
      promptTokens: completion.usage?.prompt_tokens ?? 0,
      completionTokens: completion.usage?.completion_tokens ?? 0,
      cachedTokens,
      cacheCreationTokens: 0,
      latencyMs: Date.now() - start,
      costUsd,
    };
  }

  /**
   * 스트리밍 생성 — 토큰을 AsyncGenerator로 반환
   * 각 yield는 텍스트 청크 (1~수십 글자)
   * 최종 usage 정보는 마지막에 반환
   */
  async *generateStream(
    request: LlmProviderRequest,
    model: string,
  ): AsyncGenerator<
    | { type: 'token'; text: string }
    | { type: 'done'; response: LlmProviderResponse }
  > {
    const start = Date.now();
    const client = this.getClient();

    const isOpenRouter = !!this.config.openaiBaseUrl?.includes('openrouter');
    const openRouterParams = isOpenRouter
      ? {
          provider: {
            sort: 'latency' as const,
            allow_fallbacks: true,
          },
          ...(model.includes('gemini')
            ? {
                reasoning: {
                  max_tokens: parseInt(
                    process.env.GEMINI_REASONING_MAX_TOKENS ?? '0',
                    10,
                  ),
                },
              }
            : {}),
        }
      : {};

    const stream = await client.chat.completions.create({
      model,
      messages: request.messages.map((m) => ({
        role: m.role,
        content: m.content,
      })),
      max_tokens: request.maxTokens,
      temperature: request.temperature,
      stream: true,
      stream_options: { include_usage: true },
      ...(request.responseFormat === 'json_object'
        ? { response_format: { type: 'json_object' as const } }
        : {}),
      ...openRouterParams,
    } as any);

    let fullText = '';
    let promptTokens = 0;
    let completionTokens = 0;
    let cachedTokens = 0;
    let costUsd = 0;
    let modelUsed = model;

    for await (const chunk of stream as any) {
      const delta = chunk.choices?.[0]?.delta?.content;
      if (delta) {
        fullText += delta;
        yield { type: 'token', text: delta };
      }

      // 마지막 청크에 usage 정보
      if (chunk.usage) {
        promptTokens = chunk.usage.prompt_tokens ?? 0;
        completionTokens = chunk.usage.completion_tokens ?? 0;
        cachedTokens = chunk.usage.prompt_tokens_details?.cached_tokens ?? 0;
        costUsd = chunk.usage.cost ?? 0;
      }
      if (chunk.model) {
        modelUsed = chunk.model;
      }
    }

    yield {
      type: 'done',
      response: {
        text: fullText,
        model: modelUsed,
        promptTokens,
        completionTokens,
        cachedTokens,
        cacheCreationTokens: 0,
        latencyMs: Date.now() - start,
        costUsd,
      },
    };
  }

  isAvailable(): boolean {
    return !!this.config.openaiApiKey;
  }
}
