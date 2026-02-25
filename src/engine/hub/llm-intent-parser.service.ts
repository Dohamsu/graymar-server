// LLM 기반 의도 분류 오케스트레이션
// - ACTION 입력만 LLM 호출, CHOICE는 기존 키워드 파서 위임
// - 전용 경량 모델(Gemini Flash-Lite 등) 사용으로 메인 내러티브 LLM과 완전 분리
// - LLM 실패 시 키워드 파서 결과를 silent fallback으로 사용

import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { IntentParserV2Service } from './intent-parser-v2.service.js';
import { LlmProviderRegistryService } from '../../llm/providers/llm-provider-registry.service.js';
import {
  INTENT_SYSTEM_PROMPT,
  buildIntentUserMessage,
} from '../../llm/prompts/intent-system-prompt.js';
import {
  INTENT_ACTION_TYPE,
  type IntentActionType,
  type IntentTone,
  type ParsedIntentV2,
} from '../../db/types/parsed-intent-v2.js';

// 에스컬레이션 맵 (intent-parser-v2 와 동일)
const ESCALATION_MAP: Partial<Record<IntentActionType, IntentActionType>> = {
  THREATEN: 'FIGHT',
  PERSUADE: 'THREATEN',
  OBSERVE: 'INVESTIGATE',
  TALK: 'PERSUADE',
  BRIBE: 'THREATEN',
  SNEAK: 'STEAL',
};

const VALID_TONES = new Set<IntentTone>([
  'CAUTIOUS', 'AGGRESSIVE', 'DIPLOMATIC', 'DECEPTIVE', 'NEUTRAL',
]);

// 타임아웃 (ms) — reasoning 모델 콜드스타트 고려 5초
const INTENT_LLM_TIMEOUT_MS = 5000;

@Injectable()
export class LlmIntentParserService implements OnModuleInit {
  private readonly logger = new Logger(LlmIntentParserService.name);

  // 전용 intent LLM 설정 (env에서 읽기)
  private readonly intentProvider: string;
  private readonly intentModel: string;

  constructor(
    private readonly keywordParser: IntentParserV2Service,
    private readonly providerRegistry: LlmProviderRegistryService,
  ) {
    this.intentProvider = process.env.INTENT_LLM_PROVIDER ?? 'openai';
    this.intentModel = process.env.INTENT_LLM_MODEL ?? 'gpt-5-nano';
  }

  onModuleInit(): void {
    // provider 등록 완료 후 가용성 확인
    const provider = this.providerRegistry.getByName(this.intentProvider);
    const available = provider?.isAvailable() ?? false;
    this.logger.log(
      `Intent LLM: provider=${this.intentProvider}, model=${this.intentModel}, available=${available}`,
    );
  }

  async parseWithInsistence(
    inputText: string,
    source: 'RULE' | 'LLM' | 'CHOICE' = 'RULE',
    choicePayload?: Record<string, unknown>,
    insistenceCount: number = 0,
    repeatedType: string | null = null,
    locationId?: string,
  ): Promise<ParsedIntentV2> {
    // CHOICE → 키워드 파서 직접 위임 (affordance 매핑으로 충분)
    if (source === 'CHOICE') {
      return this.keywordParser.parseWithInsistence(
        inputText, source, choicePayload, insistenceCount, repeatedType,
      );
    }

    // 키워드 파서를 먼저 실행 (fallback 확보)
    const keywordResult = this.keywordParser.parseWithInsistence(
      inputText, source, choicePayload, insistenceCount, repeatedType,
    );

    // LLM 비활성화 시 키워드 결과 반환
    if (!this.isEnabled()) {
      return keywordResult;
    }

    // LLM 호출 (전용 경량 모델)
    const startMs = Date.now();
    try {
      const llmResult = await this.callLlm(inputText, locationId);
      const latencyMs = Date.now() - startMs;

      if (llmResult) {
        const merged = this.mergeResults(
          llmResult, keywordResult, inputText, insistenceCount, repeatedType,
        );
        const llmSecondary = llmResult.secondaryActionType ? `+${llmResult.secondaryActionType}` : '';
        const kwSecondary = keywordResult.secondaryActionType ? `+${keywordResult.secondaryActionType}` : '';
        const finalSecondary = merged.secondaryActionType ? `+${merged.secondaryActionType}` : '';
        this.logger.log(
          `LLM: ${llmResult.actionType}${llmSecondary} | KW: ${keywordResult.actionType}${kwSecondary} | final: ${merged.actionType}${finalSecondary} | ${latencyMs}ms (${this.intentModel})`,
        );
        return merged;
      }
    } catch (err) {
      const latencyMs = Date.now() - startMs;
      this.logger.warn(
        `LLM failed (${latencyMs}ms), fallback to keyword: ${String(err)}`,
      );
    }

    // Fallback: 키워드 결과 반환
    return keywordResult;
  }

  private isEnabled(): boolean {
    const envFlag = process.env.INTENT_LLM_ENABLED;
    if (envFlag === 'false') return false;

    // 전용 provider가 사용 가능한지 확인
    const provider = this.providerRegistry.getByName(this.intentProvider);
    if (!provider || !provider.isAvailable()) {
      this.logger.warn(
        `Intent provider "${this.intentProvider}" not available, LLM intent disabled`,
      );
      return false;
    }
    return true;
  }

  private async callLlm(
    inputText: string,
    locationId?: string,
  ): Promise<{ actionType: IntentActionType; secondaryActionType: IntentActionType | null; tone: IntentTone; target: string | null; riskLevel: 1 | 2 | 3 } | null> {
    const provider = this.providerRegistry.getByName(this.intentProvider);
    if (!provider) return null;

    // 타임아웃 레이싱: 경량 모델이므로 3초 내 응답 기대
    const result = await Promise.race([
      provider.generate({
        messages: [
          { role: 'system', content: INTENT_SYSTEM_PROMPT },
          { role: 'user', content: buildIntentUserMessage(inputText, locationId) },
        ],
        maxTokens: 256,
        temperature: 0,
        model: this.intentModel,
        reasoningEffort: 'low',
      }),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), INTENT_LLM_TIMEOUT_MS)),
    ]);

    if (!result) {
      this.logger.warn('Intent LLM timed out');
      return null;
    }

    return this.parseJsonResponse(result.text);
  }

  /** JSON 응답 파싱 3단계: 직접 → 코드블록 → {…} 추출 */
  private parseJsonResponse(
    text: string,
  ): { actionType: IntentActionType; secondaryActionType: IntentActionType | null; tone: IntentTone; target: string | null; riskLevel: 1 | 2 | 3 } | null {
    const candidates = [
      text.trim(),
      this.extractFromCodeBlock(text),
      this.extractJsonBraces(text),
    ];

    for (const candidate of candidates) {
      if (!candidate) continue;
      try {
        const parsed = JSON.parse(candidate);
        if (this.validateParsed(parsed)) {
          const actionType = this.normalizeActionType(parsed.actionType as IntentActionType);
          const secondaryRaw = parsed.secondaryActionType as string | null | undefined;
          const secondaryActionType: IntentActionType | null =
            secondaryRaw && (INTENT_ACTION_TYPE as readonly string[]).includes(secondaryRaw)
              ? this.normalizeActionType(secondaryRaw as IntentActionType)
              : null;
          const tone: IntentTone = VALID_TONES.has(parsed.tone as IntentTone) ? (parsed.tone as IntentTone) : 'NEUTRAL';
          const riskLevel: 1 | 2 | 3 = ([1, 2, 3] as const).includes(parsed.riskLevel as 1 | 2 | 3)
            ? (parsed.riskLevel as 1 | 2 | 3) : 1;
          return {
            actionType,
            secondaryActionType: secondaryActionType !== actionType ? secondaryActionType : null,
            tone,
            target: (parsed.target as string) ?? null,
            riskLevel,
          };
        }
      } catch {
        // 다음 후보 시도
      }
    }

    this.logger.warn(`JSON parse failed: ${text.slice(0, 200)}`);
    return null;
  }

  /** 비이벤트 타입 리다이렉트 (SHOP→TRADE, SEARCH→INVESTIGATE) */
  private normalizeActionType(type: IntentActionType): IntentActionType {
    switch (type) {
      case 'SHOP': return 'TRADE';
      case 'SEARCH': return 'INVESTIGATE';
      default: return type;
    }
  }

  private extractFromCodeBlock(text: string): string | null {
    const match = text.match(/```(?:json)?\s*([\s\S]*?)```/);
    return match?.[1]?.trim() ?? null;
  }

  private extractJsonBraces(text: string): string | null {
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start === -1 || end === -1 || end <= start) return null;
    return text.slice(start, end + 1);
  }

  private validateParsed(obj: unknown): obj is { actionType: string; secondaryActionType?: string | null; tone?: string; target?: string | null; riskLevel?: number } {
    if (typeof obj !== 'object' || obj === null) return false;
    const o = obj as Record<string, unknown>;
    if (typeof o.actionType !== 'string') return false;
    return (INTENT_ACTION_TYPE as readonly string[]).includes(o.actionType);
  }

  /** LLM 결과와 키워드 결과를 병합 + 에스컬레이션 적용 */
  private mergeResults(
    llmResult: { actionType: IntentActionType; secondaryActionType: IntentActionType | null; tone: IntentTone; target: string | null; riskLevel: 1 | 2 | 3 },
    keywordResult: ParsedIntentV2,
    inputText: string,
    insistenceCount: number,
    repeatedType: string | null,
  ): ParsedIntentV2 {
    // MOVE_LOCATION/REST는 LLM 출력 범위 밖 → KW 감지 시 무조건 우선
    const KW_OVERRIDE_TYPES: ReadonlySet<string> = new Set(['MOVE_LOCATION', 'REST']);
    let actionType = KW_OVERRIDE_TYPES.has(keywordResult.actionType)
      ? keywordResult.actionType
      : llmResult.actionType;
    // secondary: LLM 결과 우선, 없으면 키워드 결과의 secondary 사용
    let secondaryActionType: IntentActionType | undefined =
      (llmResult.secondaryActionType ?? keywordResult.secondaryActionType) || undefined;

    // 에스컬레이션: 같은 actionType 연속 3회 → 강한 타입으로 승격
    // 에스컬레이션은 primary에만 적용
    let escalated = false;
    if (insistenceCount >= 2 && actionType === repeatedType && ESCALATION_MAP[actionType]) {
      actionType = ESCALATION_MAP[actionType]!;
      escalated = true;
    }

    // secondary가 primary와 같으면 제거
    if (secondaryActionType === actionType) secondaryActionType = undefined;

    return {
      inputText,
      actionType,
      secondaryActionType,
      tone: llmResult.tone,
      target: llmResult.target,
      riskLevel: llmResult.riskLevel,
      intentTags: keywordResult.intentTags,
      confidence: 2,
      source: 'LLM',
      suppressedActionType: escalated ? undefined : keywordResult.suppressedActionType,
      escalated,
    };
  }
}
