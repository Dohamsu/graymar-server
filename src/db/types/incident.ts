// 정본: architecture/Narrative_Engine_v1_Integrated_Spec.md §4

import type { Affordance, MatchPolicy } from './event-def.js';

// --- Incident Outcome ---

export const INCIDENT_OUTCOME = ['CONTAINED', 'ESCALATED', 'EXPIRED'] as const;
export type IncidentOutcome = (typeof INCIDENT_OUTCOME)[number];

// --- Incident Kind ---

export const INCIDENT_KIND = [
  'POLITICAL',
  'CRIMINAL',
  'ECONOMIC',
  'SOCIAL',
  'MILITARY',
] as const;
export type IncidentKind = (typeof INCIDENT_KIND)[number];

// --- Signal Template ---

export type SignalTemplate = {
  channel: string;
  severity: 1 | 2 | 3 | 4 | 5;
  textTemplate: string; // e.g. "{{npcName}}이(가) {{location}}에서 목격되었다"
  triggerStage: number;
  triggerPressure?: number; // pressure 임계값 도달 시 생성
};

// --- Incident Stage Definition ---

export type IncidentStageDef = {
  stage: number;
  description: string;
  affordances: Affordance[];
  matchPolicy: MatchPolicy;
  pressurePerTick: number; // 틱당 자동 pressure 증가량
  controlReward: number; // 성공 시 control 증가량
  controlPenalty: number; // 실패 시 control 감소량
  sceneFrame: string; // 분위기 텍스트
  choices?: Array<{
    id: string;
    label: string;
    hint?: string;
    affordance: Affordance;
  }>;
};

// --- Incident Definition (콘텐츠 데이터) ---

export type IncidentDef = {
  incidentId: string;
  kind: IncidentKind;
  title: string;
  description: string;
  locationId: string; // 주 발생 장소
  priority: number;
  weight: number;
  spawnConditions: {
    minDay?: number;
    maxDay?: number;
    minHeat?: number;
    requiredFlags?: string[];
    requiredReputation?: Record<string, { op: 'gt' | 'lt' | 'gte' | 'lte'; value: number }>;
  };
  stages: IncidentStageDef[];
  signalTemplates: SignalTemplate[];
  resolutionConditions: {
    controlThreshold: number; // default 80
    pressureThreshold: number; // default 95
    deadlineTicks: number; // deadline (globalClock 기준)
  };
  impactOnResolve: {
    CONTAINED: IncidentImpactPatch;
    ESCALATED: IncidentImpactPatch;
    EXPIRED: IncidentImpactPatch;
  };
  relatedNpcIds: string[];
  tags: string[];
  isCritical: boolean; // true면 엔딩 조건에 포함
};

// --- Incident Runtime (RunState에 저장) ---

export type IncidentRuntime = {
  incidentId: string;
  kind: IncidentKind;
  stage: number;
  control: number; // 0~100
  pressure: number; // 0~100
  deadlineClock: number; // 만료 globalClock
  spawnedAtClock: number;
  resolved: boolean;
  outcome?: IncidentOutcome;
  historyLog: IncidentHistoryEntry[];
};

// --- Incident Impact Patch ---

export type IncidentImpactPatch = {
  heatDelta: number;
  tensionDelta: number;
  reputationChanges: Record<string, number>;
  flagsSet: string[];
  npcEmotionalChanges?: Record<string, Record<string, number>>; // npcId → axis → delta
  spawnIncidentId?: string; // 체인 Incident 트리거
};

// --- Incident History Entry ---

export type IncidentHistoryEntry = {
  clock: number;
  action: 'SPAWN' | 'STAGE_ADVANCE' | 'CONTROL_CHANGE' | 'PRESSURE_CHANGE' | 'RESOLVE';
  detail: string;
  controlDelta?: number;
  pressureDelta?: number;
};
