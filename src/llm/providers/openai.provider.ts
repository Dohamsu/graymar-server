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
    const openRouterParams = this.buildOpenRouterParams(model);
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
      providerName:
        ((completion as unknown as Record<string, unknown>).provider as
          | string
          | undefined) ?? undefined,
    };
  }

  /**
   * OpenRouter 라우팅 정책 (arch/62 — provider 온건 고정).
   * - sort: 기본 'throughput' (생성 tok/s 우선 — 'latency'는 접속 지연만 봐서
   *   10~14 tok/s 저속 생성 스파이크를 못 거름)
   * - ignore: 저 uptime provider 배제 (기본 cloudflare, dekallm — 30분 uptime 69%대 실측)
   * - allow_fallbacks: true — 배제 목록 외 전체 폴백 허용 (가용성 유지)
   */
  private buildOpenRouterParams(model: string): Record<string, unknown> {
    const isOpenRouter = !!this.config.openaiBaseUrl?.includes('openrouter');
    if (!isOpenRouter) return {};
    const sort = process.env.LLM_PROVIDER_SORT ?? 'throughput';
    const ignore = (process.env.LLM_PROVIDER_IGNORE ?? 'cloudflare,dekallm')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    return {
      provider: {
        sort,
        allow_fallbacks: true,
        ...(ignore.length > 0 ? { ignore } : {}),
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

    const openRouterParams = this.buildOpenRouterParams(model);

    // 레이턴시 #4 — 첫 토큰 타임아웃: provider가 스트림은 열었지만 생성을 시작하지
    // 않는 간헐 지연(p95 41~51초의 주원인)을 조기 절단. 첫 콘텐츠 델타 전에만 작동
    // 하므로 토큰 중복 없이 caller의 non-stream fallback(재시도+fallback 모델)으로
    // 안전하게 넘어간다.
    const firstTokenTimeoutMs = parseInt(
      process.env.LLM_FIRST_TOKEN_TIMEOUT_MS ?? '5000',
      10,
    );
    const firstTokenAbort = new AbortController();

    const stream = await client.chat.completions.create(
      {
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
      } as any,
      { signal: firstTokenAbort.signal },
    );

    let fullText = '';
    let promptTokens = 0;
    let completionTokens = 0;
    let cachedTokens = 0;
    let costUsd = 0;
    let modelUsed = model;
    let providerName: string | undefined;

    let firstTokenTimedOut = false;
    let firstTokenTimer: ReturnType<typeof setTimeout> | null =
      firstTokenTimeoutMs > 0
        ? setTimeout(() => {
            firstTokenTimedOut = true;
            firstTokenAbort.abort();
          }, firstTokenTimeoutMs)
        : null;

    type RawStreamChunk = {
      choices?: Array<{ delta?: { content?: string | null } }>;
      usage?: {
        prompt_tokens?: number;
        completion_tokens?: number;
        prompt_tokens_details?: { cached_tokens?: number };
        cost?: number;
      };
      model?: string;
      /** OpenRouter — 실제 서빙 인프라 업체명 */
      provider?: string;
    };
    const iterator = (stream as unknown as AsyncIterable<RawStreamChunk>)[
      Symbol.asyncIterator
    ]();
    try {
      while (true) {
        let next: IteratorResult<RawStreamChunk>;
        try {
          next = await iterator.next();
        } catch (err) {
          if (firstTokenTimedOut) {
            throw new Error(
              `첫 토큰 타임아웃(${firstTokenTimeoutMs}ms) — model=${model}, non-stream fallback 전환`,
            );
          }
          throw err;
        }
        if (next.done) break;
        const chunk = next.value;
        const delta = chunk.choices?.[0]?.delta?.content;
        if (delta) {
          // 첫 콘텐츠 도착 — 타임아웃 해제
          if (firstTokenTimer) {
            clearTimeout(firstTokenTimer);
            firstTokenTimer = null;
          }
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
        if (chunk.provider) {
          providerName = chunk.provider;
        }
      }
    } finally {
      if (firstTokenTimer) clearTimeout(firstTokenTimer);
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
        providerName,
      },
    };
  }

  isAvailable(): boolean {
    return !!this.config.openaiApiKey;
  }
}
