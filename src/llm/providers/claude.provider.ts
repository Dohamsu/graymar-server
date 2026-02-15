// Claude LLM 공급자 — 스켈레톤
// 구현 시 @anthropic-ai/sdk 설치 필요: pnpm add @anthropic-ai/sdk
//
// 변환 로직 참고:
// - OpenAI의 system 메시지 -> Anthropic API의 top-level system 파라미터로 분리
// - messages에서 system role 제거, user/assistant만 전달
// - response: content[0].text, usage.input_tokens, usage.output_tokens

import type {
  LlmProvider,
  LlmProviderRequest,
  LlmProviderResponse,
} from '../types/index.js';
import type { LlmConfig } from '../types/index.js';

export class ClaudeProvider implements LlmProvider {
  readonly name = 'claude';

  constructor(private readonly config: LlmConfig) {}

  async generate(_request: LlmProviderRequest): Promise<LlmProviderResponse> {
    throw new Error('Claude provider is not yet implemented. Install @anthropic-ai/sdk and implement generate().');
  }

  isAvailable(): boolean {
    return false;
  }
}
