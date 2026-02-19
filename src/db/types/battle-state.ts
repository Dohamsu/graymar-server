// 정본: specs/battlestate_storage_recovery_v1.md §2

import type { AiPersonality, Angle, BattlePhase, Distance } from './enums.js';

export type StatusInstance = {
  id: string;
  sourceId: string;
  applierId: string;
  duration: number;
  stacks: number;
  power: number;
  meta?: Record<string, unknown>;
};

export type BattleStateV1 = {
  version: 'battle_state_v1';
  phase: BattlePhase;
  lastResolvedTurnNo: number;
  rng: {
    seed: string;
    cursor: number;
  };
  env: string[];
  player: {
    hp: number;
    stamina: number;
    status: StatusInstance[];
  };
  enemies: Array<{
    id: string;
    name?: string;
    hp: number;
    maxHp?: number;
    status: StatusInstance[];
    personality: AiPersonality;
    distance: Distance;
    angle: Angle;
  }>;
};
