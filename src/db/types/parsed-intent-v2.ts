// 정본: specs/HUB_input_processing.md

export const INTENT_ACTION_TYPE = [
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
  'TALK',
  'SEARCH',
  'MOVE_LOCATION',
  'REST',
  'SHOP',
] as const;
export type IntentActionType = (typeof INTENT_ACTION_TYPE)[number];

export const INTENT_TONE = [
  'CAUTIOUS',
  'AGGRESSIVE',
  'DIPLOMATIC',
  'DECEPTIVE',
  'NEUTRAL',
] as const;
export type IntentTone = (typeof INTENT_TONE)[number];

export type ParsedIntentV2 = {
  inputText: string;
  actionType: IntentActionType;              // primary (판정·stat 기준)
  secondaryActionType?: IntentActionType;    // secondary (매칭 확장용, optional)
  tone: IntentTone;
  target: string | null;
  riskLevel: 1 | 2 | 3;
  intentTags: string[];
  confidence: 0 | 1 | 2;
  source: 'RULE' | 'LLM' | 'CHOICE';
  suppressedActionType?: IntentActionType; // 키워드 매칭되었으나 우선순위에 밀린 actionType
  escalated?: boolean; // 고집 에스컬레이션으로 승격된 경우 true
};
