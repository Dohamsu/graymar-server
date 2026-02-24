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
  endingType: 'NATURAL' | 'DEADLINE' | 'PLAYER_CHOICE';
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
};
