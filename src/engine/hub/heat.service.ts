import { Injectable } from '@nestjs/common';
import type { WorldState } from '../../db/types/index.js';

const HEAT_DELTA_CLAMP = 8;
const HUB_RETURN_DECAY = 5;
const PAY_COST_BASE = 50;
const PAY_COST_HEAT_MULTIPLIER = 2;
const PAY_COST_PENALTY_INCREMENT = 25;
const PAY_COST_FIXED_REDUCTION = 15;

// NPC 관계 tier 기반 heat 감소량
const TIER_THRESHOLDS = [20, 40, 60, 80] as const;
const TIER_REDUCTIONS = [-5, -8, -10, -13, -16] as const;

@Injectable()
export class HeatService {
  applyHeatDelta(ws: WorldState, delta: number): WorldState {
    const clamped = Math.max(
      -HEAT_DELTA_CLAMP,
      Math.min(HEAT_DELTA_CLAMP, delta),
    );
    const newHeat = Math.max(0, Math.min(100, ws.hubHeat + clamped));
    return { ...ws, hubHeat: newHeat };
  }

  // [dead wiring 정리 2026-07-20] 구설계 calculateTurnHeat 삭제 — heatDelta 산출의
  // 정본은 resolve.service.ts(결정적). 이 메서드는 호출처 0건 + Math.random() 사용으로
  // RNG 결정론(불변식 4) 위반 소지가 있어 제거.

  applyDecay(ws: WorldState): WorldState {
    const newHeat = Math.max(0, ws.hubHeat - HUB_RETURN_DECAY);
    return { ...ws, hubHeat: newHeat };
  }

  resolveByAlly(
    ws: WorldState,
    npcId: string,
    relations: Record<string, number>,
  ): { ws: WorldState; reduction: number } {
    const score = relations[npcId] ?? 0;
    const tier = this.getTier(score);
    const reduction = TIER_REDUCTIONS[tier];
    const newHeat = Math.max(0, ws.hubHeat + reduction);
    return {
      ws: { ...ws, hubHeat: newHeat },
      reduction,
    };
  }

  resolveByCost(
    ws: WorldState,
    usageCount: number,
  ): { cost: number; ws: WorldState; reduction: number } {
    const cost =
      PAY_COST_BASE +
      ws.hubHeat * PAY_COST_HEAT_MULTIPLIER +
      usageCount * PAY_COST_PENALTY_INCREMENT;
    const reduction = -PAY_COST_FIXED_REDUCTION;
    const newHeat = Math.max(0, ws.hubHeat + reduction);
    return {
      cost,
      ws: { ...ws, hubHeat: newHeat },
      reduction,
    };
  }

  getTier(score: number): number {
    for (let i = TIER_THRESHOLDS.length - 1; i >= 0; i--) {
      if (score >= TIER_THRESHOLDS[i]) return i + 1;
    }
    return 0;
  }
}
