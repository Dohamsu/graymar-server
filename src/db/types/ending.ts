// 정본: architecture/Narrative_Engine_v1_Integrated_Spec.md §8-9

import type { IncidentOutcome } from './incident.js';
import type { NarrativeMark } from './narrative-mark.js';

// --- Main Arc Clock ---

export type MainArcClock = {
  startDay: number;
  softDeadlineDay: number; // soft deadline day
  triggered: boolean; // soft deadline 초과 여부
};

// --- Ending Input (엔딩 생성에 필요한 데이터) ---

export type EndingInput = {
  incidentOutcomes: Array<{
    incidentId: string;
    outcome: IncidentOutcome;
    title: string;
  }>;
  npcEpilogues: Array<{
    npcId: string;
    npcName: string;
    trust: number;
    fear: number;
    respect: number;
    suspicion: number;
    attachment: number;
    posture: string;
  }>;
  narrativeMarks: NarrativeMark[];
  globalHeat: number;
  globalTension: number;
  daysSpent: number;
  reputation: Record<string, number>;
  arcRoute: string | null;
  arcCommitment: number;
  // User-Driven System v3 확장
  dominantVectors?: string[]; // 가장 많이 사용한 ApproachVector (상위 3개)
  playerThreads?: Array<{
    approachVector: string;
    goalCategory: string;
    actionCount: number;
    successCount: number;
    status: string;
  }>;
  consequenceFootprint?: {
    totalSuspicion: number; // 누적 suspicion
    totalPlayerProgress: number; // 누적 playerProgress
    totalRivalProgress: number; // 누적 rivalProgress
  };
  // Living World v2
  worldFacts?: string[]; // 영구 사실 텍스트 목록
  playerGoals?: Array<{
    description: string;
    progress: number;
    completed: boolean;
  }>;
  locationChanges?: Array<{
    locationId: string;
    security: number;
    unrest: number;
    conditions: string[];
  }>;
};

// --- Ending Result ---

export type NpcEpilogue = {
  npcId: string;
  npcName: string;
  epilogueText: string;
  finalPosture: string;
};

export type CityStatus = {
  stability: 'STABLE' | 'UNSTABLE' | 'COLLAPSED';
  summary: string;
};

export type EndingResult = {
  endingType: 'NATURAL' | 'DEADLINE' | 'PLAYER_CHOICE' | 'DEFEAT';
  npcEpilogues: NpcEpilogue[];
  cityStatus: CityStatus;
  narrativeMarks: NarrativeMark[];
  closingLine: string; // "도시는 여전히 숨 쉬고 있었다."
  statistics: {
    daysSpent: number;
    incidentsContained: number;
    incidentsEscalated: number;
    incidentsExpired: number;
    totalTurns: number;
  };
  // User-Driven System v3 확장
  playstyleSummary?: string; // "은밀하고 외교적인 용병" 등
  dominantVectors?: string[]; // 상위 ApproachVector
  threadSummary?: string; // 주요 행동 패턴 요약
  // Arc Route 분기 엔딩 (endings.json arcRouteEndings)
  arcRoute?: string | null; // 'EXPOSE_CORRUPTION' | 'PROFIT_FROM_CHAOS' | 'ALLY_GUARD' | 'NONE'
  arcTitle?: string; // 예: "정의의 대가"
  arcEpilogue?: string; // 루트별 긴 에필로그 문단
  arcRewards?: {
    gold?: number;
    reputation?: Record<string, number>;
  };
  // 플레이어 통계 기반 개인화 마지막 서술 (2~3문장)
  personalClosing?: string;
};

// --- Journey Archive Phase 1: EndingSummary ---
// RUN_ENDED 시점에 생성되어 run_sessions.endingSummary에 캐싱된다.
// 풀 EndingResult보다 압축된 "여정 정리" 템플릿 (synopsis + keyEvents + keyNpcs + finale).
// LLM 호출 없이 템플릿/기존 데이터 조합으로만 생성한다.

export type JourneyKeyEvent = {
  kind: 'INCIDENT' | 'MARK' | 'DISCOVERY';
  day?: number;
  text: string; // 1줄 한글 서술
  outcome?: 'CONTAINED' | 'ESCALATED' | 'EXPIRED';
};

export type JourneyKeyNpc = {
  npcId: string;
  npcName: string; // displayName (소개 안 된 NPC는 unknownAlias 사용)
  bondLabel: string; // "가까운 벗" | "적대" | "계산적 동맹" | "존경" | "유대" 등
  oneLine: string; // 50자 이내 엔딩 에필로그 요약
  posture: string;
};

export type EndingSummaryStability = 'STABLE' | 'UNSTABLE' | 'COLLAPSED';

export type EndingSummary = {
  runId: string;
  completedAt: string;
  characterName: string;
  presetId: string;
  presetLabel: string; // "탈영병", "밀수업자" 등 한글 라벨
  gender: 'male' | 'female';
  synopsis: string; // 3~4문장 줄거리
  keyEvents: JourneyKeyEvent[]; // 4~6건
  keyNpcs: JourneyKeyNpc[]; // 3~5명
  finale: {
    stability: EndingSummaryStability;
    arcRoute: string;
    arcTitle: string;
    closingLine: string;
    playstyleSummary?: string;
  };
  stats: {
    daysSpent: number;
    totalTurns: number;
    incidentsContained: number;
    incidentsEscalated: number;
    incidentsExpired: number;
  };
};

export type EndingSummaryCard = Pick<
  EndingSummary,
  | 'runId'
  | 'characterName'
  | 'presetId'
  | 'presetLabel'
  | 'gender'
  | 'completedAt'
> & {
  arcTitle: string;
  stability: EndingSummaryStability;
  daysSpent: number;
  totalTurns: number;
};
