// Canonical Enums (CLAUDE.md 정본)

export const NODE_TYPE = ['COMBAT', 'EVENT', 'REST', 'SHOP', 'EXIT'] as const;
export type NodeType = (typeof NODE_TYPE)[number];

export const RUN_STATUS = ['RUN_ACTIVE', 'RUN_ENDED', 'RUN_ABORTED'] as const;
export type RunStatus = (typeof RUN_STATUS)[number];

export const RUN_TYPE = ['CAPITAL', 'PROVINCE', 'BORDER'] as const;
export type RunType = (typeof RUN_TYPE)[number];

export const NODE_STATE = ['NODE_ACTIVE', 'NODE_ENDED'] as const;
export type NodeState = (typeof NODE_STATE)[number];

export const INPUT_TYPE = ['ACTION', 'CHOICE', 'SYSTEM'] as const;
export type InputType = (typeof INPUT_TYPE)[number];

export const LLM_STATUS = [
  'SKIPPED',
  'PENDING',
  'RUNNING',
  'DONE',
  'FAILED',
] as const;
export type LlmStatus = (typeof LLM_STATUS)[number];

export const EVENT_KIND = [
  'BATTLE',
  'DAMAGE',
  'STATUS',
  'LOOT',
  'GOLD',
  'QUEST',
  'NPC',
  'MOVE',
  'SYSTEM',
  'UI',
] as const;
export type EventKind = (typeof EVENT_KIND)[number];

export const POLICY_RESULT = ['ALLOW', 'TRANSFORM', 'PARTIAL', 'DENY'] as const;
export type PolicyResult = (typeof POLICY_RESULT)[number];

export const PARSED_BY = ['RULE', 'LLM', 'MERGED'] as const;
export type ParsedBy = (typeof PARSED_BY)[number];

export const DISTANCE = ['ENGAGED', 'CLOSE', 'MID', 'FAR', 'OUT'] as const;
export type Distance = (typeof DISTANCE)[number];

export const ANGLE = ['FRONT', 'SIDE', 'BACK'] as const;
export type Angle = (typeof ANGLE)[number];

export const AI_PERSONALITY = [
  'AGGRESSIVE',
  'TACTICAL',
  'COWARDLY',
  'BERSERK',
  'SNIPER',
] as const;
export type AiPersonality = (typeof AI_PERSONALITY)[number];

export const ACTION_TYPE_COMBAT = [
  'ATTACK_MELEE',
  'ATTACK_RANGED',
  'DEFEND',
  'EVADE',
  'MOVE',
  'USE_ITEM',
  'FLEE',
  'INTERACT',
] as const;
export type ActionTypeCombat = (typeof ACTION_TYPE_COMBAT)[number];

export const ACTION_TYPE_NON_COMBAT = ['TALK', 'SEARCH', 'OBSERVE'] as const;
export type ActionTypeNonCombat = (typeof ACTION_TYPE_NON_COMBAT)[number];

export const TONE_HINT = [
  'neutral',
  'tense',
  'calm',
  'mysterious',
  'triumph',
  'danger',
] as const;
export type ToneHint = (typeof TONE_HINT)[number];

export const BATTLE_PHASE = ['START', 'TURN', 'END'] as const;
export type BattlePhase = (typeof BATTLE_PHASE)[number];

export const COMBAT_OUTCOME = [
  'ONGOING',
  'VICTORY',
  'DEFEAT',
  'FLEE_SUCCESS',
] as const;
export type CombatOutcome = (typeof COMBAT_OUTCOME)[number];

export const NODE_OUTCOME = ['ONGOING', 'NODE_ENDED', 'RUN_ENDED'] as const;
export type NodeOutcome = (typeof NODE_OUTCOME)[number];

export const STATUS_EVENT_SUBKIND = ['APPLIED', 'TICKED', 'REMOVED'] as const;
export type StatusEventSubkind = (typeof STATUS_EVENT_SUBKIND)[number];

export const ROUTE_TAG = ['GUILD', 'GUARD', 'SOLO'] as const;
export type RouteTag = (typeof ROUTE_TAG)[number];

export const EDGE_CONDITION_TYPE = [
  'DEFAULT',
  'CHOICE',
  'COMBAT_OUTCOME',
] as const;
export type EdgeConditionType = (typeof EDGE_CONDITION_TYPE)[number];
