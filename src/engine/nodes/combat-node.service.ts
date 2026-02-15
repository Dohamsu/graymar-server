// 정본: design/node_resolve_rules_v1.md §4 — COMBAT 노드

import { Injectable } from '@nestjs/common';
import type { BattleStateV1 } from '../../db/types/index.js';
import type { ActionPlan, ServerResultV1 } from '../../db/types/index.js';
import type { PermanentStats } from '../../db/types/index.js';
import type { CombatOutcome, NodeOutcome } from '../../db/types/index.js';
import {
  CombatService,
  type CombatTurnOutput,
} from '../combat/combat.service.js';
import {
  RewardsService,
  type RewardResult,
} from '../rewards/rewards.service.js';

export interface CombatNodeInput {
  turnNo: number;
  nodeId: string;
  nodeIndex: number;
  envTags: string[];
  actionPlan: ActionPlan;
  battleState: BattleStateV1;
  playerStats: PermanentStats;
  enemyStats: Record<string, PermanentStats>;
  enemyNames?: Record<string, string>;
  isBoss: boolean;
  rewardSeed: string;
  encounterRewards?: {
    clueChance?: { itemId: string; probability: number };
  };
  inventory?: Array<{ itemId: string; qty: number }>;
}

export interface CombatNodeOutput {
  nextBattleState: BattleStateV1;
  serverResult: ServerResultV1;
  nodeOutcome: NodeOutcome;
  combatOutcome: CombatOutcome;
  rewards?: RewardResult;
}

@Injectable()
export class CombatNodeService {
  constructor(
    private readonly combatService: CombatService,
    private readonly rewardsService: RewardsService,
  ) {}

  resolve(input: CombatNodeInput): CombatNodeOutput {
    const combatResult: CombatTurnOutput = this.combatService.resolveCombatTurn(
      {
        turnNo: input.turnNo,
        node: { id: input.nodeId, type: 'COMBAT', index: input.nodeIndex },
        envTags: input.envTags,
        actionPlan: input.actionPlan,
        battleState: input.battleState,
        playerStats: input.playerStats,
        enemyStats: input.enemyStats,
        enemyNames: input.enemyNames,
        inventory: input.inventory,
      },
    );

    let nodeOutcome: NodeOutcome = 'ONGOING';
    let rewards: RewardResult | undefined;

    switch (combatResult.combatOutcome) {
      case 'VICTORY':
        nodeOutcome = 'NODE_ENDED';
        rewards = this.rewardsService.calculateCombatRewards({
          enemies: Object.keys(input.enemyStats),
          isBoss: input.isBoss,
          seed: input.rewardSeed,
          encounterRewards: input.encounterRewards,
        });
        // 보상을 serverResult에 반영
        if (rewards) {
          combatResult.serverResult.diff.inventory.goldDelta = rewards.gold;
          combatResult.serverResult.diff.inventory.itemsAdded = rewards.items;
          for (const item of rewards.items) {
            combatResult.serverResult.events.push({
              id: `loot_${item.itemId}`,
              kind: 'LOOT',
              text: `${item.itemId} x${item.qty} 획득`,
              tags: ['LOOT'],
              data: { itemId: item.itemId, qty: item.qty },
            });
          }
          if (rewards.gold > 0) {
            combatResult.serverResult.events.push({
              id: `gold_${input.turnNo}`,
              kind: 'GOLD',
              text: `${rewards.gold} 골드 획득`,
              tags: ['GOLD'],
              data: { gold: rewards.gold },
            });
          }
        }
        break;
      case 'DEFEAT':
        nodeOutcome = 'NODE_ENDED';
        break;
      case 'FLEE_SUCCESS':
        nodeOutcome = 'NODE_ENDED';
        break;
    }

    return {
      nextBattleState: combatResult.nextBattleState,
      serverResult: combatResult.serverResult,
      nodeOutcome,
      combatOutcome: combatResult.combatOutcome,
      rewards,
    };
  }
}
