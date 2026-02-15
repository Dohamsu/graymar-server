// 정본: design/input_processing_pipeline_v1.md §6 — Policy Check (COOPERATIVE_TRANSFORM)

import { Injectable } from '@nestjs/common';
import type { ParsedIntent } from '../../db/types/index.js';
import type {
  ActionTypeCombat,
  NodeType,
  PolicyResult,
} from '../../db/types/index.js';

export interface PolicyCheckResult {
  result: PolicyResult;
  reason?: string;
  transformedIntents?: ParsedIntent;
}

@Injectable()
export class PolicyService {
  /**
   * COOPERATIVE_TRANSFORM 정책:
   * - DENY는 최후의 수단
   * - 가능한 한 TRANSFORM/PARTIAL로 살린다
   */
  check(
    intent: ParsedIntent,
    nodeType: NodeType,
    nodeState: 'NODE_ACTIVE' | 'NODE_ENDED',
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _currentStamina: number,
  ): PolicyCheckResult {
    // 불변 규칙: NODE_ENDED에서 전투 계속 불가
    if (nodeState === 'NODE_ENDED') {
      return { result: 'DENY', reason: 'Node already ended' };
    }

    // 비전투 노드에서 전투 행동 시도
    const combatActions: ActionTypeCombat[] = [
      'ATTACK_MELEE',
      'ATTACK_RANGED',
      'DEFEND',
      'EVADE',
      'MOVE',
      'USE_ITEM',
      'FLEE',
      'INTERACT',
    ];

    if (nodeType !== 'COMBAT') {
      const hasCombatIntent = intent.intents.some((i) =>
        combatActions.includes(i as ActionTypeCombat),
      );
      if (hasCombatIntent) {
        return {
          result: 'TRANSFORM',
          reason: 'Combat action in non-combat node, transforming to OBSERVE',
          transformedIntents: {
            ...intent,
            intents: ['OBSERVE'],
            source: 'RULE',
            confidence: 1.0,
          },
        };
      }
    }

    // 과도한 다중 행동 → 2단 콤보로 축약
    if (intent.intents.length > 2) {
      return {
        result: 'PARTIAL',
        reason: `Too many actions (${intent.intents.length}), reduced to 2`,
        transformedIntents: {
          ...intent,
          intents: intent.intents.slice(0, 2),
          confidence: Math.min(intent.confidence, 0.8),
        },
      };
    }

    // illegal flags 체크
    if (intent.illegalFlags.length > 0) {
      return {
        result: 'DENY',
        reason: `Illegal flags: ${intent.illegalFlags.join(', ')}`,
      };
    }

    return { result: 'ALLOW' };
  }
}
