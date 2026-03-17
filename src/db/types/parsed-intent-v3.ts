// 정본: architecture/14_user_driven_code_bridge.md §5

import type { IntentActionType, IntentTone } from './parsed-intent-v2.js';

// --- Approach Vector (행동 접근 방식) ---

export const APPROACH_VECTOR = [
  'SOCIAL',
  'STEALTH',
  'PRESSURE',
  'ECONOMIC',
  'OBSERVATIONAL',
  'POLITICAL',
  'LOGISTICAL',
  'VIOLENT',
] as const;
export type ApproachVector = (typeof APPROACH_VECTOR)[number];

// --- Intent Goal Category (행동 목표 범주) ---

export const INTENT_GOAL_CATEGORY = [
  'GET_INFO',
  'GAIN_ACCESS',
  'SHIFT_RELATION',
  'ACQUIRE_RESOURCE',
  'BLOCK_RIVAL',
  'CREATE_DISTRACTION',
  'HIDE_TRACE',
  'ESCALATE_CONFLICT',
  'DEESCALATE_CONFLICT',
  'TEST_REACTION',
] as const;
export type IntentGoalCategory = (typeof INTENT_GOAL_CATEGORY)[number];

// --- ParsedIntent V3 ---

export type ParsedIntentV3 = {
  version: 3;
  rawInput: string;
  primaryActionType: IntentActionType;
  secondaryActionType?: IntentActionType | null;
  tone: IntentTone;
  targetText?: string | null;
  goalCategory: IntentGoalCategory;
  goalText: string;
  approachVector: ApproachVector;
  secondaryApproachVector?: ApproachVector | null;
  riskLevel: 1 | 2 | 3;
  confidence: 0 | 1 | 2 | 3;
  source: 'LLM' | 'RULE' | 'CHOICE' | 'HYBRID';
  intentTags: string[];
  suppressedActionType?: IntentActionType | null;
  escalated?: boolean;
};
