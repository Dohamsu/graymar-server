// 정본: specs/battlestate_storage_recovery_v1.md §2
// 확장: architecture/41_creative_combat_actions.md §6.2 — 환경 소품 스냅샷

import type { AiPersonality, Angle, BattlePhase, Distance } from './enums.js';
import type { PropEffects } from './action-plan.js';

export type StatusInstance = {
  id: string;
  sourceId: string;
  applierId: string;
  duration: number;
  stacks: number;
  power: number;
  meta?: Record<string, unknown>;
};

/** 전투 씬 환경 소품 (Tier 1) — 전투 동안만 유효, oneTimeUse 사용 시 제거 */
export type BattleEnvironmentProp = {
  id: string;
  name: string;
  keywords: string[];
  effects: PropEffects;
  oneTimeUse?: boolean;
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
  /** Tier 1 등록 프롭 스냅샷 — 생략 시 Tier 1 비활성 */
  environmentProps?: BattleEnvironmentProp[];
};
