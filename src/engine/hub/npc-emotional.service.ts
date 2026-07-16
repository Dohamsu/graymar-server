import { Injectable } from '@nestjs/common';
import type {
  NpcEmotionalState,
  NPCState,
  NpcPosture,
  ResolveOutcome,
} from '../../db/types/index.js';
import { computeEffectivePosture } from '../../db/types/npc-state.js';

// 행동→감정 축 영향 매핑 (v2: 직접 상호작용 체감 강화)
const ACTION_IMPACT: Record<
  string,
  Partial<Record<keyof NpcEmotionalState, number>>
> = {
  FIGHT: { fear: 15, trust: -8, respect: 8, suspicion: 8 },
  THREATEN: { fear: 20, trust: -12, respect: -5, suspicion: 12 },
  HELP: { trust: 15, attachment: 12, respect: 8, fear: -5 },
  PERSUADE: { trust: 8, respect: 5, suspicion: -3 },
  BRIBE: { trust: -5, suspicion: 10, attachment: 3 },
  INVESTIGATE: { suspicion: 6, respect: 3 },
  SNEAK: { suspicion: 10, trust: -4 },
  STEAL: { trust: -20, suspicion: 20, fear: 5 },
  OBSERVE: { suspicion: 4 },
  TRADE: { trust: 6, attachment: 4 },
  TALK: { trust: 5, attachment: 3 },
};

// outcome별 감정 변동 배율 (SUCCESS, PARTIAL만 — FAIL은 부호별 분기 처리)
const OUTCOME_MULTIPLIER: Record<string, number> = {
  SUCCESS: 1.0,
  PARTIAL: 0.6,
};

// FAIL 시 부호별 배율:
// - 적대 행동(delta < 0): 실패해도 방향 유지, 약화 (0.3)
// - 우호 행동(delta > 0): 실패 시 반전, 약한 역효과 (-0.3)
const FAIL_MULTIPLIER_NEGATIVE = 0.3;
const FAIL_MULTIPLIER_POSITIVE = -0.3;

// [arch/76 D3-b′] nano socialImpact 블렌드 — 테이블은 진폭 뼈대(감쇠),
// nano(±5)는 행동 내용의 의미 보정. nano 부재 시 테이블 100% (fallback).
const NANO_BASE_DAMP = 0.4;
const NANO_IMPACT_SCALE = 2;

// 클램프 범위
const CLAMP_BIPOLAR = { min: -100, max: 100 }; // trust, respect
const CLAMP_UNIPOLAR = { min: 0, max: 100 }; // fear, suspicion, attachment

@Injectable()
export class NpcEmotionalService {
  /**
   * 초기 감정 상태 생성.
   */
  initEmotionalState(initialTrust: number = 0): NpcEmotionalState {
    return {
      trust: initialTrust,
      fear: 0,
      respect: 0,
      suspicion: 0,
      attachment: 0,
    };
  }

  /**
   * 플레이어 행동 결과에 따른 감정 변화 적용.
   *
   * [arch/76 D3-b′] nanoImpact(통합 nano 감정의 socialImpact, 각 축 ±5 검증됨)가
   * 있으면 축별 `round(base×0.4 + nano×2)` 블렌드 — 테이블(actionType 버킷)은
   * 진폭 뼈대로 감쇠하고, 행동 **내용**의 의미는 nano가 보정한다 (기행이 TALK로
   * 분류돼도 suspicion이 오른다). nano 부재 시 기존 테이블 100% (안전 fallback).
   * outcome 배율·FAIL 부호 분기·directMod는 블렌드 결과에 동일 적용.
   */
  applyActionImpact(
    state: NpcEmotionalState,
    actionType: string,
    outcome: ResolveOutcome,
    isDirectTarget: boolean = false,
    nanoImpact?: Partial<NpcEmotionalState> | null,
  ): NpcEmotionalState {
    const baseImpact = ACTION_IMPACT[actionType];
    if (!baseImpact && !nanoImpact) return state;

    // 블렌드 델타 조립 — nano 있으면 (감쇠 base + 스케일 nano), 없으면 base 그대로.
    const axes = new Set<keyof NpcEmotionalState>([
      ...(Object.keys(baseImpact ?? {}) as Array<keyof NpcEmotionalState>),
      ...(Object.keys(nanoImpact ?? {}) as Array<keyof NpcEmotionalState>),
    ]);
    const blended: Partial<Record<keyof NpcEmotionalState, number>> = {};
    for (const axis of axes) {
      const base = baseImpact?.[axis] ?? 0;
      const nano = nanoImpact?.[axis] ?? 0;
      const delta = nanoImpact
        ? Math.round(base * NANO_BASE_DAMP + nano * NANO_IMPACT_SCALE)
        : base;
      if (delta !== 0) blended[axis] = delta;
    }

    const directMod = isDirectTarget ? 1.5 : 1.0;
    const updated = { ...state };

    for (const [axis, delta] of Object.entries(blended) as Array<
      [keyof NpcEmotionalState, number]
    >) {
      let multiplier: number;
      if (outcome === 'FAIL') {
        // Sign-aware FAIL: hostile deltas stay hostile (reduced), beneficial deltas flip (weak)
        if (delta < 0) {
          multiplier = FAIL_MULTIPLIER_NEGATIVE;
        } else if (delta > 0) {
          multiplier = FAIL_MULTIPLIER_POSITIVE;
        } else {
          multiplier = 0;
        }
      } else {
        multiplier = OUTCOME_MULTIPLIER[outcome] ?? 1.0;
      }
      const adjustedDelta = Math.round(delta * multiplier * directMod);
      const currentValue = updated[axis];

      if (axis === 'trust' || axis === 'respect') {
        updated[axis] = clamp(
          currentValue + adjustedDelta,
          CLAMP_BIPOLAR.min,
          CLAMP_BIPOLAR.max,
        );
      } else {
        updated[axis] = clamp(
          currentValue + adjustedDelta,
          CLAMP_UNIPOLAR.min,
          CLAMP_UNIPOLAR.max,
        );
      }
    }

    return updated;
  }

  /**
   * 시간 경과에 따른 수동적 감정 변화 (offscreen drift).
   * fear, suspicion은 서서히 감소. attachment는 서서히 감소.
   */
  applyPassiveDrift(state: NpcEmotionalState): NpcEmotionalState {
    return {
      ...state,
      fear: clamp(state.fear - 0.5, CLAMP_UNIPOLAR.min, CLAMP_UNIPOLAR.max),
      suspicion: clamp(
        state.suspicion - 0.5,
        CLAMP_UNIPOLAR.min,
        CLAMP_UNIPOLAR.max,
      ),
      attachment: clamp(
        state.attachment - 0.3,
        CLAMP_UNIPOLAR.min,
        CLAMP_UNIPOLAR.max,
      ),
    };
  }

  /**
   * 감정 상태에서 posture 파생.
   */
  computePosture(npcState: NPCState): NpcPosture {
    return computeEffectivePosture(npcState);
  }

  /**
   * NPC의 감정 상태를 v1 호환 필드에 동기화.
   */
  syncLegacyFields(npcState: NPCState): NPCState {
    return {
      ...npcState,
      trustToPlayer: npcState.emotional.trust,
      suspicion: npcState.emotional.suspicion,
      posture: computeEffectivePosture(npcState),
    };
  }

  /**
   * Narrative Mark 트리거 체크용: 특정 축이 임계값을 넘었는지.
   */
  checkMarkTrigger(
    state: NpcEmotionalState,
    axis: keyof NpcEmotionalState,
    op: 'gt' | 'lt' | 'gte' | 'lte',
    value: number,
  ): boolean {
    const v = state[axis];
    switch (op) {
      case 'gt':
        return v > value;
      case 'lt':
        return v < value;
      case 'gte':
        return v >= value;
      case 'lte':
        return v <= value;
    }
  }

  /**
   * LLM 컨텍스트용 감정 요약.
   */
  summarizeForLlm(npcName: string, state: NpcEmotionalState): string {
    const parts: string[] = [];

    if (state.trust > 40) parts.push(`${npcName}은(는) 당신을 깊이 신뢰한다`);
    else if (state.trust > 15)
      parts.push(`${npcName}은(는) 당신을 신뢰하기 시작했다`);
    else if (state.trust < -40)
      parts.push(`${npcName}은(는) 당신을 완전히 불신한다`);
    else if (state.trust < -15) parts.push(`${npcName}은(는) 당신을 경계한다`);

    if (state.fear > 60) parts.push('극심한 공포를 느끼고 있다');
    else if (state.fear > 30) parts.push('위협을 느끼고 있다');

    if (state.respect > 40) parts.push('깊은 존경을 품고 있다');
    else if (state.respect < -30) parts.push('경멸하고 있다');

    if (state.suspicion > 60) parts.push('강한 의심을 품고 있다');
    else if (state.suspicion > 30) parts.push('수상하게 여기고 있다');

    if (state.attachment > 60) parts.push('강한 유대감을 느끼고 있다');
    else if (state.attachment > 30) parts.push('유대감을 느끼기 시작했다');

    if (parts.length === 0) return `${npcName}과(와)의 관계는 평범하다.`;
    return parts.join('. ') + '.';
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
