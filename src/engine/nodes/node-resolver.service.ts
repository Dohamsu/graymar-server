// 정본: specs/node_resolve_rules_v1.md — 통합 노드 리졸버 (노드 타입별 분기)

import { Injectable } from '@nestjs/common';
import type { NodeType, NodeOutcome } from '../../db/types/index.js';
import type {
  ServerResultV1,
  ActionPlan,
  BattleStateV1,
} from '../../db/types/index.js';
import type { PermanentStats } from '../../db/types/index.js';
import type { NodeMeta } from '../../db/types/index.js';
import { CombatNodeService } from './combat-node.service.js';
import { EventNodeService, type EventNodeState } from './event-node.service.js';
import { RestNodeService } from './rest-node.service.js';
import { ShopNodeService, type ShopNodeState } from './shop-node.service.js';
import { ExitNodeService } from './exit-node.service.js';
import { InternalError } from '../../common/errors/game-errors.js';

export interface NodeResolveInput {
  turnNo: number;
  nodeId: string;
  nodeIndex: number;
  nodeType: NodeType;
  nodeMeta?: NodeMeta;
  envTags: string[];
  inputType: 'ACTION' | 'CHOICE' | 'SYSTEM';
  rawInput: string;
  choiceId?: string;
  actionPlan?: ActionPlan;

  // COMBAT 전용
  battleState?: BattleStateV1;
  playerStats: PermanentStats;
  enemyStats?: Record<string, PermanentStats>;
  enemyNames?: Record<string, string>;
  rewardSeed?: string;
  encounterRewards?: {
    clueChance?: { itemId: string; probability: number };
  };

  // 플레이어 현재 상태
  playerHp: number;
  playerMaxHp: number;
  playerStamina: number;
  playerMaxStamina: number;
  playerGold: number;
  inventoryCount: number;
  inventoryMax: number;

  // 인벤토리 (COMBAT USE_ITEM용)
  inventory?: Array<{ itemId: string; qty: number }>;

  // 노드 상태 (EVENT, SHOP)
  nodeState?: Record<string, unknown>;
}

export interface NodeResolveOutput {
  serverResult: ServerResultV1;
  nodeOutcome: NodeOutcome;
  nextBattleState?: BattleStateV1;
  nextNodeState?: Record<string, unknown>;
  goldDelta?: number;
  itemsBought?: Array<{ itemId: string; qty: number }>;
  hpDelta?: number;
  staminaDelta?: number;
  combatOutcome?: string;
  selectedChoiceId?: string;
}

@Injectable()
export class NodeResolverService {
  constructor(
    private readonly combatNode: CombatNodeService,
    private readonly eventNode: EventNodeService,
    private readonly restNode: RestNodeService,
    private readonly shopNode: ShopNodeService,
    private readonly exitNode: ExitNodeService,
  ) {}

  resolve(input: NodeResolveInput): NodeResolveOutput {
    switch (input.nodeType) {
      case 'COMBAT':
        return this.resolveCombat(input);
      case 'EVENT':
        return this.resolveEvent(input);
      case 'REST':
        return this.resolveRest(input);
      case 'SHOP':
        return this.resolveShop(input);
      case 'EXIT':
        return this.resolveExit(input);
      default:
        throw new InternalError(
          `Unknown node type: ${input.nodeType as string}`,
        );
    }
  }

  private resolveCombat(input: NodeResolveInput): NodeResolveOutput {
    if (!input.battleState || !input.actionPlan || !input.enemyStats) {
      throw new InternalError(
        'COMBAT node requires battleState, actionPlan, and enemyStats',
      );
    }

    const result = this.combatNode.resolve({
      turnNo: input.turnNo,
      nodeId: input.nodeId,
      nodeIndex: input.nodeIndex,
      envTags: input.envTags,
      actionPlan: input.actionPlan,
      battleState: input.battleState,
      playerStats: input.playerStats,
      enemyStats: input.enemyStats,
      enemyNames: input.enemyNames,
      isBoss: input.nodeMeta?.isBoss ?? false,
      rewardSeed: input.rewardSeed ?? input.battleState.rng.seed,
      encounterRewards: input.encounterRewards,
      inventory: input.inventory,
    });

    // combatOutcome 추출: nodeOutcome이 NODE_ENDED이면 VICTORY (패배/도주는 별도 처리)
    let combatOutcome: string | undefined;
    if (result.nodeOutcome === 'NODE_ENDED') {
      combatOutcome = 'VICTORY';
    }

    return {
      serverResult: result.serverResult,
      nodeOutcome: result.nodeOutcome,
      nextBattleState: result.nextBattleState,
      combatOutcome,
    };
  }

  private resolveEvent(input: NodeResolveInput): NodeResolveOutput {
    const state = (input.nodeState as unknown as EventNodeState) ?? {
      eventId: input.nodeMeta?.eventId ?? 'default',
      stage: 0,
      maxStage: 2,
      choicesMade: [] as string[],
    };

    const result = this.eventNode.resolve({
      turnNo: input.turnNo,
      nodeId: input.nodeId,
      nodeIndex: input.nodeIndex,
      inputType: input.inputType as 'ACTION' | 'CHOICE',
      choiceId: input.choiceId,
      rawInput: input.rawInput,
      nodeState: state,
    });

    // EVENT 종료 시 마지막 선택 ID 추출 (분기용)
    let selectedChoiceId: string | undefined;
    if (result.nodeOutcome === 'NODE_ENDED' && result.nextNodeState) {
      const ns = result.nextNodeState as { choicesMade?: string[] };
      if (ns.choicesMade && ns.choicesMade.length > 0) {
        selectedChoiceId = ns.choicesMade[ns.choicesMade.length - 1];
      }
    }

    return {
      serverResult: result.serverResult,
      nodeOutcome: result.nodeOutcome,
      nextNodeState: result.nextNodeState as unknown as Record<string, unknown>,
      selectedChoiceId,
    };
  }

  private resolveRest(input: NodeResolveInput): NodeResolveOutput {
    const result = this.restNode.resolve({
      turnNo: input.turnNo,
      nodeId: input.nodeId,
      nodeIndex: input.nodeIndex,
      choiceId: input.choiceId,
      playerHp: input.playerHp,
      playerMaxHp: input.playerMaxHp,
      playerStamina: input.playerStamina,
      playerMaxStamina: input.playerMaxStamina,
    });

    return {
      serverResult: result.serverResult,
      nodeOutcome: result.nodeOutcome,
      hpDelta: result.hpRecovered,
      staminaDelta: result.staminaRecovered,
    };
  }

  private resolveShop(input: NodeResolveInput): NodeResolveOutput {
    const state = (input.nodeState as unknown as ShopNodeState) ?? {
      shopId: input.nodeMeta?.shopId ?? 'default',
      catalog: [] as import('./shop-node.service.js').ShopItem[],
      playerGold: input.playerGold,
    };

    const result = this.shopNode.resolve({
      turnNo: input.turnNo,
      nodeId: input.nodeId,
      nodeIndex: input.nodeIndex,
      choiceId: input.choiceId,
      nodeState: state,
      playerGold: input.playerGold,
      inventoryCount: input.inventoryCount,
      inventoryMax: input.inventoryMax,
    });

    return {
      serverResult: result.serverResult,
      nodeOutcome: result.nodeOutcome,
      nextNodeState: result.nextNodeState as unknown as Record<string, unknown>,
      goldDelta: -result.goldSpent,
      itemsBought: result.itemsBought,
    };
  }

  private resolveExit(input: NodeResolveInput): NodeResolveOutput {
    const result = this.exitNode.resolve({
      turnNo: input.turnNo,
      nodeId: input.nodeId,
      nodeIndex: input.nodeIndex,
      choiceId: input.choiceId,
    });

    return {
      serverResult: result.serverResult,
      nodeOutcome: result.nodeOutcome,
    };
  }
}
