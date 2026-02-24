// 정본: 기억 시스템 구조화 재설계 스펙

import type { NpcEmotionalState, NpcPosture } from './npc-state.js';
import type { IncidentKind, IncidentOutcome } from './incident.js';
import type { IntentActionType } from './parsed-intent-v2.js';
import type { ResolveOutcome } from './resolve-result.js';
import type { ArcRoute } from './arc-state.js';
import type { HubSafety, TimePhaseV2 } from './world-state.js';

// ─── StructuredMemory (run_memories.structuredMemory JSONB) ───

export interface StructuredMemory {
  version: 2;
  visitLog: VisitLogEntry[];
  npcJournal: NpcJournalEntry[];
  incidentChronicle: IncidentChronicleEntry[];
  milestones: MilestoneEntry[];
  worldSnapshot: WorldMemorySnapshot;
  llmExtracted: LlmExtractedFact[];
}

// ─── VisitLogEntry (방문 기록) ───

export interface VisitAction {
  rawInput: string; // 최대 30자
  actionType: IntentActionType;
  outcome: ResolveOutcome;
  eventId?: string;
  brief: string; // 최대 40자
}

export interface VisitLogEntry {
  locationId: string;
  locationName: string;
  day: number;
  phase: TimePhaseV2;
  turnRange: [number, number]; // [시작턴, 종료턴]
  actions: VisitAction[]; // 최대 5개
  npcsEncountered: string[];
  outcomes: { success: number; partial: number; fail: number };
  reputationChanges: Record<string, number>;
  goldDelta: number;
  summaryText: string; // 최대 150자
  importance: number; // 0.0~1.0
}

// ─── NpcJournalEntry (NPC 관계 일지) ───

export interface NpcInteraction {
  turnNo: number;
  locationId: string;
  actionType: IntentActionType;
  outcome: ResolveOutcome;
  emotionalDelta: Partial<NpcEmotionalState>;
  snippet: string; // 최대 50자
}

export interface NpcJournalEntry {
  npcId: string;
  npcName: string;
  interactions: NpcInteraction[]; // 최대 5개
  latestEmotional: NpcEmotionalState & { posture: NpcPosture };
  marks: string[]; // NPC 관련 획득 마크
  summaryText: string; // 최대 100자
}

// ─── IncidentChronicleEntry (사건 연대기) ───

export interface IncidentInvolvement {
  turnNo: number;
  locationId: string;
  actionType: IntentActionType;
  outcome: ResolveOutcome;
  controlDelta: number;
  pressureDelta: number;
  snippet: string; // 최대 50자
}

export interface IncidentChronicleEntry {
  incidentId: string;
  kind: IncidentKind;
  title: string;
  resolved: boolean;
  outcome?: IncidentOutcome;
  playerInvolvements: IncidentInvolvement[]; // 최대 5개
  impactSummary?: string; // 최대 100자
  finalControl?: number;
  finalPressure?: number;
}

// ─── MilestoneEntry (서사 이정표, 영구 보존) ───

export const MILESTONE_TYPE = [
  'MARK_ACQUIRED',
  'ARC_COMMITTED',
  'INCIDENT_RESOLVED',
  'COMBAT_VICTORY',
  'NPC_POSTURE_CHANGE',
  'FIRST_VISIT',
  'REPUTATION_SHIFT',
] as const;
export type MilestoneType = (typeof MILESTONE_TYPE)[number];

export interface MilestoneEntry {
  type: MilestoneType;
  turnNo: number;
  day: number;
  detail: string; // 최대 100자
  importance: number; // 0.0~1.0
  relatedNpcId?: string;
  relatedIncidentId?: string;
}

// ─── WorldMemorySnapshot (세계 스냅샷, 최신 1개) ───

export interface WorldMemorySnapshot {
  day: number;
  timePhase: TimePhaseV2;
  hubHeat: number;
  hubSafety: HubSafety;
  reputation: Record<string, number>;
  activeIncidentCount: number;
  resolvedIncidentCount: number;
  arcRoute?: ArcRoute;
  arcCommitment: number;
  updatedAtTurnNo: number;
}

// ─── LlmExtractedFact (LLM 추출 사실) ───

export const LLM_FACT_CATEGORY = [
  'NPC_DETAIL',
  'PLACE_DETAIL',
  'PLOT_HINT',
  'ATMOSPHERE',
] as const;
export type LlmFactCategory = (typeof LLM_FACT_CATEGORY)[number];

export interface LlmExtractedFact {
  turnNo: number;
  category: LlmFactCategory;
  text: string; // 최대 50자
  relatedNpcId?: string;
  relatedLocationId?: string;
  importance: number; // 0.5~1.0
}

// ─── VisitContextCache (node_memories.visitContext JSONB) ───

export interface VisitContextCache {
  locationId: string;
  startTurnNo: number;
  actions: VisitAction[];
  npcsEncountered: string[];
  eventIds: string[];
  outcomes: { success: number; partial: number; fail: number };
  reputationChanges: Record<string, number>;
  goldDelta: number;
  npcEmotionalDeltas: Record<string, Partial<NpcEmotionalState>>;
  incidentInvolvements: Array<{
    incidentId: string;
    controlDelta: number;
    pressureDelta: number;
  }>;
  marksAcquired: string[];
}

// ─── Factory ───

export function createEmptyStructuredMemory(): StructuredMemory {
  return {
    version: 2,
    visitLog: [],
    npcJournal: [],
    incidentChronicle: [],
    milestones: [],
    worldSnapshot: {
      day: 1,
      timePhase: 'DAWN',
      hubHeat: 0,
      hubSafety: 'SAFE',
      reputation: {},
      activeIncidentCount: 0,
      resolvedIncidentCount: 0,
      arcCommitment: 0,
      updatedAtTurnNo: 0,
    },
    llmExtracted: [],
  };
}

export function createEmptyVisitContext(
  locationId: string,
  startTurnNo: number,
): VisitContextCache {
  return {
    locationId,
    startTurnNo,
    actions: [],
    npcsEncountered: [],
    eventIds: [],
    outcomes: { success: 0, partial: 0, fail: 0 },
    reputationChanges: {},
    goldDelta: 0,
    npcEmotionalDeltas: {},
    incidentInvolvements: [],
    marksAcquired: [],
  };
}
