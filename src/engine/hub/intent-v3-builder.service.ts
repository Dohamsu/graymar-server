import { Injectable } from '@nestjs/common';
import type { ParsedIntentV2, IntentActionType } from '../../db/types/parsed-intent-v2.js';
import type {
  ParsedIntentV3,
  ApproachVector,
  IntentGoalCategory,
} from '../../db/types/parsed-intent-v3.js';

// --- actionType → approachVector 매핑 ---

const ACTION_TO_VECTOR: Record<IntentActionType, ApproachVector> = {
  BRIBE: 'ECONOMIC',
  PERSUADE: 'SOCIAL',
  TALK: 'SOCIAL',
  OBSERVE: 'OBSERVATIONAL',
  INVESTIGATE: 'OBSERVATIONAL',
  SNEAK: 'STEALTH',
  THREATEN: 'PRESSURE',
  FIGHT: 'VIOLENT',
  TRADE: 'ECONOMIC',
  STEAL: 'STEALTH',
  HELP: 'SOCIAL',
  SEARCH: 'OBSERVATIONAL',
  MOVE_LOCATION: 'LOGISTICAL',
  REST: 'LOGISTICAL',
  SHOP: 'ECONOMIC',
  // Phase 4a: 장비 관리
  EQUIP: 'LOGISTICAL',
  UNEQUIP: 'LOGISTICAL',
};

// --- actionType → 기본 goalCategory 매핑 ---

const ACTION_TO_GOAL: Record<IntentActionType, IntentGoalCategory> = {
  BRIBE: 'GAIN_ACCESS',
  PERSUADE: 'SHIFT_RELATION',
  TALK: 'GET_INFO',
  OBSERVE: 'GET_INFO',
  INVESTIGATE: 'GET_INFO',
  SNEAK: 'GAIN_ACCESS',
  THREATEN: 'ESCALATE_CONFLICT',
  FIGHT: 'ESCALATE_CONFLICT',
  TRADE: 'ACQUIRE_RESOURCE',
  STEAL: 'ACQUIRE_RESOURCE',
  HELP: 'SHIFT_RELATION',
  SEARCH: 'GET_INFO',
  MOVE_LOCATION: 'GAIN_ACCESS',
  REST: 'DEESCALATE_CONFLICT',
  SHOP: 'ACQUIRE_RESOURCE',
  // Phase 4a: 장비 관리
  EQUIP: 'ACQUIRE_RESOURCE',
  UNEQUIP: 'ACQUIRE_RESOURCE',
};

// --- target 존재 시 goalCategory 보정 ---

const TARGET_GOAL_OVERRIDES: Partial<Record<IntentActionType, IntentGoalCategory>> = {
  BRIBE: 'GET_INFO',
  SNEAK: 'HIDE_TRACE',
  TALK: 'SHIFT_RELATION',
};

// --- locationId → 한국어 표시명 매핑 ---

const LOCATION_DISPLAY_NAMES: Record<string, string> = {
  LOC_MARKET: '시장',
  LOC_GUARD: '경비대',
  LOC_HARBOR: '항만',
  LOC_SLUMS: '빈민가',
  HUB: '거점',
};

@Injectable()
export class IntentV3BuilderService {
  build(
    intentV2: ParsedIntentV2,
    rawInput: string,
    locationId: string,
    choicePayload?: Record<string, unknown>,
  ): ParsedIntentV3 {
    const primaryActionType = intentV2.actionType;
    const approachVector = ACTION_TO_VECTOR[primaryActionType] ?? 'SOCIAL';

    const secondaryApproachVector = intentV2.secondaryActionType
      ? ACTION_TO_VECTOR[intentV2.secondaryActionType] ?? null
      : null;

    const goalCategory = this.resolveGoalCategory(
      primaryActionType,
      intentV2.target,
      choicePayload,
    );

    const goalText = this.buildGoalText(
      goalCategory,
      intentV2.target,
      locationId,
    );

    const source = this.mapSource(intentV2.source);

    return {
      version: 3,
      rawInput,
      primaryActionType,
      secondaryActionType: intentV2.secondaryActionType ?? null,
      tone: intentV2.tone,
      targetText: intentV2.target,
      goalCategory,
      goalText,
      approachVector,
      secondaryApproachVector:
        secondaryApproachVector !== approachVector ? secondaryApproachVector : null,
      riskLevel: intentV2.riskLevel,
      confidence: intentV2.confidence as 0 | 1 | 2 | 3,
      source,
      intentTags: [...intentV2.intentTags],
      suppressedActionType: intentV2.suppressedActionType ?? null,
      escalated: intentV2.escalated ?? false,
    };
  }

  private resolveGoalCategory(
    actionType: IntentActionType,
    target: string | null,
    choicePayload?: Record<string, unknown>,
  ): IntentGoalCategory {
    // 선택지에 명시된 goalCategory가 있으면 우선
    if (choicePayload?.goalCategory) {
      return choicePayload.goalCategory as IntentGoalCategory;
    }

    // target이 있으면 보정 매핑 적용
    if (target) {
      const override = TARGET_GOAL_OVERRIDES[actionType];
      if (override) return override;
    }

    return ACTION_TO_GOAL[actionType] ?? 'GET_INFO';
  }

  private buildGoalText(
    goalCategory: IntentGoalCategory,
    target: string | null,
    locationId: string,
  ): string {
    const loc = LOCATION_DISPLAY_NAMES[locationId] ?? locationId ?? '현재 장소';

    if (target) {
      switch (goalCategory) {
        case 'GET_INFO':
          return `${target} 관련 정보 확보`;
        case 'GAIN_ACCESS':
          return `${target}에 대한 접근 확보`;
        case 'SHIFT_RELATION':
          return `${target}과(와)의 관계 변화`;
        case 'ACQUIRE_RESOURCE':
          return `${target} 획득`;
        case 'BLOCK_RIVAL':
          return `${target}의 행동 저지`;
        case 'CREATE_DISTRACTION':
          return `${target} 주변 주의 분산`;
        case 'HIDE_TRACE':
          return `${target} 관련 흔적 은폐`;
        case 'ESCALATE_CONFLICT':
          return `${target}과(와)의 대립 격화`;
        case 'DEESCALATE_CONFLICT':
          return `${target} 상황 완화`;
        case 'TEST_REACTION':
          return `${target}의 반응 관찰`;
      }
    }

    switch (goalCategory) {
      case 'GET_INFO':
        return `${loc}에서 정보 수집`;
      case 'GAIN_ACCESS':
        return `${loc}에서 접근 경로 확보`;
      case 'SHIFT_RELATION':
        return `${loc}에서 관계 변화 시도`;
      case 'ACQUIRE_RESOURCE':
        return `${loc}에서 자원 획득`;
      case 'BLOCK_RIVAL':
        return `경쟁 세력 저지`;
      case 'CREATE_DISTRACTION':
        return `주의 분산 시도`;
      case 'HIDE_TRACE':
        return `흔적 은폐`;
      case 'ESCALATE_CONFLICT':
        return `대립 격화`;
      case 'DEESCALATE_CONFLICT':
        return `상황 완화`;
      case 'TEST_REACTION':
        return `반응 관찰`;
    }
  }

  private mapSource(v2Source: 'RULE' | 'LLM' | 'CHOICE'): ParsedIntentV3['source'] {
    return v2Source;
  }
}
