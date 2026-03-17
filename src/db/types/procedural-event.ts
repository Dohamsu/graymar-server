// PR7: Procedural Event 타입 정의 (설계문서 20)

export interface ProceduralSeed {
  id: string;
  text: string;
  locationIds?: string[];   // 빈 배열 = 모든 LOCATION
  timePhases?: string[];    // 빈 배열 = 모든 시간대
  npcId?: string;           // 관련 NPC
  tags?: string[];
}

export interface SeedConstraints {
  locationId: string;
  timePhase: string;
  stage?: string;
  activeNpcIds?: string[];
}

export interface ProceduralHistoryEntry {
  turnNo: number;
  triggerId: string;
  subjectId: string;
  actionId: string;
  outcomeId: string;
  npcId?: string;
  subjectActionKey: string; // `${subjectId}:${actionId}`
}
