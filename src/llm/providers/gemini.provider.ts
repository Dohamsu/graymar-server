// Gemini LLM 공급자 — @google/genai SDK
//
// 변환 로직:
// - OpenAI의 role: assistant -> Gemini의 role: model
// - system 메시지는 systemInstruction으로 분리
// - cacheControl 힌트는 무시 (Gemini 캐싱은 별도 API)

import type {
  LlmProvider,
  LlmProviderRequest,
  LlmProviderResponse,
  LlmMessage,
} from '../types/index.js';
import type { LlmConfig } from '../types/index.js';

export class GeminiProvider implements LlmProvider {
  readonly name = 'gemini';
  private client: any = null;

  constructor(private readonly config: LlmConfig) {}

  private getClient(): any {
    if (!this.client) {
      // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-unsafe-assignment
      const { GoogleGenAI } = require('@google/genai');
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call
      this.client = new GoogleGenAI({ apiKey: this.config.geminiApiKey });
    }
    return this.client;
  }

  async generate(request: LlmProviderRequest): Promise<LlmProviderResponse> {
    const start = Date.now();
    const model = request.model ?? this.config.geminiModel;
    const client = this.getClient();

    // system 메시지 분리
    const systemMessages = request.messages.filter((m) => m.role === 'system');
    const nonSystemMessages = request.messages.filter((m) => m.role !== 'system');

    // Gemini Content 형식으로 변환
    const contents = nonSystemMessages.map((m: LlmMessage) => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: m.content }],
    }));

    // systemInstruction 조합
    const systemInstruction = systemMessages.length > 0
      ? systemMessages.map((m) => m.content).join('\n\n')
      : undefined;

    // Gemini 2.5 모델은 thinking 모델 — maxOutputTokens를 넉넉하게 설정
    const outputBudget = Math.max(request.maxTokens, 8192);

    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call
    const response = await client.models.generateContent({
      model,
      contents,
      config: {
        maxOutputTokens: outputBudget,
        temperature: request.temperature,
        ...(systemInstruction ? { systemInstruction } : {}),
      },
    });

    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access
    const text: string = response.text ?? '';
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access
    const usage = response.usageMetadata;

    // 디버깅: finish reason 로그
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    const finishReason = response.candidates?.[0]?.finishReason;
    if (finishReason && finishReason !== 'STOP') {
      console.warn(`[GeminiProvider] finishReason: ${finishReason}, text length: ${text.length}`);
    }

    return {
      text,
      model,
      // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
      promptTokens: usage?.promptTokenCount ?? 0,
      // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
      completionTokens: usage?.candidatesTokenCount ?? 0,
      // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
      cachedTokens: usage?.cachedContentTokenCount ?? 0,
      latencyMs: Date.now() - start,
    };
  }

  isAvailable(): boolean {
    return !!this.config.geminiApiKey;
  }
}
