// 정본: design/rewards_and_progression_v1.md — 전투 보상 시스템

import { Injectable } from '@nestjs/common';
import type { ItemStack } from '../../db/types/index.js';
import { Rng } from '../rng/rng.service.js';

export interface RewardInput {
  enemies: string[];
  isBoss: boolean;
  seed: string;
}

export interface RewardResult {
  gold: number;
  items: ItemStack[];
  exp: number;
}

/** v1 드랍 테이블 (간단한 인메모리 정의) */
interface DropEntry {
  itemId: string;
  chance: number;  // 0~1
  qtyMin: number;
  qtyMax: number;
}

const BASIC_DROP_TABLE: DropEntry[] = [
  { itemId: 'health_potion', chance: 0.3, qtyMin: 1, qtyMax: 1 },
  { itemId: 'stamina_herb', chance: 0.2, qtyMin: 1, qtyMax: 2 },
];

const BOSS_DROP_TABLE: DropEntry[] = [
  { itemId: 'health_potion', chance: 0.6, qtyMin: 1, qtyMax: 2 },
  { itemId: 'rare_weapon', chance: 0.25, qtyMin: 1, qtyMax: 1 },
  { itemId: 'gold_ingot', chance: 0.15, qtyMin: 1, qtyMax: 1 },
];

@Injectable()
export class RewardsService {
  /**
   * 전투 보상 계산 (보상 RNG는 전투 RNG와 분리)
   * - 잡몹: 전투 단위 1회 롤
   * - 보스: 개별 롤
   */
  calculateCombatRewards(input: RewardInput): RewardResult {
    const rng = new Rng(input.seed + '_reward', 0);
    const items: ItemStack[] = [];
    let gold = 0;
    let exp = 0;

    if (input.isBoss) {
      // 보스: 적 별 개별 롤
      for (const enemyId of input.enemies) {
        gold += rng.range(30, 60);
        exp += rng.range(20, 40);
        this.rollDropTable(BOSS_DROP_TABLE, rng, items);
      }
    } else {
      // 잡몹: 전투 단위 1회 롤
      gold = rng.range(10, 25) * input.enemies.length;
      exp = rng.range(5, 15) * input.enemies.length;
      this.rollDropTable(BASIC_DROP_TABLE, rng, items);
    }

    return { gold, items, exp };
  }

  /** DEFEAT: 보상 몰수 */
  calculateDefeatPenalty(): RewardResult {
    return { gold: 0, items: [], exp: 0 };
  }

  /** FLEE: 골드 -10%, 아이템 유지 */
  calculateFleePenalty(currentGold: number): { goldLost: number } {
    return { goldLost: Math.floor(currentGold * 0.1) };
  }

  private rollDropTable(table: DropEntry[], rng: Rng, items: ItemStack[]): void {
    for (const entry of table) {
      if (rng.next() < entry.chance) {
        const qty = rng.range(entry.qtyMin, entry.qtyMax);
        const existing = items.find((i) => i.itemId === entry.itemId);
        if (existing) {
          existing.qty += qty;
        } else {
          items.push({ itemId: entry.itemId, qty });
        }
      }
    }
  }
}
