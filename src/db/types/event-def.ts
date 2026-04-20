// 정본: specs/HUB_event_system.md
// @deprecated Narrative Engine v1에서 EventDefV2는 IncidentDef로 대체됨.
// Affordance, MatchPolicy는 Incident 시스템에서도 재사용.
// EventDefV2, EventTypeV2, EventPayload, EventChoice, EventEffect, Gate, ConditionCmp은
// 마이그레이션 완료 후 제거 예정.

export const AFFORDANCE = [
  'INVESTIGATE',
  'PERSUADE',
  'SNEAK',
  'BRIBE',
  'THREATEN',
  'HELP',
  'STEAL',
  'FIGHT',
  'OBSERVE',
  'TRADE',
  'ANY',
] as const;
export type Affordance = (typeof AFFORDANCE)[number];

export const MATCH_POLICY = ['SUPPORT', 'BLOCK', 'NEUTRAL'] as const;
export type MatchPolicy = (typeof MATCH_POLICY)[number];

export const EVENT_TYPE_V2 = [
  'RUMOR',
  'FACTION',
  'ARC_HINT',
  'SHOP',
  'CHECKPOINT',
  'AMBUSH',
  'ENCOUNTER',
  'OPPORTUNITY',
  'FALLBACK',
] as const;
export type EventTypeV2 = (typeof EVENT_TYPE_V2)[number];

export type ConditionCmp = {
  field: string; // dot-notation (예: 'worldState.hubHeat', 'arcState.commitment')
  op: 'eq' | 'ne' | 'gt' | 'gte' | 'lt' | 'lte';
  value: number | string | boolean;
};

export type Gate = {
  type: 'COOLDOWN_TURNS' | 'REQUIRE_FLAG' | 'REQUIRE_ARC';
  turns?: number; // COOLDOWN_TURNS 용
  flag?: string; // REQUIRE_FLAG 용
  arcId?: string; // REQUIRE_ARC 용
};

export type EventChoice = {
  id: string;
  label: string;
  hint?: string;
  affordance: Affordance;
  riskLevel?: 1 | 2 | 3;
};

export type EventEffect = {
  type:
    | 'SET_FLAG'
    | 'HEAT_DELTA'
    | 'TENSION_DELTA'
    | 'RELATION_DELTA'
    | 'GOLD_DELTA';
  target?: string;
  value: number | string | boolean;
};

/**
 * 이벤트 보상 아이템 (대화·상호작용 경로의 NPC 선물 등).
 * resolveOutcome이 condition에 매칭되면 inventory에 추가된다.
 * rewards.service.ts의 LOCATION_DROP_TABLE과 별개 경로 — payload 기반 명시적 지급.
 */
export type EventItemReward = {
  itemId: string;
  qty?: number; // 기본 1
  /** SUCCESS만 허용, 또는 SUCCESS+PARTIAL 모두 허용 */
  condition: 'SUCCESS' | 'SUCCESS_OR_PARTIAL';
};

export type EventPayload = {
  sceneFrame: string;
  primaryNpcId?: string;
  choices: EventChoice[];
  effectsOnEnter: EventEffect[];
  tags: string[];
  /** 판정 결과에 따라 지급되는 아이템 보상 (0~N개). */
  itemRewards?: EventItemReward[];
};

export type EventDefV2 = {
  eventId: string;
  locationId: string;
  eventType: EventTypeV2;
  priority: number; // 높을수록 우선
  weight: number; // 가중치 선택용
  conditions: ConditionCmp | null;
  gates: Gate[];
  affordances: Affordance[];
  friction: 0 | 1 | 2 | 3;
  matchPolicy: MatchPolicy;
  arcRouteTag?: string;
  commitmentDeltaOnSuccess?: number;
  payload: EventPayload;
  // PR5: Event Director 확장 (optional)
  eventCategory?: string; // 'atmosphere' | 'discovery' | 'interaction' | 'conflict' | 'plot'
  cooldownTurns?: number; // 간편 쿨다운 (gates COOLDOWN_TURNS 대체)
  stages?: string[]; // mainArcClock.stage 필터
  effects?: { progress?: number }; // 이벤트 진행도 효과
};
