// LLM 호출 서비스 — 재시도 + fallback 전략

import { Injectable, Logger } from '@nestjs/common';
import { LlmProviderRegistryService } from './providers/llm-provider-registry.service.js';
import { LlmConfigService } from './llm-config.service.js';
import type {
  LlmProviderRequest,
  LlmCallResult,
  ErrorCategory,
} from './types/index.js';

@Injectable()
export class LlmCallerService {
  private readonly logger = new Logger(LlmCallerService.name);

  constructor(
    private readonly registry: LlmProviderRegistryService,
    private readonly configService: LlmConfigService,
  ) {}

  async call(request: LlmProviderRequest): Promise<LlmCallResult> {
    const config = this.configService.get();
    const primary = this.registry.getPrimary();
    let attempts = 0;

    // 1차 시도: Primary
    attempts++;
    try {
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
          const response = await primary.generate(request);
          return { success: true, response, providerUsed: primary.name, attempts };
        } catch (retryErr) {
          this.logger.warn(
            `Primary "${primary.name}" attempt ${attempts} failed: ${String(retryErr)}`,
          );
        }
      }
    }

    // Fallback 시도
    const fallback = this.registry.getFallback();
    if (fallback.name === primary.name) {
      return {
        success: false,
        error: `Primary "${primary.name}" failed after ${attempts} attempts, no distinct fallback`,
        providerUsed: primary.name,
        attempts,
      };
    }

    attempts++;
    try {
      const response = await fallback.generate(request);
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

  private classifyError(err: unknown): ErrorCategory {
    const message = String(err).toLowerCase();
    const status =
      err && typeof err === 'object' && 'status' in err
        ? (err as { status: number }).status
        : 0;

    // PERMANENT: auth, invalid model, content policy
    if (status === 401 || status === 403) return 'PERMANENT';
    if (message.includes('invalid_model') || message.includes('model_not_found'))
      return 'PERMANENT';
    if (message.includes('content_policy') || message.includes('content_filter'))
      return 'PERMANENT';

    // RETRYABLE: timeout, rate limit, server error, overloaded
    return 'RETRYABLE';
  }
}
