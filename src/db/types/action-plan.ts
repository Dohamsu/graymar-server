// 정본: specs/combat_engine_resolve_v1.md §1.1
// 확장: architecture/41_creative_combat_actions.md §2 — 창의 전투(Tier 1~5)

import type { ActionTypeCombat, ParsedBy, PolicyResult } from './enums.js';

export type ActionUnit = {
  type: ActionTypeCombat;
  targetId?: string;
  direction?: 'LEFT' | 'RIGHT' | 'FORWARD' | 'BACK';
  meta?: Record<string, unknown>;
};

/** 창의 전투 프롭 효과 — Tier 1/2 공용 */
export type PropEffects = {
  damageBonus?: number;
  stunChance?: number;
  bleedStacks?: number;
  blindTurns?: number;
  accReduceTarget?: number;
  defBuffNextTurn?: number;
  restrainTurns?: number;
};

export type ActionPlan = {
  units: ActionUnit[];
  consumedSlots: {
    base: number;
    used: number;
    bonusUsed: boolean;
  };
  staminaCost: number;
  policyResult: PolicyResult;
  parsedBy: ParsedBy;
  /** Tier 1~5 창의 전투 분류 — 생략 시 Tier 3 (일반 서술) */
  tier?: 1 | 2 | 3 | 4 | 5;
  /** Tier 1 등록 프롭 */
  prop?: { id: string; name: string; effects: PropEffects };
  /** Tier 2 즉흥 카테고리 */
  improvised?: { categoryId: string; effects: PropEffects };
  /** Tier 4/5 플래그 */
  flags?: { fantasy?: boolean; abstract?: boolean };
  /** 성향 추적 제외 (Tier 4/5 turns) */
  excludeFromArcRoute?: boolean;
  excludeFromCommitment?: boolean;
};
