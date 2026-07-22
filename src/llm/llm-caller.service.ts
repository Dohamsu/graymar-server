// LLM 호출 서비스 — 재시도 + fallback 전략

import { Injectable, Logger } from '@nestjs/common';
import { LlmProviderRegistryService } from './providers/llm-provider-registry.service.js';
import { LlmConfigService } from './llm-config.service.js';
import { recordLlmCall } from './turn-context.js';
import type {
  LlmProviderRequest,
  LlmProviderResponse,
  LlmCallResult,
  ErrorCategory,
} from './types/index.js';

// 토큰 버킷 레이트 리미터 — OpenRouter 초당 요청 제한
class RateLimiter {
  private tokens: number;
  private lastRefill: number;
  private readonly maxTokens: number;
  private readonly refillRate: number; // tokens per second

  constructor(maxTokens: number, refillRate: number) {
    this.maxTokens = maxTokens;
    this.tokens = maxTokens;
    this.refillRate = refillRate;
    this.lastRefill = Date.now();
  }

  async acquire(): Promise<void> {
    this.refill();
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return;
    }
    // 토큰 부족 → 대기
    const waitMs = ((1 - this.tokens) / this.refillRate) * 1000;
    await new Promise((resolve) => setTimeout(resolve, Math.ceil(waitMs)));
    this.refill();
    this.tokens -= 1;
  }

  private refill(): void {
    const now = Date.now();
    const elapsed = (now - this.lastRefill) / 1000;
    this.tokens = Math.min(
      this.maxTokens,
      this.tokens + elapsed * this.refillRate,
    );
    this.lastRefill = now;
  }
}

@Injectable()
export class LlmCallerService {
  private readonly logger = new Logger(LlmCallerService.name);
  // 초당 3 요청, 버스트 10 — OpenRouter paid tier (200 req/min) 안전 마진
  private readonly rateLimiter = new RateLimiter(10, 3);

  constructor(
    private readonly registry: LlmProviderRegistryService,
    private readonly configService: LlmConfigService,
  ) {}

  /**
   * 턴 스코프(ALS)에 LLM 호출 실측 1건 누적 — 유닛 이코노미 측정용.
   * 스코프 밖 호출(타이머 등)은 recordLlmCall 내부에서 무시된다.
   */
  private record(
    response: LlmProviderResponse,
    providerUsed: string,
    attempts: number,
    stage: string,
  ): void {
    recordLlmCall({
      stage,
      model: response.model,
      promptTokens: response.promptTokens ?? 0,
      completionTokens: response.completionTokens ?? 0,
      cachedTokens: response.cachedTokens ?? 0,
      costUsd: response.costUsd ?? 0,
      latencyMs: response.latencyMs ?? 0,
      provider: providerUsed,
      attempts,
    });
  }

  /**
   * 빈 응답 방어 (arch/25 D-8): 0토큰·공백 응답을 성공으로 반환하면 워커가
   * llmStatus=DONE으로 커밋해 빈 서술이 노출되고 retry-llm 게이트도 죽는다.
   * 실패로 던져 재시도·fallback 체인(classifyError 기본 RETRYABLE)을 태운다.
   */
  private ensureNonEmpty(
    response: LlmProviderResponse,
    providerName: string,
  ): void {
    if (!response.text?.trim()) {
      throw new Error(
        `빈 LLM 응답 (provider=${providerName}, model=${response.model}, completionTokens=${response.completionTokens ?? 0})`,
      );
    }
  }

  async call(
    request: LlmProviderRequest,
    stage = 'unknown',
  ): Promise<LlmCallResult> {
    const config = this.configService.get();
    const primary = this.registry.getPrimary();
    let attempts = 0;

    // 1차 시도: Primary (레이트 리밋 적용)
    attempts++;
    try {
      await this.rateLimiter.acquire();
      const response = await primary.generate(request);
      this.ensureNonEmpty(response, primary.name);
      this.record(response, primary.name, attempts, stage);
      return { success: true, response, providerUsed: primary.name, attempts };
    } catch (err) {
      const category = this.classifyError(err);
      this.logger.warn(
        `Primary "${primary.name}" attempt ${attempts} failed (${category}): ${String(err)}`,
      );

      // RETRYABLE이면 2차 시도
      if (category === 'RETRYABLE' && attempts < config.maxRetries) {
        attempts++;
        try {
          await this.rateLimiter.acquire();
          const response = await primary.generate(request);
          this.ensureNonEmpty(response, primary.name);
          this.record(response, primary.name, attempts, stage);
          return {
            success: true,
            response,
            providerUsed: primary.name,
            attempts,
          };
        } catch (retryErr) {
          this.logger.warn(
            `Primary "${primary.name}" attempt ${attempts} failed: ${String(retryErr)}`,
          );
        }
      }
    }

    // Fallback 시도
    const fallback = this.registry.getFallback();
    const fallbackModel = config.fallbackModel;
    if (fallback.name === primary.name && !fallbackModel) {
      return {
        success: false,
        error: `Primary "${primary.name}" failed after ${attempts} attempts, no distinct fallback`,
        providerUsed: primary.name,
        attempts,
      };
    }

    // fallbackModel이 설정되어 있으면 모델 오버라이드
    const fallbackRequest = fallbackModel
      ? { ...request, model: fallbackModel }
      : request;

    attempts++;
    try {
      await this.rateLimiter.acquire();
      const response = await fallback.generate(fallbackRequest);
      this.ensureNonEmpty(response, fallback.name);
      this.logger.log(`Fallback "${fallback.name}" succeeded`);
      this.record(response, fallback.name, attempts, stage);
      return { success: true, response, providerUsed: fallback.name, attempts };
    } catch (fallbackErr) {
      this.logger.error(
        `Fallback "${fallback.name}" also failed: ${String(fallbackErr)}`,
      );
      return {
        success: false,
        error: `All providers failed after ${attempts} attempts`,
        providerUsed: fallback.name,
        attempts,
      };
    }
  }

  /**
   * 스트리밍 LLM 호출 — 토큰 단위로 AsyncGenerator 반환.
   * OpenAI Provider의 generateStream()을 사용.
   * fallback은 non-stream으로 자동 전환.
   */
  async *callStream(
    request: LlmProviderRequest,
    model?: string,
    stage = 'narrative',
  ): AsyncGenerator<
    | { type: 'token'; text: string }
    | { type: 'done'; response: LlmProviderResponse }
  > {
    const primary = this.registry.getPrimary();
    await this.rateLimiter.acquire();

    const actualModel =
      model ?? request.model ?? this.configService.get().openaiModel;

    // OpenAI Provider만 스트리밍 지원 (P2-S2: any 제거 — optional 메서드 타입 가드)
    type StreamChunk =
      | { type: 'token'; text: string }
      | { type: 'done'; response: LlmProviderResponse };
    type StreamableProvider = {
      generateStream: (
        req: typeof request,
        model?: string,
      ) => AsyncGenerator<StreamChunk>;
    };
    const hasStream = (p: unknown): p is StreamableProvider =>
      typeof (p as { generateStream?: unknown }).generateStream === 'function';

    if (hasStream(primary)) {
      try {
        for await (const chunk of primary.generateStream(
          request,
          actualModel,
        )) {
          if (chunk.type === 'done') {
            this.record(chunk.response, primary.name, 1, stage);
          }
          yield chunk;
        }
        return;
      } catch (err) {
        this.logger.warn(`Stream failed, falling back to non-stream: ${err}`);
      }
    }

    // Fallback: non-stream으로 전체 생성 후 한 번에 반환 (call 내부에서 record)
    const result = await this.call(request, stage);
    if (result.success && result.response) {
      yield { type: 'token', text: result.response.text };
      yield { type: 'done', response: result.response };
    }
  }

  /**
   * 경량 LLM 호출 — Mid Summary 등 보조 작업용.
   * 재시도 1회, 타임아웃 5초. 실패 시 빈 문자열.
   */
  async callLight(params: {
    messages: { role: string; content: string }[];
    maxTokens: number;
    temperature: number;
    stage?: string;
  }): Promise<string> {
    const stage = params.stage ?? 'nano-light';
    const lightConfig = this.configService.getLightModelConfig();
    const provider =
      this.registry.getByName(lightConfig.provider) ??
      this.registry.getPrimary();

    const request: LlmProviderRequest = {
      messages: params.messages.map((m) => ({
        role: m.role as 'system' | 'user' | 'assistant',
        content: m.content,
      })),
      maxTokens: params.maxTokens,
      temperature: params.temperature,
      model: lightConfig.model,
      // nano 감사 1번 (2026-07-11): 전역 60초 대신 경량 전용 타임아웃
      timeoutMs: lightConfig.timeoutMs,
    };

    try {
      await this.rateLimiter.acquire();
      const response = await provider.generate(request);
      this.record(response, provider.name, 1, stage);
      return response.text;
    } catch (err) {
      this.logger.debug(`Light LLM call failed: ${String(err)}`);
      // 1회 재시도
      try {
        await this.rateLimiter.acquire();
        const response = await provider.generate(request);
        this.record(response, provider.name, 2, stage);
        return response.text;
      } catch {
        return '';
      }
    }
  }

  private classifyError(err: unknown): ErrorCategory {
    const message = String(err).toLowerCase();
    const status =
      err && typeof err === 'object' && 'status' in err
        ? (err as { status: number }).status
        : 0;

    // PERMANENT: auth, invalid model, content policy
    if (status === 401 || status === 403) return 'PERMANENT';
    if (
      message.includes('invalid_model') ||
      message.includes('model_not_found')
    )
      return 'PERMANENT';
    if (
      message.includes('content_policy') ||
      message.includes('content_filter')
    )
      return 'PERMANENT';

    // RETRYABLE: timeout, rate limit, server error, overloaded
    return 'RETRYABLE';
  }
}
