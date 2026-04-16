// LLM 호출 서비스 — 재시도 + fallback 전략

import { Injectable, Logger } from '@nestjs/common';
import { LlmProviderRegistryService } from './providers/llm-provider-registry.service.js';
import { LlmConfigService } from './llm-config.service.js';
import type {
  LlmProviderRequest,
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

  async call(request: LlmProviderRequest): Promise<LlmCallResult> {
    const config = this.configService.get();
    const primary = this.registry.getPrimary();
    let attempts = 0;

    // 1차 시도: Primary (레이트 리밋 적용)
    attempts++;
    try {
      await this.rateLimiter.acquire();
      const response = await primary.generate(request);
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
      this.logger.log(`Fallback "${fallback.name}" succeeded`);
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
  ): AsyncGenerator<
    | { type: 'token'; text: string }
    | { type: 'done'; response: LlmProviderResponse }
  > {
    const primary = this.registry.getPrimary();
    await this.rateLimiter.acquire();

    const actualModel = model ?? request.model ?? this.configService.get().openaiModel;

    // OpenAI Provider만 스트리밍 지원
    if ('generateStream' in primary && typeof (primary as any).generateStream === 'function') {
      try {
        yield* (primary as any).generateStream(request, actualModel);
        return;
      } catch (err) {
        this.logger.warn(`Stream failed, falling back to non-stream: ${err}`);
      }
    }

    // Fallback: non-stream으로 전체 생성 후 한 번에 반환
    const result = await this.call(request);
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
  }): Promise<string> {
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
    };

    try {
      await this.rateLimiter.acquire();
      const response = await provider.generate(request);
      return response.text;
    } catch (err) {
      this.logger.debug(`Light LLM call failed: ${String(err)}`);
      // 1회 재시도
      try {
        await this.rateLimiter.acquire();
        const response = await provider.generate(request);
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
