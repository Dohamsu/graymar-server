// Mock LLM 공급자 — 개발/테스트/fallback용
// summary.display(서술 폴백 텍스트)를 반환. raw 프롬프트를 그대로 반환하지 않음.

import type {
  LlmProvider,
  LlmProviderRequest,
  LlmProviderResponse,
} from '../types/index.js';

export class MockProvider implements LlmProvider {
  readonly name = 'mock';

  generate(request: LlmProviderRequest): Promise<LlmProviderResponse> {
    const start = Date.now();

    // fallback 텍스트: "No narrative available" (LLM worker의 SceneShell fallback이 대체함)
    const text = '서술을 불러오지 못했습니다.';

    return Promise.resolve({
      text,
      model: 'mock-v1',
      promptTokens: 0,
      completionTokens: 0,
      cachedTokens: 0,
      latencyMs: Date.now() - start,
    });
  }

  isAvailable(): boolean {
    return true;
  }
}
