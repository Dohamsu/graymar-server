// LLM 기반 의도 분류 오케스트레이션
// - ACTION 입력만 LLM 호출, CHOICE는 기존 키워드 파서 위임
// - LLM 실패 시 키워드 파서 결과를 silent fallback으로 사용

import { Injectable, Logger } from '@nestjs/common';
import { IntentParserV2Service } from './intent-parser-v2.service.js';
import { LlmCallerService } from '../../llm/llm-caller.service.js';
import { LlmConfigService } from '../../llm/llm-config.service.js';
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

@Injectable()
export class LlmIntentParserService {
  private readonly logger = new Logger(LlmIntentParserService.name);

  constructor(
    private readonly keywordParser: IntentParserV2Service,
    private readonly llmCaller: LlmCallerService,
    private readonly llmConfig: LlmConfigService,
  ) {}

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

    // LLM 호출
    const startMs = Date.now();
    try {
      const llmResult = await this.callLlm(inputText, locationId);
      const latencyMs = Date.now() - startMs;

      if (llmResult) {
        const merged = this.mergeResults(
          llmResult, keywordResult, inputText, insistenceCount, repeatedType,
        );
        this.logger.log(
          `[LlmIntentParser] LLM: ${llmResult.actionType} | KW: ${keywordResult.actionType} | final: ${merged.actionType} | ${latencyMs}ms`,
        );
        return merged;
      }
    } catch (err) {
      const latencyMs = Date.now() - startMs;
      this.logger.warn(
        `[LlmIntentParser] LLM failed (${latencyMs}ms), fallback to keyword: ${String(err)}`,
      );
    }

    // Fallback: 키워드 결과 반환
    return keywordResult;
  }

  private isEnabled(): boolean {
    const envFlag = process.env.INTENT_LLM_ENABLED;
    return envFlag !== 'false';
  }

  private async callLlm(
    inputText: string,
    locationId?: string,
  ): Promise<{ actionType: IntentActionType; tone: IntentTone; target: string | null; riskLevel: 1 | 2 | 3 } | null> {
    const model = process.env.INTENT_LLM_MODEL ?? 'gpt-4o-mini';

    const result = await Promise.race([
      this.llmCaller.call({
        messages: [
          { role: 'system', content: INTENT_SYSTEM_PROMPT },
          { role: 'user', content: buildIntentUserMessage(inputText, locationId) },
        ],
        maxTokens: 256,
        temperature: 0,
        model,
      }),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 3000)),
    ]);

    if (!result || !('success' in result) || !result.success || !result.response) {
      return null;
    }

    return this.parseJsonResponse(result.response.text);
  }

  /** JSON 응답 파싱 3단계: 직접 → 코드블록 → {…} 추출 */
  private parseJsonResponse(
    text: string,
  ): { actionType: IntentActionType; tone: IntentTone; target: string | null; riskLevel: 1 | 2 | 3 } | null {
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
          const actionType = parsed.actionType as IntentActionType;
          const tone: IntentTone = VALID_TONES.has(parsed.tone as IntentTone) ? (parsed.tone as IntentTone) : 'NEUTRAL';
          const riskLevel: 1 | 2 | 3 = ([1, 2, 3] as const).includes(parsed.riskLevel as 1 | 2 | 3)
            ? (parsed.riskLevel as 1 | 2 | 3) : 1;
          return { actionType, tone, target: (parsed.target as string) ?? null, riskLevel };
        }
      } catch {
        // 다음 후보 시도
      }
    }

    this.logger.warn(`[LlmIntentParser] JSON parse failed: ${text.slice(0, 200)}`);
    return null;
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

  private validateParsed(obj: unknown): obj is { actionType: string; tone?: string; target?: string | null; riskLevel?: number } {
    if (typeof obj !== 'object' || obj === null) return false;
    const o = obj as Record<string, unknown>;
    if (typeof o.actionType !== 'string') return false;
    return (INTENT_ACTION_TYPE as readonly string[]).includes(o.actionType);
  }

  /** LLM 결과와 키워드 결과를 병합 + 에스컬레이션 적용 */
  private mergeResults(
    llmResult: { actionType: IntentActionType; tone: IntentTone; target: string | null; riskLevel: 1 | 2 | 3 },
    keywordResult: ParsedIntentV2,
    inputText: string,
    insistenceCount: number,
    repeatedType: string | null,
  ): ParsedIntentV2 {
    let actionType = llmResult.actionType;

    // 에스컬레이션: 같은 actionType 연속 3회 → 강한 타입으로 승격
    let escalated = false;
    if (insistenceCount >= 2 && actionType === repeatedType && ESCALATION_MAP[actionType]) {
      actionType = ESCALATION_MAP[actionType]!;
      escalated = true;
    }

    // suppressedActionType: LLM 결과에서는 키워드와 달리 명시적으로 감지 불가하므로 undefined
    return {
      inputText,
      actionType,
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
