// Living World v2: 장소 동적 상태
// 장소는 고정된 이벤트 풀이 아니라, 자체 상태를 가진 동적 공간.

export interface LocationCondition {
  id: string; // 'CURFEW', 'FESTIVAL', 'LOCKDOWN', 'BLACK_MARKET' 등
  source: string; // 발생 원인 (incidentId, npcAction, playerAction)
  startTurn: number;
  duration: number; // -1 = 영구 (해제 조건 별도)
  effects: {
    securityMod: number;
    prosperityMod: number;
    unrestMod: number;
    blockedActions?: string[]; // 이 장소에서 불가능한 행동
    boostedActions?: string[]; // 이 장소에서 유리한 행동
  };
}

export interface LocationDynamicState {
  locationId: string;

  // 세력 통제
  controllingFaction: string | null;
  controlStrength: number; // 0~100
  contestedBy?: string; // 통제권 도전 세력

  // 환경 수치
  security: number; // 0~100 (치안)
  prosperity: number; // 0~100 (경제 활성도)
  unrest: number; // 0~100 (민심 불안)

  // 동적 조건
  activeConditions: LocationCondition[];

  // NPC 존재
  presentNpcs: string[]; // 현재 이 장소에 있는 NPC ids

  // 이력
  recentEventIds: string[]; // 최근 5개 발생 상황 id (중복 방지용)
  playerVisitCount: number;
  lastVisitTurn: number;

  // [arch/76 D3-a] 물리 흔적 — 플레이어 행동이 장소에 남긴 지속적 변화.
  //   nano가 서술에서 추출(생성 아님) → 다음 턴 서술·NPC 반응이 참조. 링버퍼(max 6).
  //   narrative-only: 판정·전투·수치에 영향 없음(불변식 1·2).
  propsTraces?: PropsTrace[];
}

/** 장소 물리 흔적 1건 (arch/76 D3-a) */
export interface PropsTrace {
  text: string; // 짧은 명사구 예: "부서진 좌판", "쓰러진 진열대"
  turnCreated: number;
}

/** 장소당 물리 흔적 최대 개수 (링버퍼) */
export const MAX_PROPS_TRACES_PER_LOCATION = 6;

/** 장소 인접 관계 정의 (콘텐츠 데이터에서 로드) */
export interface LocationAdjacency {
  locationId: string;
  adjacentLocations: string[];
}

/** LocationCondition 최대 개수 (장소당) */
export const MAX_CONDITIONS_PER_LOCATION = 3;
