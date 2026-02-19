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
  stats: PlayerDefaults['stats'];
  startingGold: number;
  startingItems: Array<{ itemId: string; qty: number }>;
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

export type NpcDefinition = {
  npcId: string;
  name: string;
  role: string;
  faction: string | null;
  hostile: boolean | 'conditional';
  combatProfile: unknown;
  title: string | null;
  aliases: string[];
  nameStyle: string;
  basePosture?: string;
  initialTrust?: number;
  agenda?: string;
};

export type SetDefinitionData = {
  setId: string;
  name: string;
  regionId: string;
  type: 'COMBAT' | 'POLITICAL';
  pieces: string[];
  bonus2: { description: string; statBonus?: Record<string, number>; specialEffect?: string };
  bonus3: { description: string; statBonus?: Record<string, number>; specialEffect?: string };
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
