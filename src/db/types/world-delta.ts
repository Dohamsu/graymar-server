// PR6: WorldDelta — 턴 전후 세계 상태 변화 기록

export type WorldDeltaChangeKind =
  | 'HEAT'
  | 'SAFETY'
  | 'INCIDENT_SPAWN'
  | 'INCIDENT_STAGE'
  | 'INCIDENT_RESOLVE'
  | 'REPUTATION'
  | 'NPC_POSTURE'
  | 'NARRATIVE_MARK'
  | 'TIME_PHASE';

export type WorldDeltaChange = {
  kind: WorldDeltaChangeKind;
  field: string;            // 변경된 필드 (e.g. "hubHeat", "incident:inc_01.stage")
  from: unknown;
  to: unknown;
  detail?: string;          // 한국어 설명
};

export type WorldDelta = {
  turnNo: number;
  clock: number;            // globalClock at delta
  changes: WorldDeltaChange[];
};
