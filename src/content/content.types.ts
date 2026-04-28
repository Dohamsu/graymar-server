// 컨텐츠 시드 데이터 타입 (graymar_v1 JSON 대응)

import type { AiPersonality, Distance, Angle } from '../db/types/index.js';

export type EnemyDefinition = {
  enemyId: string;
  name: string;
  description: string;
  faction: string | null;
  hp: number;
  stats: {
    ATK: number;
    DEF: number;
    ACC: number;
    EVA: number;
    CRIT: number;
    CRIT_DMG: number;
    RESIST: number;
    SPEED: number;
  };
  personality: AiPersonality;
  defaultDistance: Distance;
  defaultAngle: Angle;
  statusImmunities: string[];
  loot: { gold: string; items?: string[] };
};

export type EncounterPositioning = {
  enemyRef: string;
  instance: number;
  distance: Distance;
  angle: Angle;
};

export type EncounterDefinition = {
  encounterId: string;
  name: string;
  description: string;
  questState: string;
  nodeType: 'COMBAT';
  nodeMeta: { isBoss: boolean };
  enemies: Array<{
    ref: string;
    count: number;
    overrides?: {
      name?: string;
      hp?: number;
      stats?: Partial<EnemyDefinition['stats']>;
      personality?: AiPersonality;
    };
  }>;
  initialPositioning: EncounterPositioning[];
  envTags: string[];
  toneHint: string;
  timePhase: string;
  rewards: {
    gold: string;
    xp: number;
    clueChance?: { itemId: string; probability: number };
  };
};

export type ItemDefinition = {
  itemId: string;
  type: 'CLUE' | 'CONSUMABLE' | 'KEY_ITEM' | 'EQUIPMENT';
  name: string;
  description?: string;
  factKey?: string;
  presentable?: boolean;
  combat?: {
    actionType: string;
    effect: string;
    value?: number;
    status?: string;
    duration?: number;
    targetSelf: boolean;
  };
  buyPrice?: number;
  sellPrice?: number;
  maxStack?: number;
  // Phase 4: Equipment 확장 필드
  rarity?: 'COMMON' | 'RARE' | 'UNIQUE' | 'LEGENDARY';
  slot?: 'WEAPON' | 'ARMOR' | 'TACTICAL' | 'POLITICAL' | 'RELIC';
  statBonus?: Record<string, number>; // { atk: 3, crit: 2 }
  setId?: string;
  narrativeTags?: string[];
  // Phase 4.1: Region Affix
  allowRegionAffix?: boolean;
  regionAffixProfileId?: string;
};

export type PlayerDefaults = {
  version: string;
  hp: number;
  stamina: number;
  stats: {
    MaxHP: number;
    MaxStamina: number;
    ATK: number;
    DEF: number;
    ACC: number;
    EVA: number;
    CRIT: number;
    CRIT_DMG: number;
    RESIST: number;
    SPEED: number;
  };
  status: unknown[];
  scenario: {
    timeStart: string;
    timePhases: string[];
    combatFrequencyPerRun: string;
    startingGold: number;
    startingItems: string[];
  };
};

export type PresetDefinition = {
  presetId: string;
  name: string;
  subtitle: string;
  description: string;
  playstyleHint: string;
  protagonistTheme: string;
  prologueHook?: string;
  stats: PlayerDefaults['stats'];
  startingGold: number;
  startingItems: Array<{ itemId: string; qty: number }>;
  /** 프리셋별 NPC 초기 posture/trust 오버라이드 (optional) */
  npcPostureOverrides?: Record<
    string,
    { posture: string; trustDelta?: number }
  >;
  /** 프리셋별 actionType 판정 보너스 (optional, +1 수준) */
  actionBonuses?: Record<string, number>;
};

/** 특성(Trait) 정의 — traits.json 대응 */
export type TraitEffects = {
  actionBonuses?: Record<string, number>;
  maxHpBonus?: number;
  maxHpPenalty?: number;
  goldBonus?: number;
  globalTrustBonus?: number;
  failToPartialChance?: number;
  criticalDisabled?: boolean;
  lowHpBonus?: { threshold50: number; threshold25: number };
  healingReduction?: number;
  nightBonus?: number;
  dayPenalty?: number;
};

export type TraitDefinition = {
  traitId: string;
  name: string;
  icon: string;
  description: string;
  effects: TraitEffects;
};

// HUB 시스템 콘텐츠 타입

export type LocationDefinition = {
  locationId: string;
  name: string;
  description: string;
  tags: string[];
  dangerLevel: number;
  availableAtNight: boolean;
  nightDescription: string;
};

export type SuggestedChoice = {
  id: string;
  label: string;
  hint?: string;
  affordance: string;
  riskLevel?: 1 | 2 | 3;
};

export type NpcPersonality = {
  core: string; // 한 줄 캐릭터 본질
  traits: string[]; // 2~3개 성격 특성
  speechStyle: string; // 말투/어조
  speechRegister?: 'HAOCHE' | 'HAEYO' | 'BANMAL' | 'HAPSYO' | 'HAECHE'; // 어체 (기본: HAOCHE)
  innerConflict: string; // 내면 갈등
  softSpot: string; // 약점/인간적 순간 트리거
  signature: string[]; // 시그니처 표현 2~3개
  npcRelations?: Record<string, string>; // 다른 NPC와의 관계 한 줄 요약
};

/** NPC 계층: CORE(핵심), SUB(서브), BACKGROUND(배경) */
export type NpcTier = 'CORE' | 'SUB' | 'BACKGROUND';

export type NpcDefinition = {
  npcId: string;
  name: string;
  unknownAlias?: string;
  shortAlias?: string;
  role: string;
  faction: string | null;
  hostile: boolean | 'conditional';
  combatProfile: unknown;
  title: string | null;
  aliases: string[];
  nameStyle: string;
  gender?: 'male' | 'female';
  basePosture?: string;
  initialTrust?: number;
  agenda?: string;
  personality?: NpcPersonality;
  /**
   * architecture/48 — 사용자 자유 호명 매칭용 역할/직책 키워드.
   * 예: 하를런 ["두목", "형제단", "복서", "보스"], 미렐라 ["노파", "약초", "약초장수"].
   * 명시 안 되면 role 필드에서 자동 추출 (turns.service.ts extractRoleKeywords).
   */
  roleKeywords?: string[];
  // Living World v2
  tier?: NpcTier; // 기본값: 'SUB'
  schedule?: import('../db/types/npc-schedule.js').NpcSchedule;
  longTermAgenda?: import('../db/types/npc-schedule.js').NpcAgenda;
  /** NPC가 알고 있는 구체적 단서 — SUCCESS 판정 시 순서대로 점진 공개 */
  knownFacts?: Array<{
    factId: string;
    detail: string;
    importance?: number;
    keywords?: string[];
    minTrust?: number;
    revealOnce?: boolean;
  }>;
  /** 이 NPC와 관련된 사건 ID 목록 */
  linkedIncidents?: string[];
  /**
   * NPC 일상 화제 풀 — fact 미매칭 시(잡담 모드) 프롬프트에 주입되는 자연 대사 후보.
   * architecture/45_npc_free_dialogue.md Phase 2.
   */
  daily_topics?: Array<{
    topicId: string;
    /** WORK / PERSONAL / GOSSIP / OPINION / WORRY 등 카테고리 */
    category: string;
    /** NPC 말투로 작성된 1~3 문장 */
    text: string;
    /** 잡담 매칭 가중치 (선택) */
    keywords?: string[];
  }>;
};

/**
 * architecture/46: Fact 일급 객체 정의 (facts.json)
 * NPC.knownFacts와 quest.facts를 통합한 단일 진실 소스.
 */
export type FactDefinition = {
  factId: string;
  /** 한 줄 화제 라벨 (사람 가독) */
  topic: string;
  /** 일반 서술 (mode C default 텍스트로도 활용) */
  description: string;
  /** 통합 키워드 (입력 매칭) */
  keywords: string[];
  /** quest stage 진행 정보 (예: "S0→S1") */
  stage?: string;
  /** 이 fact가 발견되는 장소 후보 */
  discoveryLocations?: string[];
  /** 다음 단계 힌트 */
  nextHint?: string;
  /** 이 fact를 직접 아는 NPC 목록 */
  knownBy: string[];
  /** NPC별 시각/표현 차이 — knownBy NPC들의 detail 매핑 */
  versions: Record<string, string>;
  /** 풍문/소문으로만 들은 NPC (P2 RUMORED 레이어 — 현재 빈 배열) */
  rumored?: string[];
  /** 호환: quest.json primarySources */
  primarySources?: string[];
};

export type SetDefinitionData = {
  setId: string;
  name: string;
  regionId: string;
  type: 'COMBAT' | 'POLITICAL';
  pieces: string[];
  bonus2: {
    description: string;
    statBonus?: Record<string, number>;
    specialEffect?: string;
  };
  bonus3: {
    description: string;
    statBonus?: Record<string, number>;
    specialEffect?: string;
  };
};

export type ShopDefinition = {
  shopId: string;
  locationId: string;
  name: string;
  description: string;
  refreshInterval: number;
  stockPool: string[]; // itemId 목록
  stockSize: number;
  uniqueChance: number; // 0~1
};

export type ArcEventDefinition = {
  stage: number;
  eventId: string;
  title: string;
  description: string;
  requirements: Record<string, unknown>;
  rewards: Record<string, unknown>;
};

// Phase 4a: 장비 드랍 테이블 엔트리
export type EquipmentDropItem = {
  baseItemId: string;
  chance: number; // 0~1 확률
};

export type EquipmentDropEntry = {
  enemyId?: string; // 적별 드랍 (일반 적)
  encounterId?: string; // 인카운터별 드랍 (보스전)
  locationId?: string; // 장소별 기본 드랍 (LOCATION 판정 보상)
  isBoss?: boolean;
  drops: EquipmentDropItem[];
};

export type ScenarioMetaContent = {
  scenarioId: string;
  name: string;
  description: string;
  order: number;
  prerequisites: string[];
  carryOverRules: {
    goldRate: number;
    itemsCarry: boolean;
    reputationDecay: number;
    statBonusPerScenario: Record<string, number>;
  };
};
