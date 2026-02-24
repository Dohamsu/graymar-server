// 정본: specs/HUB_world_state.md + architecture/Narrative_Engine_v1_Integrated_Spec.md §3

import type { IncidentRuntime } from './incident.js';
import type { SignalFeedItem } from './signal-feed.js';
import type { NarrativeMark } from './narrative-mark.js';
import type { MainArcClock } from './ending.js';
import type { OperationSession } from './operation-session.js';

export const TIME_PHASE = ['DAY', 'NIGHT'] as const;
export type TimePhase = (typeof TIME_PHASE)[number];

/** v2: 4상 시간 사이클 (DAWN=2tick, DAY=4tick, DUSK=2tick, NIGHT=4tick, 1일=12tick) */
export const TIME_PHASE_V2 = ['DAWN', 'DAY', 'DUSK', 'NIGHT'] as const;
export type TimePhaseV2 = (typeof TIME_PHASE_V2)[number];

export const HUB_SAFETY = ['SAFE', 'ALERT', 'DANGER'] as const;
export type HubSafety = (typeof HUB_SAFETY)[number];

export type DeferredEffect = {
  id: string;
  type: string;
  triggerTurnDelay: number;
  sourceTurnNo: number;
  data: Record<string, unknown>;
};

export type MainArcProgress = {
  activeArcId?: string;
  stage?: number;
  unlockedArcIds: string[];
  completedArcIds: string[];
};

export type LocationRuntimeState = {
  security: number; // 0~100 치안 수준
  crime: number; // 0~100 범죄 활동
  unrest: number; // 0~100 불안 수준
  spotlight: boolean; // 세력이 주시 중
};

/** NPC 목표 상태 (WorldTick에서 자동 진행) */
export type NpcGoalState = {
  currentGoal: string;
  progress: number; // 0~100
  blockedBy?: string; // 다른 NPC나 Incident ID
};

export type WorldState = {
  currentLocationId: string | null; // null = HUB
  timePhase: TimePhase; // v1 호환 (DAY/NIGHT)
  timeCounter: number; // 5턴마다 DAY/NIGHT 전환 (v1 호환)
  hubHeat: number; // 0~100
  hubSafety: HubSafety;
  hubHeatReasons: string[];
  tension: number; // 0~10
  mainArc: MainArcProgress;
  reputation: Record<string, number>; // factionId → 평판 (±)
  flags: Record<string, boolean>;
  deferredEffects: DeferredEffect[];
  combatWindowCount: number;
  combatWindowStart: number;
  // Phase 2 확장
  locationStates: Record<string, LocationRuntimeState>;

  // --- Narrative Engine v1 확장 ---
  globalClock: number; // 전역 틱 카운터 (0부터 시작, 매 스텝마다 증가)
  day: number; // 현재 일수 (1부터 시작, 12tick = 1일)
  phaseV2: TimePhaseV2; // 4상 시간 (DAWN/DAY/DUSK/NIGHT)
  activeIncidents: IncidentRuntime[]; // 활성 Incident 목록
  npcGoals: Record<string, NpcGoalState>; // NPC 자율 목표
  signalFeed: SignalFeedItem[]; // 시그널 피드 (최근 N개)
  narrativeMarks: NarrativeMark[]; // 획득한 내러티브 마크 (불가역)
  mainArcClock: MainArcClock; // 메인 아크 데드라인
  operationSession: OperationSession | null; // 현재 진행 중인 Operation Session
};
