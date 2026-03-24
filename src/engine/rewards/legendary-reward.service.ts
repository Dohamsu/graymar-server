// Phase 4d: Legendary Quest Rewards
// Incident CONTAINED + arcState.commitment 조건으로 Legendary 아이템 지급

import { Injectable, Logger } from '@nestjs/common';
import { AffixService } from './affix.service.js';
import { ContentLoaderService } from '../../content/content-loader.service.js';
import type { RunState } from '../../db/types/permanent-stats.js';
import type { IncidentRuntime } from '../../db/types/index.js';
import type { ItemInstance } from '../../db/types/equipment.js';

/**
 * Legendary 보상 조건 매핑:
 * - Tier 1: commitment >= 2 + CONTAINED incident >= 1 -> LEGENDARY 1개
 * - Tier 2: commitment >= 3 (locked) + CONTAINED incident >= 2 -> 추가 LEGENDARY (후보가 있으면)
 *
 * 현재 LEGENDARY 아이템: EQ_RELIC_TIDE_COMPASS (RELIC 슬롯)
 * legendaryRewards[] 배열로 중복 지급 방지
 */

const LEGENDARY_TIERS: ReadonlyArray<{
  commitmentMin: number;
  containedCountMin: number;
}> = [
  { commitmentMin: 2, containedCountMin: 1 },
  { commitmentMin: 3, containedCountMin: 2 },
];

export interface LegendaryRewardResult {
  awarded: ItemInstance[];
  events: Array<{
    id: string;
    kind: 'LOOT';
    text: string;
    tags: string[];
    data?: Record<string, unknown>;
  }>;
}

@Injectable()
export class LegendaryRewardService {
  private readonly logger = new Logger(LegendaryRewardService.name);

  constructor(
    private readonly affixService: AffixService,
    private readonly contentLoader: ContentLoaderService,
  ) {}

  /**
   * Incident CONTAINED 완료 후 Legendary 보상 체크.
   * - 이번 턴에서 새로 CONTAINED가 된 incident가 있을 때만 호출
   * - arcState.commitment 조건 + CONTAINED 누적 수 확인
   * - legendaryRewards에 이미 있으면 중복 지급 방지
   *
   * @returns awarded instances + LOOT events (빈 배열이면 지급 없음)
   */
  check(
    runState: RunState,
    activeIncidents: IncidentRuntime[],
    newlyContainedIds: string[],
  ): LegendaryRewardResult {
    const result: LegendaryRewardResult = { awarded: [], events: [] };

    // 이번 턴에 새로 CONTAINED된 incident가 없으면 스킵
    if (newlyContainedIds.length === 0) return result;

    const commitment = runState.arcState?.commitment ?? 0;
    const alreadyAwarded = new Set(runState.legendaryRewards ?? []);

    // 전체 CONTAINED incident 수 (이전 + 이번 턴 포함)
    const containedCount = activeIncidents.filter(
      (i) => i.resolved && i.outcome === 'CONTAINED',
    ).length;

    // 모든 LEGENDARY 아이템 중 아직 지급하지 않은 후보
    const candidates = this.contentLoader
      .getAllItems()
      .filter((item) => item.rarity === 'LEGENDARY' && !alreadyAwarded.has(item.itemId));

    if (candidates.length === 0) return result;

    // tier 순서대로 체크 -> 조건 만족하면 후보에서 1개씩 지급
    let candidateIdx = 0;
    for (const tier of LEGENDARY_TIERS) {
      if (candidateIdx >= candidates.length) break;
      if (commitment >= tier.commitmentMin && containedCount >= tier.containedCountMin) {
        // 이 tier에 대해 이미 지급했는지 체크 (alreadyAwarded 기준)
        // -> candidates는 이미 필터링됐으므로 추가 체크 불필요
        const candidate = candidates[candidateIdx];
        candidateIdx++;

        const instance = this.affixService.createPlainInstance(candidate.itemId);
        result.awarded.push(instance);
        result.events.push({
          id: `legendary_${instance.instanceId.slice(0, 8)}`,
          kind: 'LOOT',
          text: `[전설 장비] ${instance.displayName} 획득! 사건 해결의 보상으로 전설적인 유물을 손에 넣었다.`,
          tags: ['LOOT', 'EQUIPMENT_DROP', 'LEGENDARY'],
          data: {
            baseItemId: instance.baseItemId,
            instanceId: instance.instanceId,
            displayName: instance.displayName,
            rarity: 'LEGENDARY',
          },
        });

        this.logger.log(
          `Legendary reward: ${candidate.itemId} (commitment=${commitment}, contained=${containedCount})`,
        );
      }
    }

    return result;
  }
}
