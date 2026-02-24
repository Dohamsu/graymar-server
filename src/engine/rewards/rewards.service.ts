// 정본: specs/rewards_and_progression_v1.md — 전투 보상 시스템

import { Injectable } from '@nestjs/common';
import type { ItemStack } from '../../db/types/index.js';
import type { ResolveOutcome } from '../../db/types/resolve-result.js';
import { Rng } from '../rng/rng.service.js';

export interface RewardInput {
  enemies: string[];
  isBoss: boolean;
  seed: string;
  encounterRewards?: {
    clueChance?: { itemId: string; probability: number };
  };
}

export interface RewardResult {
  gold: number;
  items: ItemStack[];
  exp: number;
}

/** v1 드랍 테이블 (간단한 인메모리 정의) */
interface DropEntry {
  itemId: string;
  chance: number; // 0~1
  qtyMin: number;
  qtyMax: number;
}

const BASIC_DROP_TABLE: DropEntry[] = [
  { itemId: 'ITEM_MINOR_HEALING', chance: 0.3, qtyMin: 1, qtyMax: 1 },
  { itemId: 'ITEM_STAMINA_TONIC', chance: 0.2, qtyMin: 1, qtyMax: 1 },
];

const BOSS_DROP_TABLE: DropEntry[] = [
  { itemId: 'ITEM_MINOR_HEALING', chance: 0.6, qtyMin: 1, qtyMax: 2 },
  { itemId: 'ITEM_POISON_NEEDLE', chance: 0.25, qtyMin: 1, qtyMax: 1 },
];

/** LOCATION 전용 드랍 테이블 — 낮은 단계 소모품만 */
const LOCATION_DROP_TABLE: DropEntry[] = [
  { itemId: 'ITEM_MINOR_HEALING', chance: 0.6, qtyMin: 1, qtyMax: 1 },
  { itemId: 'ITEM_STAMINA_TONIC', chance: 0.4, qtyMin: 1, qtyMax: 1 },
];

/** 비보상 행위 (보상 없음) — 골드 소비 행위(BRIBE/TRADE)도 별도 비용 체계가 있으므로 제외 */
const NON_REWARD_ACTIONS = new Set(['REST', 'SHOP', 'MOVE_LOCATION', 'BRIBE', 'TRADE']);

/** 정보 수집 행위 (보상 없음) — 정보를 얻는 행위로 골드가 생기는 것은 서사적으로 부자연스러움 */
const INFO_GATHERING_ACTIONS = new Set(['INVESTIGATE', 'PERSUADE', 'HELP']);

/** 수동적 행위 (소액 골드만, 아이템 드랍 없음) — 관찰/대화로 물건을 얻지는 않음 */
const PASSIVE_ACTIONS = new Set(['OBSERVE', 'TALK']);

export interface LocationRewardInput {
  outcome: ResolveOutcome;
  eventType: string;
  actionType: string;
  rng: Rng;
}

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
      for (let i = 0; i < input.enemies.length; i++) {
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

    // encounter 보상: 단서 아이템 드랍
    if (input.encounterRewards?.clueChance) {
      const { itemId, probability } = input.encounterRewards.clueChance;
      if (rng.next() < probability) {
        const existing = items.find((i) => i.itemId === itemId);
        if (existing) {
          existing.qty += 1;
        } else {
          items.push({ itemId, qty: 1 });
        }
      }
    }

    return { gold, items, exp };
  }

  /**
   * LOCATION 판정 보상 계산 — 기존 RNG 인스턴스 재사용 (cursor 연속)
   * RNG 소비: EventMatcher(가중치) → Resolve(1d6) → LocationReward(골드+드랍)
   */
  calculateLocationRewards(input: LocationRewardInput): RewardResult {
    const { outcome, eventType, actionType, rng } = input;

    // 비보상 행위: REST, SHOP, MOVE_LOCATION → 보상 없음
    if (NON_REWARD_ACTIONS.has(actionType)) {
      return { gold: 0, items: [], exp: 0 };
    }

    // 정보 수집 행위: INVESTIGATE, PERSUADE, HELP → 보상 없음
    // 정보를 얻었다고 골드가 생기는 것은 서사적으로 부자연스러움
    if (INFO_GATHERING_ACTIONS.has(actionType)) {
      return { gold: 0, items: [], exp: 0 };
    }

    // FAIL → 보상 없음
    if (outcome === 'FAIL') {
      return { gold: 0, items: [], exp: 0 };
    }

    const items: ItemStack[] = [];
    let gold = 0;

    const isOpportunity = eventType === 'OPPORTUNITY';

    // 수동적 행위: 소액 골드만, 아이템 드랍 없음
    if (PASSIVE_ACTIONS.has(actionType)) {
      if (actionType === 'TALK') {
        // TALK: 30% 확률로 1~2g
        if (rng.next() < 0.3) {
          gold = rng.range(1, 2);
        }
      } else {
        // OBSERVE: 20% 확률로 1~2g (관찰로 발견한 소액)
        if (rng.next() < 0.2) {
          gold = rng.range(1, 2);
        }
      }
      return { gold, items, exp: 0 };
    }

    if (isOpportunity) {
      if (outcome === 'SUCCESS') {
        gold = rng.range(5, 12);
        if (rng.next() < 0.35) {
          this.rollLocationDrop(rng, items);
        }
      } else {
        // PARTIAL
        gold = rng.range(2, 5);
        if (rng.next() < 0.12) {
          this.rollLocationDrop(rng, items);
        }
      }
    } else {
      // 일반 Challenge
      if (outcome === 'SUCCESS') {
        gold = rng.range(3, 8);
        if (rng.next() < 0.2) {
          this.rollLocationDrop(rng, items);
        }
      } else {
        // PARTIAL
        gold = rng.range(1, 3);
        if (rng.next() < 0.08) {
          this.rollLocationDrop(rng, items);
        }
      }
    }

    return { gold, items, exp: 0 };
  }

  /** LOCATION 드랍 테이블에서 아이템 1개 선택 (가중치 기반) */
  private rollLocationDrop(rng: Rng, items: ItemStack[]): void {
    // 가중치: MINOR_HEALING 60, STAMINA_TONIC 40 → 60% vs 40%
    const roll = rng.next();
    const entry = roll < LOCATION_DROP_TABLE[0].chance
      ? LOCATION_DROP_TABLE[0]
      : LOCATION_DROP_TABLE[1];
    const existing = items.find((i) => i.itemId === entry.itemId);
    if (existing) {
      existing.qty += 1;
    } else {
      items.push({ itemId: entry.itemId, qty: 1 });
    }
  }

  /** DEFEAT: 보상 몰수 */
  calculateDefeatPenalty(): RewardResult {
    return { gold: 0, items: [], exp: 0 };
  }

  /** FLEE: 골드 -10%, 아이템 유지 */
  calculateFleePenalty(currentGold: number): { goldLost: number } {
    return { goldLost: Math.floor(currentGold * 0.1) };
  }

  private rollDropTable(
    table: DropEntry[],
    rng: Rng,
    items: ItemStack[],
  ): void {
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
