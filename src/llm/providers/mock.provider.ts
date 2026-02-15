// Mock LLM 공급자 — 기존 llm-worker의 mock 로직을 추출

import type {
  LlmProvider,
  LlmProviderRequest,
  LlmProviderResponse,
} from '../types/index.js';

export class MockProvider implements LlmProvider {
  readonly name = 'mock';

  async generate(request: LlmProviderRequest): Promise<LlmProviderResponse> {
    const start = Date.now();

    // 마지막 user 메시지에서 [상황 요약] 이후 텍스트를 추출
    const lastUserMsg = [...request.messages]
      .reverse()
      .find((m) => m.role === 'user');

    const text = lastUserMsg?.content ?? 'No narrative available.';

    return {
      text,
      model: 'mock-v1',
      promptTokens: 0,
      completionTokens: 0,
      latencyMs: Date.now() - start,
    };
  }

  isAvailable(): boolean {
    return true;
  }
}
