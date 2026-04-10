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

/** Gemini API 응답 타입 (필요 필드만 정의) */
interface GeminiResponse {
  text?: string;
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    cachedContentTokenCount?: number;
  };
  candidates?: Array<{ finishReason?: string }>;
}

interface GeminiClient {
  models: {
    generateContent(params: Record<string, unknown>): Promise<GeminiResponse>;
  };
}

export class GeminiProvider implements LlmProvider {
  readonly name = 'gemini';
  private client: GeminiClient | null = null;

  constructor(private readonly config: LlmConfig) {}

  private getClient(): GeminiClient {
    if (!this.client) {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { GoogleGenAI } = require('@google/genai') as {
        GoogleGenAI: new (opts: { apiKey?: string }) => GeminiClient;
      };
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
    const nonSystemMessages = request.messages.filter(
      (m) => m.role !== 'system',
    );

    // Gemini Content 형식으로 변환
    const contents = nonSystemMessages.map((m: LlmMessage) => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: m.content }],
    }));

    // systemInstruction 조합
    const systemInstruction =
      systemMessages.length > 0
        ? systemMessages.map((m) => m.content).join('\n\n')
        : undefined;

    // Gemini 2.5 thinking 모델만 output budget 확대, flash-lite 등은 요청값 그대로
    const isThinkingModel = /^gemini-2\.5-(pro|flash)$/.test(model);
    const outputBudget = isThinkingModel
      ? Math.max(request.maxTokens, 8192)
      : request.maxTokens;

    const response = await client.models.generateContent({
      model,
      contents,
      config: {
        maxOutputTokens: outputBudget,
        temperature: request.temperature,
        ...(systemInstruction ? { systemInstruction } : {}),
      },
    });

    const text: string = response.text ?? '';
    const usage = response.usageMetadata;

    // 디버깅: finish reason 로그
    const finishReason = response.candidates?.[0]?.finishReason;
    if (finishReason && finishReason !== 'STOP') {
      console.warn(
        `[GeminiProvider] finishReason: ${finishReason}, text length: ${text.length}`,
      );
    }

    return {
      text,
      model,
      promptTokens: usage?.promptTokenCount ?? 0,
      completionTokens: usage?.candidatesTokenCount ?? 0,
      cachedTokens: usage?.cachedContentTokenCount ?? 0,
      cacheCreationTokens: 0,
      latencyMs: Date.now() - start,
      costUsd: 0,
    };
  }

  isAvailable(): boolean {
    return !!this.config.geminiApiKey;
  }
}
