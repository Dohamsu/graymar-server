// Gemini LLM 공급자 — 스켈레톤
// 구현 시 @google/genai 설치 필요: pnpm add @google/genai
//
// 변환 로직 참고:
// - OpenAI의 role: assistant -> Gemini의 role: model
// - messages -> Content[] 배열로 변환
// - system 메시지는 GenerateContentRequest의 systemInstruction으로 분리
// - response: response.text(), usageMetadata.promptTokenCount, candidatesTokenCount

import type {
  LlmProvider,
  LlmProviderRequest,
  LlmProviderResponse,
} from '../types/index.js';
import type { LlmConfig } from '../types/index.js';

export class GeminiProvider implements LlmProvider {
  readonly name = 'gemini';

  constructor(private readonly config: LlmConfig) {}

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  generate(_request: LlmProviderRequest): Promise<LlmProviderResponse> {
    return Promise.reject(
      new Error(
        'Gemini provider is not yet implemented. Install @google/genai and implement generate().',
      ),
    );
  }

  isAvailable(): boolean {
    return false;
  }
}
