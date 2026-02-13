// 정본: design/combat_engine_resolve_v1.md §1.1 — Intent → ActionPlan 변환

import { Injectable } from '@nestjs/common';
import type { ActionPlan, ActionUnit } from '../../db/types/index.js';
import type { ParsedIntent } from '../../db/types/index.js';
import type { ActionTypeCombat, PolicyResult, ParsedBy } from '../../db/types/index.js';

const COMBAT_ACTION_SET = new Set<string>([
  'ATTACK_MELEE', 'ATTACK_RANGED', 'DEFEND', 'EVADE',
  'MOVE', 'USE_ITEM', 'FLEE', 'INTERACT',
]);

@Injectable()
export class ActionPlanService {
  /**
   * ParsedIntent → ActionPlan
   * - 슬롯 cap = 3 (base 2 + bonus 1)
   * - 스태미나 비용: 기본 Action = 1, 보너스 Action = 2
   */
  buildPlan(
    intent: ParsedIntent,
    policyResult: PolicyResult,
    currentStamina: number,
    bonusAvailable: boolean = false,
  ): ActionPlan {
    const units: ActionUnit[] = [];
    let staminaCost = 0;

    // combat intent만 ActionUnit으로 변환
    const combatIntents = intent.intents.filter((i) =>
      COMBAT_ACTION_SET.has(i),
    ) as ActionTypeCombat[];

    // 기본 2 슬롯 제한
    const baseSlots = Math.min(combatIntents.length, 2);

    for (let i = 0; i < baseSlots; i++) {
      units.push({
        type: combatIntents[i],
        targetId: intent.targets[0],
        direction: intent.direction as ActionUnit['direction'],
      });
      staminaCost += 1;
    }

    // 보너스 슬롯 (3번째 행동, 비용 2)
    let bonusUsed = false;
    if (
      bonusAvailable &&
      combatIntents.length > 2 &&
      currentStamina >= staminaCost + 2
    ) {
      units.push({
        type: combatIntents[2],
        targetId: intent.targets[0],
        direction: intent.direction as ActionUnit['direction'],
      });
      staminaCost += 2;
      bonusUsed = true;
    }

    // 비전투 인텐트만 있는 경우 (EVENT/REST/SHOP 등)
    if (units.length === 0 && intent.intents.length > 0) {
      // 비전투 행동은 INTERACT로 매핑
      units.push({
        type: 'INTERACT',
        meta: { originalIntent: intent.intents[0] },
      });
      staminaCost = 0;
    }

    return {
      units,
      consumedSlots: {
        base: 2,
        used: Math.min(units.length, 2),
        bonusUsed,
      },
      staminaCost,
      policyResult,
      parsedBy: intent.source as ParsedBy,
    };
  }
}
