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

// [arch/76 D3 — 자유도 확장] 행동 그럴듯함 3단계.
//  NORMAL: 평범 / UNUSUAL: 특이하나 세계 안 가능 / IMPLAUSIBLE: 세계 규칙상 불가
export type Plausibility = 'NORMAL' | 'UNUSUAL' | 'IMPLAUSIBLE';

// [arch/76 D3-b′] 행동의 사회적 인상 — 5축 감정 델타 (각 clamp ±5, 서버 검증).
export interface SocialImpact {
  trust: number;
  fear: number;
  respect: number;
  suspicion: number;
  attachment: number;
}

export interface ChallengeDecision {
  result: ChallengeResult;
  reason: string;
  source: ChallengeSource;
  // [arch/76 D3] 행동-특정 판정 파라미터 (nano 제안 → 서버 검증).
  //  actionType 버킷이 아니라 실제 행동에 맞춰 스탯·난이도를 정한다.
  /** 이 행동에 가장 맞는 스탯 키(검증됨) — 없으면 ACTION_STAT_MAP 기본 사용 */
  statHint?: string | null;
  /** 행동의 과감함/규모 보정 — clamp [-2,+2]. 과감할수록 음수(어려움) */
  difficultyMod?: number;
  /** 세계 안 그럴듯함 — IMPLAUSIBLE은 서술 치환(거부 아님) */
  plausibility?: Plausibility;
  /** 이 행동이 장소에 물리적 흔적을 남기나 — 흔적 추출 게이트(actionType 무관) */
  physicalImpact?: boolean;
  /** [D3-b′] 상대·목격 NPC에게 주는 인상 — ACTION_IMPACT 버킷의 의미 보정 */
  socialImpact?: SocialImpact | null;
}

// [arch/76 D3] statHint 허용 스탯 — 서버 검증용. 파생값(atk 등)·자원(maxHP)은 제외.
const APPRAISAL_STATS = new Set(['str', 'dex', 'wit', 'con', 'per', 'cha']);
const DIFFICULTY_CLAMP = 2;
// [D3-b′] socialImpact 축별 클램프 — nano는 미세 보정(±5), 진폭 뼈대는 서버 테이블.
const SOCIAL_IMPACT_CLAMP = 5;
const SOCIAL_AXES = [
  'trust',
  'fear',
  'respect',
  'suspicion',
  'attachment',
] as const;

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

const SYSTEM_PROMPT = `당신은 텍스트 RPG 행동 감정기다. 플레이어 행동을 6가지로 평가한다.

1) result — 저항/결과분기 유무
   FREE: 의지로 가능, 저항·분기 없음 (둘러본다, 한숨 쉰다, 인사한다)
   CHECK: 저항·위험·불확실 (캐묻는다, 잠긴 문을 살핀다, 단서를 찾는다)

2) statHint — 이 행동에 가장 맞는 능력치 (딱히 없으면 null)
   str(완력·위협) dex(은밀·곡예·손재주) wit(분석·기지·계략)
   con(인내·강건·보호) per(관찰·감지·직감) cha(설득·화술·매력)
   ※ actionType이 아니라 실제 행동 성격에 맞춘다.
     예) "벽을 타 넘는다"→dex, "논리로 몰아붙인다"→wit, "완력으로 문을 부순다"→str

3) difficultyMod — 행동의 과감함/규모 (-2~+2 정수)
   +2 사소·쉬움 / 0 보통 / -2 매우 과감·무모
   예) "말을 건다"→0, "왕을 설득해 반역시킨다"→-2

4) plausibility — 세계 안에서의 그럴듯함 (중세 판타지, 초자연 능력 없음)
   NORMAL 평범 / UNUSUAL 특이하나 가능 / IMPLAUSIBLE 세계 규칙상 불가
   ※ "마법 주문", "불길 소환", "순간이동", "죽은 자·먼 사람 소환", 세계 밖 지식은
     전투처럼 표현돼도 IMPLAUSIBLE. 실제로 가능한 물리 행동(칼·작살·주먹·불붙이기)은 NORMAL/UNUSUAL.

5) physicalImpact — 이 행동이 장소에 지속될 물리적 흔적(파손·전복·탈취·흩뜨림)을 남기는가
   true: 탁자를 엎음, 간판을 뜯어냄, 물건을 부숨/훔침 (실제 물리 변형)
   false: 대화·관찰·이동·거래, 그리고 IMPLAUSIBLE(실재하지 않는 마법 효과)

6) socialImpact — 이 행동이 상대·주변 사람에게 주는 인상 (각 축 -5~5 정수, 해당 없으면 0)
   trust(신뢰) fear(공포) respect(존중, 경멸이면 음수) suspicion(의심) attachment(유대)
   ※ 행동의 **실제 내용**으로 판단 — 기행("탁자 위에서 춤")은 suspicion+, 선의는 trust+,
     위협적 기행("죽은 쥐를 올려놓음")은 fear+suspicion+, 평범한 대화·관찰은 전부 0.
     허황된 주장(IMPLAUSIBLE)은 trust를 올리지 못한다(suspicion+).

JSON만 출력 (다른 텍스트 금지):
{"result":"CHECK","statHint":"dex","difficultyMod":-1,"plausibility":"UNUSUAL","physicalImpact":true,"socialImpact":{"trust":0,"fear":2,"respect":0,"suspicion":3,"attachment":0},"reason":"15자 이내"}`;

// [arch/76 D3-b′-combat] 전투 전술 감정 — 상대의 판단을 속이는 행동만 전술이다.
export type CombatTacticKind = 'DISTRACTION' | 'INTIMIDATION' | 'FEINT';

const COMBAT_TACTIC_PROMPT = `당신은 전투 행동 감정기다. 플레이어의 전투 행동이 아래 전술에 해당하는지 판정한다.

DISTRACTION: 주의 돌리기 — 거짓 외침, 교란 ("저쪽에 운석이!", "경비대다!"라고 소리침)
INTIMIDATION: 위협 — 기세·말로 겁주기 (실제 공격 아님)
FEINT: 속임 동작 — 공격하는 척, 페인트
NONE: 해당 없음 — 일반 공격/방어/이동/도주, 실제 물리 행동, 마법 시전 주장

※ 핵심 구분: "~라고 소리친다/외친다/~하는 척한다"처럼 **상대의 판단을 속이는** 행동만 전술.
   실제로 무언가를 던지거나 때리는 행동, "운석을 떨어뜨린다" 같은 시전 주장은 NONE.

JSON만 출력: {"tactic":"DISTRACTION","reason":"10자 이내"}`;

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

    // 구조적 비도전(이동/휴식/상점/장비)만 룰로 즉결 — 판단할 게 없다.
    if (RULE_FREE_ACTIONS.has(ctx.actionType)) {
      return {
        result: 'FREE',
        reason: `non-challenge action ${ctx.actionType}`,
        source: 'rule',
      };
    }

    // [arch/76 D3] 통합 nano 감정 — 회색지대뿐 아니라 명백한 도전 행동(FIGHT 등)도
    // 현실성(plausibility)·배치(statHint·physicalImpact)를 nano로 판단한다.
    // "마법 주문으로 불길"을 FIGHT로 표현해도 IMPLAUSIBLE을 놓치지 않기 위함.
    const decision = await this.classifyWithLlm(ctx);

    // 명백한 도전 행동은 result만 CHECK로 고정(주사위 스킵 방지) — appraisal은 nano 유지.
    if (RULE_CHECK_ACTIONS.has(ctx.actionType) && decision.result === 'FREE') {
      return {
        ...decision,
        result: 'CHECK',
        reason: `always-challenge ${ctx.actionType}`,
      };
    }
    return decision;
  }

  private async classifyWithLlm(
    ctx: ChallengeClassifierContext,
  ): Promise<ChallengeDecision> {
    try {
      const userMsg = this.buildUserMessage(ctx);
      const lightConfig = this.configService.getLightModelConfig();

      const result = await this.llmCaller.call(
        {
          messages: [
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user', content: userMsg },
          ],
          maxTokens: 200,
          temperature: 0.2,
          model: lightConfig.model,
          timeoutMs: lightConfig.timeoutMs,
        },
        'challenge-classifier',
      );

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
        `[Challenge] ${parsed.result} actionType=${ctx.actionType} stat=${parsed.statHint ?? '-'} diff=${parsed.difficultyMod ?? 0} plaus=${parsed.plausibility ?? 'NORMAL'} phys=${parsed.physicalImpact ?? false} reason="${parsed.reason}"`,
      );
      return { ...parsed, source: 'llm' };
    } catch (err) {
      this.logger.warn(
        `[Challenge] llm error: ${err instanceof Error ? err.message : err}`,
      );
      return { result: 'CHECK', reason: 'llm error', source: 'fallback' };
    }
  }

  /**
   * [arch/76 D3-b′-combat] 전투 기만·전술 감정 — 창의 입력(Tier 3/4)에서만
   * 호출된다 (게이트는 turns.service). "운석이 떨어진다고 소리친다"(가능한
   * 거짓말)와 "운석을 떨어뜨린다"(환상 시전)를 구분하는 것이 존재 이유.
   * 효과 수치는 combat-tactic.core가 서버 결정론으로 매핑 (불변식 1).
   */
  async appraiseCombatTactic(ctx: {
    rawInput: string;
    enemySummary: string;
  }): Promise<{ tactic: CombatTacticKind; reason: string } | null> {
    if (!this.enabled) return null;
    if (
      (process.env.COMBAT_TACTIC_DISABLED ?? 'false').toLowerCase() === 'true'
    ) {
      return null;
    }
    try {
      const lightConfig = this.configService.getLightModelConfig();
      const result = await this.llmCaller.call(
        {
          messages: [
            { role: 'system', content: COMBAT_TACTIC_PROMPT },
            {
              role: 'user',
              content: `행동: "${ctx.rawInput}"\n적: ${ctx.enemySummary}`,
            },
          ],
          maxTokens: 60,
          temperature: 0.2,
          model: lightConfig.model,
          timeoutMs: lightConfig.timeoutMs,
        },
        'combat-tactic',
      );
      if (!result.success || !result.response?.text) return null;
      const jsonMatch = result.response.text.trim().match(/\{[\s\S]*\}/);
      if (!jsonMatch) return null;
      const parsed = JSON.parse(jsonMatch[0]) as {
        tactic?: unknown;
        reason?: unknown;
      };
      const tactic =
        parsed.tactic === 'DISTRACTION' ||
        parsed.tactic === 'INTIMIDATION' ||
        parsed.tactic === 'FEINT'
          ? parsed.tactic
          : null;
      if (!tactic) return null; // NONE 포함 — 전술 아님
      const reason =
        typeof parsed.reason === 'string' ? parsed.reason.slice(0, 30) : '';
      this.logger.debug(`[CombatTactic] ${tactic} reason="${reason}"`);
      return { tactic, reason };
    } catch (err) {
      this.logger.warn(
        `[CombatTactic] error: ${err instanceof Error ? err.message : err}`,
      );
      return null;
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

  private parseResponse(text: string): {
    result: ChallengeResult;
    reason: string;
    statHint: string | null;
    difficultyMod: number;
    plausibility: Plausibility;
    physicalImpact: boolean;
    socialImpact: SocialImpact | null;
  } | null {
    const jsonMatch = text.trim().match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;

    try {
      const parsed = JSON.parse(jsonMatch[0]) as {
        result?: unknown;
        reason?: unknown;
        statHint?: unknown;
        difficultyMod?: unknown;
        plausibility?: unknown;
        physicalImpact?: unknown;
        socialImpact?: unknown;
      };
      const result =
        parsed.result === 'FREE' || parsed.result === 'CHECK'
          ? parsed.result
          : null;
      if (!result) return null;
      const reason =
        typeof parsed.reason === 'string' ? parsed.reason.slice(0, 50) : '';

      // 서버 검증 — nano 제안을 허용 범위로 클램프/폐기 (불변식 1).
      const statHint =
        typeof parsed.statHint === 'string' &&
        APPRAISAL_STATS.has(parsed.statHint)
          ? parsed.statHint
          : null;
      const rawDiff =
        typeof parsed.difficultyMod === 'number' &&
        Number.isFinite(parsed.difficultyMod)
          ? Math.round(parsed.difficultyMod)
          : 0;
      const difficultyMod = Math.max(
        -DIFFICULTY_CLAMP,
        Math.min(DIFFICULTY_CLAMP, rawDiff),
      );
      const plausibility: Plausibility =
        parsed.plausibility === 'UNUSUAL' ||
        parsed.plausibility === 'IMPLAUSIBLE'
          ? parsed.plausibility
          : 'NORMAL';
      // IMPLAUSIBLE(실재하지 않는 효과)은 물리 흔적을 남기지 않는다 — 서버 강제.
      const physicalImpact =
        parsed.physicalImpact === true && plausibility !== 'IMPLAUSIBLE';

      // [D3-b′] socialImpact 서버 검증 — 축별 정수 clamp ±5, 전 축 0이면 null
      // (감정 보정 없음 — 기존 테이블 100% 적용을 뜻한다).
      let socialImpact: SocialImpact | null = null;
      if (parsed.socialImpact && typeof parsed.socialImpact === 'object') {
        const raw = parsed.socialImpact as Record<string, unknown>;
        const clamped = {} as SocialImpact;
        let nonZero = false;
        for (const axis of SOCIAL_AXES) {
          const v =
            typeof raw[axis] === 'number' && Number.isFinite(raw[axis])
              ? Math.max(
                  -SOCIAL_IMPACT_CLAMP,
                  Math.min(SOCIAL_IMPACT_CLAMP, Math.round(raw[axis])),
                )
              : 0;
          clamped[axis] = v;
          if (v !== 0) nonZero = true;
        }
        // IMPLAUSIBLE 허풍은 신뢰를 얻지 못한다 — 서버 강제 (양수 trust 차단).
        if (plausibility === 'IMPLAUSIBLE' && clamped.trust > 0) {
          clamped.trust = 0;
        }
        if (nonZero) socialImpact = clamped;
      }

      return {
        result,
        reason,
        statHint,
        difficultyMod,
        plausibility,
        physicalImpact,
        socialImpact,
      };
    } catch {
      return null;
    }
  }
}
