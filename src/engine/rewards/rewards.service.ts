// 정본: specs/rewards_and_progression_v1.md — 전투 보상 시스템

import { Injectable } from '@nestjs/common';
import type { ItemStack } from '../../db/types/index.js';
import type { ItemInstance } from '../../db/types/equipment.js';
import type { ResolveOutcome } from '../../db/types/resolve-result.js';
import { Rng } from '../rng/rng.service.js';
import { ContentLoaderService } from '../../content/content-loader.service.js';
import type { ConsumableDropEntry } from '../../content/content.types.js';
import { AffixService } from './affix.service.js';

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

// 소모품 드랍 테이블은 팩별 drop_tables.json 으로 외부화됨(불변식 45).
// 이전 하드코딩(ITEM_MINOR_HEALING 등)이 비-graymar 팩에 새던 버그 근절 —
// ContentLoader.getConsumableDropTable('basic'|'boss'|'location') 로 조회.

/**
 * 골드 획득 행위 — 서사적으로 금품을 얻는 것이 논리적인 행동만 포함
 * STEAL: 훔치기 (고위험/고보상)
 * THREATEN: 협박으로 금품 요구
 * FIGHT: 전투/강탈로 전리품
 * SEARCH: 수색으로 숨긴 금품 발견
 * HELP: 도움에 대한 감사 보답 (소액)
 */
export const GOLD_ACTIONS = new Set([
  'STEAL',
  'THREATEN',
  'FIGHT',
  'SEARCH',
  'HELP',
]);

export interface LocationRewardInput {
  outcome: ResolveOutcome;
  eventType: string;
  actionType: string;
  rng: Rng;
}

/** 장비 드랍 롤 결과 */
export interface EquipmentDropResult {
  droppedInstances: ItemInstance[];
}

@Injectable()
export class RewardsService {
  constructor(
    private readonly contentLoader: ContentLoaderService,
    private readonly affixService: AffixService,
  ) {}
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
        this.rollDropTable(
          this.contentLoader.getConsumableDropTable('boss'),
          rng,
          items,
        );
      }
    } else {
      // 잡몹: 전투 단위 1회 롤
      gold = rng.range(10, 25) * input.enemies.length;
      exp = rng.range(5, 15) * input.enemies.length;
      this.rollDropTable(
        this.contentLoader.getConsumableDropTable('basic'),
        rng,
        items,
      );
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
    const { outcome, actionType, rng } = input;

    // 골드 획득 행위가 아니면 → 골드 0 (아이템 드랍도 없음)
    if (!GOLD_ACTIONS.has(actionType)) {
      return { gold: 0, items: [], exp: 0 };
    }

    // FAIL → 보상 없음
    if (outcome === 'FAIL') {
      return { gold: 0, items: [], exp: 0 };
    }

    const items: ItemStack[] = [];
    let gold = 0;

    switch (actionType) {
      case 'STEAL':
        // 훔치기: 고위험/고보상 + 아이템 드랍 기회
        if (outcome === 'SUCCESS') {
          gold = rng.range(8, 18);
          if (rng.next() < 0.35) this.rollLocationDrop(rng, items);
        } else {
          gold = rng.range(3, 8);
          if (rng.next() < 0.12) this.rollLocationDrop(rng, items);
        }
        break;

      case 'THREATEN':
        // 협박: 금품 요구 — 아이템 없음 (현금만 뜯어냄)
        if (outcome === 'SUCCESS') {
          gold = rng.range(6, 14);
        } else {
          gold = rng.range(2, 6);
        }
        break;

      case 'FIGHT':
        // 전투/강탈: 전리품 + 아이템 드랍
        if (outcome === 'SUCCESS') {
          gold = rng.range(5, 12);
          if (rng.next() < 0.2) this.rollLocationDrop(rng, items);
        } else {
          gold = rng.range(2, 5);
          if (rng.next() < 0.08) this.rollLocationDrop(rng, items);
        }
        break;

      case 'SEARCH':
        // 수색: 숨겨진 금품 발견 + 아이템 드랍
        if (outcome === 'SUCCESS') {
          gold = rng.range(4, 10);
          if (rng.next() < 0.25) this.rollLocationDrop(rng, items);
        } else {
          gold = rng.range(2, 5);
          if (rng.next() < 0.1) this.rollLocationDrop(rng, items);
        }
        break;

      case 'HELP':
        // 도움 → 감사 보답: 소액, 아이템 없음
        if (outcome === 'SUCCESS') {
          gold = rng.range(2, 6);
        } else {
          gold = rng.next() < 0.5 ? 2 : 0;
        }
        break;
    }

    return { gold, items, exp: 0 };
  }

  /** LOCATION 드랍 테이블에서 아이템 1개 선택 (가중치 기반, 팩별) */
  private rollLocationDrop(rng: Rng, items: ItemStack[]): void {
    const table = this.contentLoader.getConsumableDropTable('location');
    const first = table[0];
    if (!first) return; // 팩이 location 드랍 미정의 → 드랍 없음
    // 원본 가중치 유지: 첫 항목 chance 로 1차 분기, 미달 시 2번째(있으면 그것, 없으면 첫 항목)
    const roll = rng.next();
    const entry = roll < first.chance ? first : (table[1] ?? first);
    const existing = items.find((i) => i.itemId === entry.itemId);
    if (existing) {
      existing.qty += 1;
    } else {
      items.push({ itemId: entry.itemId, qty: 1 });
    }
  }

  /**
   * 전투 장비 드랍 롤 — 적별/인카운터별 드랍 테이블에서 장비 인스턴스 생성.
   * VICTORY 시에만 호출. RNG는 전투 보상 RNG 이후 커서 연속 사용.
   */
  rollCombatEquipmentDrops(
    enemyIds: string[],
    encounterId: string | undefined,
    isBoss: boolean,
    locationId: string,
    rng: Rng,
  ): EquipmentDropResult {
    const droppedInstances: ItemInstance[] = [];

    // 보스전: 인카운터 드랍 테이블 우선
    if (isBoss && encounterId) {
      const encounterDrops =
        this.contentLoader.getEncounterEquipmentDropTable(encounterId);
      if (encounterDrops) {
        for (const drop of encounterDrops.drops) {
          if (rng.next() < drop.chance) {
            const instance = this.affixService.createItemInstance(
              drop.baseItemId,
              locationId,
              rng,
            );
            droppedInstances.push(instance);
          }
        }
      }
    }

    // 적별 드랍 (보스전이라도 추가 적이 있을 수 있음)
    for (const enemyId of enemyIds) {
      const enemyDrops = this.contentLoader.getEquipmentDropTable(enemyId);
      if (!enemyDrops) continue;
      for (const drop of enemyDrops.drops) {
        if (rng.next() < drop.chance) {
          const instance = this.affixService.createItemInstance(
            drop.baseItemId,
            locationId,
            rng,
          );
          droppedInstances.push(instance);
        }
      }
    }

    return { droppedInstances };
  }

  /**
   * LOCATION 판정 장비 드랍 롤 — 장소별 드랍 테이블에서 확률 롤.
   * SEARCH, STEAL, FIGHT 등 GOLD_ACTIONS + SUCCESS/PARTIAL 시 호출.
   */
  rollLocationEquipmentDrop(
    locationId: string,
    rng: Rng,
    ownedBaseItemIds?: Set<string>,
  ): EquipmentDropResult {
    const droppedInstances: ItemInstance[] = [];
    const locationDrops =
      this.contentLoader.getLocationEquipmentDrops(locationId);
    if (!locationDrops) return { droppedInstances };

    for (const drop of locationDrops.drops) {
      // P4 2026-07-11 — 보유 중복 감쇠: 이미 가진 baseItemId는 확률 ×0.3
      // (실측: 좁은 드랍 풀에서 EQ_RUSTY_BLADE ×2 등 동일 장비 중복).
      // rng 호출 횟수는 동일하므로 결정론(seed+cursor)에 영향 없음.
      const owned = ownedBaseItemIds?.has(drop.baseItemId) ?? false;
      const chance = owned ? drop.chance * 0.3 : drop.chance;
      if (rng.next() < chance) {
        const instance = this.affixService.createItemInstance(
          drop.baseItemId,
          locationId,
          rng,
        );
        droppedInstances.push(instance);
        break; // LOCATION 드랍은 최대 1개
      }
    }

    return { droppedInstances };
  }

  /**
   * P4 2026-07-11 — 퀘스트 전환 장비 보상 인스턴스 생성 (경제 루프 v1 확장).
   * quest.json rewards.transitionEquipment의 baseItemId를 지급용 인스턴스로.
   * 대화·조사 중심 실플레이(86%)에서 장비 시스템이 완전 유휴이던 것을
   * 핵심 루프(questState 전환)에 연결 — 서사 명분: 의뢰인의 경비 지원.
   */
  grantQuestEquipment(baseItemId: string, rng: Rng): ItemInstance | null {
    const item = this.contentLoader.getItem(baseItemId);
    if (!item) return null;
    return this.affixService.createItemInstance(
      baseItemId,
      'QUEST_REWARD',
      rng,
    );
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
    table: ConsumableDropEntry[],
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
