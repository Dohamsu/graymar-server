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
  type: 'CLUE' | 'CONSUMABLE' | 'KEY_ITEM';
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
  maxStack?: number;
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
