// 정본: specs/combat_engine_resolve_v1.md §3.4 — 적 AI (v1 최소 구현)

import { Injectable } from '@nestjs/common';
import type { AiPersonality, Distance } from '../../db/types/index.js';
import type { ActionUnit } from '../../db/types/index.js';
import type { Rng } from '../rng/rng.service.js';

interface EnemyContext {
  enemyId: string;
  personality: AiPersonality;
  distance: Distance;
  hp: number;
  maxHp: number;
}

const DISTANCE_ORDER: Distance[] = ['ENGAGED', 'CLOSE', 'MID', 'FAR', 'OUT'];

function distIdx(d: Distance): number {
  return DISTANCE_ORDER.indexOf(d);
}

@Injectable()
export class EnemyAiService {
  /**
   * 적 AI 행동 선택: personality 기반 v1 최소 구현
   * 반환: 적이 실행할 ActionUnit[] (최대 1개)
   */
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  selectActions(ctx: EnemyContext, _rng: Rng): ActionUnit[] {
    switch (ctx.personality) {
      case 'AGGRESSIVE':
        return this.aggressive(ctx);
      case 'TACTICAL':
        return this.tactical(ctx);
      case 'SNIPER':
        return this.sniper(ctx);
      case 'COWARDLY':
        return this.cowardly(ctx);
      case 'BERSERK':
        return this.berserk(ctx);
      default:
        return this.aggressive(ctx);
    }
  }

  /** AGGRESSIVE: 접근(ENGAGED 유도) 후 근접 */
  private aggressive(ctx: EnemyContext): ActionUnit[] {
    if (distIdx(ctx.distance) > distIdx('ENGAGED')) {
      return [{ type: 'MOVE', direction: 'FORWARD' }];
    }
    return [{ type: 'ATTACK_MELEE', targetId: 'player' }];
  }

  /** TACTICAL: 측면/후면 노림, 아니면 공격 */
  private tactical(ctx: EnemyContext): ActionUnit[] {
    if (distIdx(ctx.distance) > distIdx('CLOSE')) {
      return [{ type: 'MOVE', direction: 'FORWARD' }];
    }
    return [{ type: 'ATTACK_MELEE', targetId: 'player' }];
  }

  /** SNIPER: FAR 유지 후 원거리 공격 */
  private sniper(ctx: EnemyContext): ActionUnit[] {
    if (distIdx(ctx.distance) < distIdx('MID')) {
      return [{ type: 'MOVE', direction: 'BACK' }];
    }
    return [{ type: 'ATTACK_RANGED', targetId: 'player' }];
  }

  /** COWARDLY: HP 낮으면 후퇴, 아니면 소극적 공격 */
  private cowardly(ctx: EnemyContext): ActionUnit[] {
    const hpPercent = ctx.hp / Math.max(1, ctx.maxHp);
    if (hpPercent < 0.3 && distIdx(ctx.distance) < distIdx('FAR')) {
      return [{ type: 'MOVE', direction: 'BACK' }];
    }
    if (distIdx(ctx.distance) <= distIdx('CLOSE')) {
      return [{ type: 'ATTACK_MELEE', targetId: 'player' }];
    }
    return [{ type: 'DEFEND' }];
  }

  /** BERSERK: 무조건 접근 + 최대 피해 */
  private berserk(ctx: EnemyContext): ActionUnit[] {
    if (distIdx(ctx.distance) > distIdx('ENGAGED')) {
      return [{ type: 'MOVE', direction: 'FORWARD' }];
    }
    return [{ type: 'ATTACK_MELEE', targetId: 'player' }];
  }

  /** 적 행동 순서 결정 (SPEED 내림차순) */
  sortBySpeed(enemies: Array<{ id: string; speed: number }>): string[] {
    return [...enemies].sort((a, b) => b.speed - a.speed).map((e) => e.id);
  }
}
