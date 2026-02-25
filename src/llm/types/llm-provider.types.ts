// LLM Multi-Provider 인터페이스 정의
// OpenAI 메시지 형식을 표준으로 사용. 각 공급자가 generate() 내부에서 자기 포맷으로 변환.

export interface LlmMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
  cacheControl?: 'ephemeral'; // Claude 캐시 브레이크포인트 (OpenAI/Gemini/Mock은 무시)
}

export interface LlmProviderRequest {
  messages: LlmMessage[];
  maxTokens: number;
  temperature: number;
  model?: string;
  reasoningEffort?: 'low' | 'medium' | 'high'; // GPT-5/o-series reasoning 강도
}

export interface LlmProviderResponse {
  text: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
  cachedTokens: number; // OpenAI: prompt_tokens_details.cached_tokens
  latencyMs: number;
}

export interface LlmProvider {
  readonly name: string;
  generate(request: LlmProviderRequest): Promise<LlmProviderResponse>;
  isAvailable(): boolean;
}

export type ErrorCategory = 'RETRYABLE' | 'PERMANENT';

export interface LlmCallResult {
  success: boolean;
  response?: LlmProviderResponse;
  error?: string;
  providerUsed: string;
  attempts: number;
}

export interface LlmConfig {
  provider: string;
  openaiApiKey: string;
  openaiModel: string;
  claudeApiKey: string;
  claudeModel: string;
  geminiApiKey: string;
  geminiModel: string;
  maxRetries: number;
  timeoutMs: number;
  maxTokens: number;
  temperature: number;
  fallbackProvider: string;
}
