// 정본: specs/combat_system.md Part 0

export type PermanentStats = {
  maxHP: number;
  maxStamina: number;
  atk: number;
  def: number;
  acc: number;
  eva: number;
  crit: number; // % (정수)
  critDmg: number; // 1.5 → 150 (정수 저장, /100으로 사용)
  resist: number;
  speed: number;
};

export const DEFAULT_PERMANENT_STATS: PermanentStats = {
  maxHP: 100,
  maxStamina: 5,
  atk: 15,
  def: 10,
  acc: 5,
  eva: 3,
  crit: 5,
  critDmg: 150,
  resist: 5,
  speed: 5,
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
}

export type ActionHistoryEntry = {
  turnNo: number;
  actionType: string;
  suppressedActionType?: string;
  inputText: string;
  eventId?: string; // 매칭된 이벤트 ID (FALLBACK 페널티 계산용)
  choiceId?: string; // 선택된 choice ID (선택지 중복 방지용)
};
