// LLM 설정 API — UI에서 런타임으로 모델/공급자 변경

import {
  Body,
  Controller,
  Get,
  Patch,
  BadRequestException,
} from '@nestjs/common';
import { LlmConfigService, type LlmConfigPatch } from './llm-config.service.js';

const VALID_PROVIDERS = ['mock', 'openai', 'claude', 'gemini'] as const;

@Controller('v1/settings/llm')
export class LlmSettingsController {
  constructor(private readonly configService: LlmConfigService) {}

  /** 현재 LLM 설정 조회 (API 키 마스킹) */
  @Get()
  getSettings() {
    return this.configService.getPublic();
  }

  /** LLM 설정 런타임 변경 — 다음 poll 사이클부터 반영 */
  @Patch()
  updateSettings(@Body() body: LlmConfigPatch) {
    // provider 유효성 검증
    if (
      body.provider &&
      !VALID_PROVIDERS.includes(
        body.provider as (typeof VALID_PROVIDERS)[number],
      )
    ) {
      throw new BadRequestException(
        `Invalid provider "${body.provider}". Valid: ${VALID_PROVIDERS.join(', ')}`,
      );
    }
    if (
      body.fallbackProvider &&
      !VALID_PROVIDERS.includes(
        body.fallbackProvider as (typeof VALID_PROVIDERS)[number],
      )
    ) {
      throw new BadRequestException(
        `Invalid fallbackProvider "${body.fallbackProvider}". Valid: ${VALID_PROVIDERS.join(', ')}`,
      );
    }

    // temperature 범위 검증
    if (
      body.temperature !== undefined &&
      (body.temperature < 0 || body.temperature > 2)
    ) {
      throw new BadRequestException('temperature must be between 0 and 2');
    }

    // maxTokens 범위 검증
    if (
      body.maxTokens !== undefined &&
      (body.maxTokens < 1 || body.maxTokens > 16384)
    ) {
      throw new BadRequestException('maxTokens must be between 1 and 16384');
    }

    // API 키가 없는 공급자로 전환 방지
    if (body.provider) {
      const config = this.configService.get();
      const keyMap: Record<string, string> = {
        openai: config.openaiApiKey,
        claude: config.claudeApiKey,
        gemini: config.geminiApiKey,
      };
      if (body.provider !== 'mock' && !keyMap[body.provider]) {
        throw new BadRequestException(
          `Cannot switch to "${body.provider}": API key not configured in .env`,
        );
      }
    }

    this.configService.update(body);

    return {
      message:
        'LLM settings updated. Changes apply to the next LLM worker cycle.',
      ...this.configService.getPublic(),
    };
  }
}
