// 정본: specs/combat_system.md Part 0
// Living World v2: 6개 기본 스탯 + 파생 전투 스탯

/**
 * 6개 기본 스탯 체계
 * - str: 힘 — 전투 데미지, FIGHT, THREATEN
 * - dex: 민첩 — 명중, 회피, SNEAK, STEAL, OBSERVE
 * - wit: 재치 — 조사, 수색, INVESTIGATE, SEARCH
 * - con: 체질 — 체력, 방어, 저항, HELP
 * - per: 통찰 — 관찰, 발견, OBSERVE(보조)
 * - cha: 카리스마 — 설득, 뇌물, 거래, PERSUADE, BRIBE, TRADE, TALK
 */
export type PermanentStats = {
  maxHP: number;
  maxStamina: number;
  str: number;      // 힘: 전투 공격력, FIGHT/THREATEN 판정
  dex: number;      // 민첩: 명중/회피, SNEAK/STEAL/OBSERVE 판정
  wit: number;      // 재치: 분석/조사, INVESTIGATE/SEARCH 판정
  con: number;      // 체질: 방어/저항, HELP 판정
  per: number;      // 통찰: 관찰/발견, OBSERVE 보조
  cha: number;      // 카리스마: 사회적 상호작용, PERSUADE/BRIBE/TRADE 판정

  // v1 호환: 전투 시스템에서 직접 사용하는 파생값
  // 이 값들은 deriveCombatStats()로 자동 계산되며, 콘텐츠에서 직접 설정할 수도 있음
  atk?: number;      // 파생: str 기반
  def?: number;      // 파생: con 기반
  acc?: number;      // 파생: dex 기반
  eva?: number;      // 파생: dex 기반
  crit?: number;     // 파생: dex + wit 기반 (%)
  critDmg?: number;  // 파생: str 기반 (1.5 → 150)
  resist?: number;   // 파생: con 기반
  speed?: number;    // 파생: cha 기반
};

/**
 * 기본 6 스탯에서 전투용 파생 스탯 계산
 */
export function deriveCombatStats(stats: PermanentStats): Required<PermanentStats> {
  return {
    ...stats,
    atk: stats.atk ?? stats.str,
    def: stats.def ?? stats.con,
    acc: stats.acc ?? stats.dex,
    eva: stats.eva ?? Math.floor(stats.dex * 0.6),
    crit: stats.crit ?? Math.floor(stats.dex / 3) + 2,
    critDmg: stats.critDmg ?? Math.round(130 + stats.str * 2),
    resist: stats.resist ?? Math.floor(stats.con * 0.5),
    speed: stats.speed ?? stats.cha,
  };
}

export const DEFAULT_PERMANENT_STATS: PermanentStats = {
  maxHP: 100,
  maxStamina: 5,
  str: 12,    // 힘
  dex: 10,    // 민첩
  wit: 8,     // 재치
  con: 10,    // 체질
  per: 7,     // 통찰
  cha: 8,     // 카리스마
};

export type StoryProgress = {
  actLevel: number; // 1~6
  cluePoints: number;
  revealedTruths: string[];
};

export interface RunState {
  gold: number;
  hp: number;
  maxHp: number;
  stamina: number;
  maxStamina: number;
  inventory: Array<{ itemId: string; qty: number }>;
  routeTag?: string;
  branchChoiceId?: string;
  // HUB 시스템 확장 필드
  worldState?: import('./world-state.js').WorldState;
  agenda?: import('./agenda.js').PlayerAgenda;
  arcState?: import('./arc-state.js').ArcState;
  npcRelations?: Record<string, number>; // npcId -> 0~100
  eventCooldowns?: Record<string, number>; // eventId -> lastUsedTurnNo
  actionHistory?: ActionHistoryEntry[]; // 고집(insistence) 시스템용 행동 이력
  // Phase 2: NPC/관계/행동 상태
  npcStates?: Record<string, import('./npc-state.js').NPCState>;
  relationships?: Record<string, import('./npc-state.js').Relationship>;
  leverages?: import('./npc-state.js').Leverage[];
  pbp?: import('./player-behavior.js').PlayerBehaviorProfile;
  // Phase 3: Turn Orchestration
  pressure?: number; // 0~100 감정 압력
  lastPeakTurn?: number; // 마지막 peakMode 발동 턴
  // Phase 4: Equipment
  equipped?: import('./equipment.js').EquippedGear; // slot → ItemInstance
  equipmentBag?: import('./equipment.js').ItemInstance[]; // 미장착 장비 인스턴스
  // Phase 4b: Region Economy
  regionEconomy?: import('./region-state.js').RegionEconomy;
  // Phase 4d: Legendary Quest Rewards (중복 지급 방지)
  legendaryRewards?: string[];
  // LocationMemory: 장소별 개인 기록 축적
  locationMemories?: Record<string, LocationPersonalMemory>;
  // IncidentMemory: 사건별 개인 기록 축적 (Phase 2)
  incidentMemories?: Record<string, IncidentPersonalMemory>;
  // Phase 3: ItemMemory — 아이템별 획득/사용 기록 (RARE 이상)
  itemMemories?: Record<string, ItemPersonalMemory>;
  // Quest Progression: 퀘스트 단계 + 발견된 팩트 ID 추적
  questState?: string;  // "S0_ARRIVE" | "S1_GET_ANGLE" | ... | "S5_RESOLVE"
  discoveredQuestFacts?: string[];  // ["FACT_LEDGER_EXISTS", "FACT_WAGE_FRAUD_PATTERN", ...]
  /** 다음 턴 LLM 프롬프트에 전달할 퀘스트 방향 힌트 (fact 발견 턴에 저장, 다음 턴에 전달 후 초기화) */
  pendingQuestHint?: { hint: string; setAtTurn: number } | null;
  // Character customization
  characterName?: string;         // 플레이어 지정 캐릭터 이름 (1~8자)
  portraitUrl?: string;           // AI 생성 초상화 URL
  traitId?: string;               // 선택된 특성 ID (traits.json 참조)
  traitEffects?: import('../../content/content.types.js').TraitEffects;  // 런타임 참조용 특성 효과
  /** 프리셋 + 특성 합산 actionBonuses (런타임 참조용) */
  actionBonuses?: Record<string, number>;
}

/** 장소별 개인 기록 — 방문 횟수, 체류턴, 주요 사건, 발견한 비밀, 평판 메모 */
export interface LocationPersonalMemory {
  visitCount: number;
  totalTurnsSpent: number;
  lastVisitTurn: number;
  significantEvents: Array<{
    turnNo: number;
    eventSummary: string;     // "시장 분쟁 목격", "상인에게 정보 획득"
    outcome: string;           // "SUCCESS", "PARTIAL", "FAIL"
  }>;  // 최대 8개
  discoveredSecrets: string[];  // 최대 5개
  reputationNote: string;       // "상인들이 경계하는 편" (1줄)
}

/** 사건별 개인 기록 — 플레이어의 관여 이력, 확보 단서, 입장 (Phase 2: IncidentMemory) */
export interface IncidentPersonalMemory {
  discoveredTurn: number;              // 처음 관련 이벤트 발생 턴
  playerInvolvements: Array<{
    turnNo: number;
    locationId: string;
    action: string;                     // "밀수 흔적 발견", "밀수업자 추적"
    impact: string;                     // "control+10", "pressure+15"
  }>;  // 최대 8개
  knownClues: string[];                // 최대 5개
  relatedNpcIds: string[];             // 관련 NPC
  playerStance: string;                // "적극 개입" | "상황 악화" | "방관" (자동 판정)
}

/** 아이템별 개인 기록 — 획득 경위, 사용 이력, 서술 힌트 (RARE 이상만 기록) */
export interface ItemPersonalMemory {
  acquiredTurn: number;
  acquiredFrom: string;         // "항구 보스전 드랍", "시장 상점 구매", "퀘스트 보상"
  acquiredLocation: string;     // "LOC_HARBOR"
  usedInEvents: string[];       // 최대 5개 ["T22 암살 시도에 사용"]
  narrativeNote: string;        // "어둠 속에서 빛나는 단검" (서술 힌트)
}

export type ActionHistoryEntry = {
  turnNo: number;
  actionType: string;
  secondaryActionType?: string;
  suppressedActionType?: string;
  inputText: string;
  eventId?: string; // 매칭된 이벤트 ID (FALLBACK 페널티 계산용)
  choiceId?: string; // 선택된 choice ID (선택지 중복 방지용)
  primaryNpcId?: string; // 이 턴에서 상호작용한 NPC ID
  resolveOutcome?: string; // SUCCESS | PARTIAL | FAIL
};
