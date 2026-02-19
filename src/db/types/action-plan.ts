// 정본: specs/combat_engine_resolve_v1.md §1.1

import type { ActionTypeCombat, ParsedBy, PolicyResult } from './enums.js';

export type ActionUnit = {
  type: ActionTypeCombat;
  targetId?: string;
  direction?: 'LEFT' | 'RIGHT' | 'FORWARD' | 'BACK';
  meta?: Record<string, unknown>;
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
};
