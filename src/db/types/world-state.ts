// 정본: specs/HUB_world_state.md

export const TIME_PHASE = ['DAY', 'NIGHT'] as const;
export type TimePhase = (typeof TIME_PHASE)[number];

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

export type WorldState = {
  currentLocationId: string | null; // null = HUB
  timePhase: TimePhase;
  timeCounter: number; // 5턴마다 DAY/NIGHT 전환
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
  incidentFlags: Record<string, boolean>;
};
