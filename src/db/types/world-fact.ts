// Living World v2: 세계 사실 시스템
// 플레이어 행동과 세계 변화가 "사실"로 누적되어 이후 상황 생성의 재료가 된다.

export const FACT_CATEGORY = [
  'PLAYER_ACTION', // 플레이어가 한 행동
  'NPC_ACTION', // NPC가 한 행동 (off-screen 포함)
  'WORLD_CHANGE', // 세계 상태 변화 (세력 교체, 조건 변경)
  'DISCOVERY', // 플레이어가 발견한 정보
  'RELATIONSHIP', // 관계 변화 사건
] as const;
export type FactCategory = (typeof FACT_CATEGORY)[number];

export interface WorldFact {
  id: string; // "fact_helped_marco_day3"
  category: FactCategory;
  text: string; // "플레이어가 마르코의 밀수를 도왔다"
  locationId: string; // 발생 장소
  involvedNpcs: string[]; // 관련 NPC ids
  turnCreated: number;
  dayCreated: number;
  tags: string[]; // ['smuggling', 'marco', 'harbor']

  // 영향도 (선택적)
  impact?: {
    reputationChanges?: Record<string, number>;
    npcKnowledge?: Record<string, string>; // npcId → 인지 경로
  };

  // 수명
  permanent: boolean; // true면 영구 보존
  expiresAtTurn?: number; // permanent=false일 때 만료 턴
}

/** WorldFact 최대 보유 개수 */
export const MAX_WORLD_FACTS = 50;
/** 비영구 fact 기본 수명 (턴) */
export const DEFAULT_FACT_TTL = 30;
