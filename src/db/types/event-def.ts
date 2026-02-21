// 정본: specs/HUB_event_system.md

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
  type: 'SET_FLAG' | 'HEAT_DELTA' | 'TENSION_DELTA' | 'RELATION_DELTA' | 'GOLD_DELTA';
  target?: string;
  value: number | string | boolean;
};

export type EventPayload = {
  sceneFrame: string;
  primaryNpcId?: string;
  choices: EventChoice[];
  effectsOnEnter: EventEffect[];
  tags: string[];
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
};
