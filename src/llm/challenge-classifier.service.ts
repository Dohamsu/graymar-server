// ChallengeClassifierService
// 행동에 "저항 또는 의미있는 결과 분기"가 있는지 nano LLM으로 분류.
// FREE → ResolveService.buildAutoSuccess() 즉시 호출 (주사위 스킵)
// CHECK → 정상 1d6 + stat 판정 진행
//
// 비용 절감: 명백한 케이스는 룰로 즉결, 회색지대만 nano 호출.

import { Injectable, Logger } from '@nestjs/common';
import { LlmCallerService } from './llm-caller.service.js';
import { LlmConfigService } from './llm-config.service.js';

export type ChallengeResult = 'FREE' | 'CHECK';
export type ChallengeSource = 'rule' | 'llm' | 'fallback';

export interface ChallengeDecision {
  result: ChallengeResult;
  reason: string;
  source: ChallengeSource;
}

export interface ChallengeClassifierContext {
  rawInput: string;
  actionType: string;
  targetNpcId?: string | null;
  targetNpcName?: string | null;
  targetNpcPosture?: string | null;
  locationName?: string | null;
  eventTitle?: string | null;
}

// 즉시 FREE — 자동 SUCCESS, 주사위 스킵
const RULE_FREE_ACTIONS = new Set([
  'MOVE_LOCATION',
  'REST',
  'SHOP',
  'EQUIP',
  'UNEQUIP',
]);

// 즉시 CHECK — 명백한 도전 행동, nano 호출 불필요
const RULE_CHECK_ACTIONS = new Set([
  'FIGHT',
  'STEAL',
  'SNEAK',
  'THREATEN',
  'BRIBE',
  'PERSUADE',
]);

const SYSTEM_PROMPT = `당신은 텍스트 RPG 행동 판정 분류기다.
플레이어의 행동에 "저항" 또는 "의미있는 결과 분기"가 있는지 판단한다.

판정 기준:
- FREE: 의지로 가능한 자유 행동. 저항 없음, 결과 분기 없음.
  예) 태양을 본다, 한숨 쉰다, 옷을 입는다, 안녕이라고 인사한다, 주변을 둘러본다
- CHECK: 저항/위험/불확실성이 있는 도전 행동. SUCCESS와 FAIL이 게임 상태를 다르게 만든다.
  예) 적대적 NPC에게 정보를 캐묻는다, 잠긴 문을 살핀다, 숨겨진 단서를 찾는다, 군중에서 표적을 찾는다

JSON만 출력 (다른 텍스트 금지):
{"result":"FREE 또는 CHECK","reason":"15자 이내 근거"}`;

@Injectable()
export class ChallengeClassifierService {
  private readonly logger = new Logger(ChallengeClassifierService.name);
  private readonly enabled: boolean;

  constructor(
    private readonly llmCaller: LlmCallerService,
    private readonly configService: LlmConfigService,
  ) {
    this.enabled =
      (process.env.CHALLENGE_CLASSIFIER_ENABLED ?? 'true').toLowerCase() !==
      'false';
  }

  async classify(ctx: ChallengeClassifierContext): Promise<ChallengeDecision> {
    if (!this.enabled) {
      return { result: 'CHECK', reason: 'classifier disabled', source: 'rule' };
    }

    // 룰 1차 게이트
    if (RULE_FREE_ACTIONS.has(ctx.actionType)) {
      return {
        result: 'FREE',
        reason: `non-challenge action ${ctx.actionType}`,
        source: 'rule',
      };
    }
    if (RULE_CHECK_ACTIONS.has(ctx.actionType)) {
      return {
        result: 'CHECK',
        reason: `always-challenge action ${ctx.actionType}`,
        source: 'rule',
      };
    }

    // 회색지대 → nano LLM
    return this.classifyWithLlm(ctx);
  }

  private async classifyWithLlm(
    ctx: ChallengeClassifierContext,
  ): Promise<ChallengeDecision> {
    try {
      const userMsg = this.buildUserMessage(ctx);
      const lightConfig = this.configService.getLightModelConfig();

      const result = await this.llmCaller.call({
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: userMsg },
        ],
        maxTokens: 50,
        temperature: 0.2,
        model: lightConfig.model,
      });

      if (!result.success || !result.response?.text) {
        return {
          result: 'CHECK',
          reason: 'llm no response',
          source: 'fallback',
        };
      }

      const parsed = this.parseResponse(result.response.text);
      if (!parsed) {
        return {
          result: 'CHECK',
          reason: 'llm parse failed',
          source: 'fallback',
        };
      }

      this.logger.debug(
        `[Challenge] ${parsed.result} actionType=${ctx.actionType} reason="${parsed.reason}"`,
      );
      return { ...parsed, source: 'llm' };
    } catch (err) {
      this.logger.warn(
        `[Challenge] llm error: ${err instanceof Error ? err.message : err}`,
      );
      return { result: 'CHECK', reason: 'llm error', source: 'fallback' };
    }
  }

  private buildUserMessage(ctx: ChallengeClassifierContext): string {
    const parts = [`행동: "${ctx.rawInput}"`, `타입: ${ctx.actionType}`];
    if (ctx.targetNpcName) {
      const posture = ctx.targetNpcPosture ?? 'NEUTRAL';
      parts.push(`대상 NPC: ${ctx.targetNpcName} (${posture})`);
    }
    if (ctx.locationName) parts.push(`장소: ${ctx.locationName}`);
    if (ctx.eventTitle) parts.push(`이벤트: ${ctx.eventTitle}`);
    return parts.join('\n');
  }

  private parseResponse(
    text: string,
  ): { result: ChallengeResult; reason: string } | null {
    const jsonMatch = text.trim().match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;

    try {
      const parsed = JSON.parse(jsonMatch[0]) as {
        result?: unknown;
        reason?: unknown;
      };
      const result =
        parsed.result === 'FREE' || parsed.result === 'CHECK'
          ? parsed.result
          : null;
      if (!result) return null;
      const reason =
        typeof parsed.reason === 'string' ? parsed.reason.slice(0, 50) : '';
      return { result, reason };
    } catch {
      return null;
    }
  }
}
