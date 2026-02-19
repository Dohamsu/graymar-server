// Region Affix 롤링 서비스 — 장비 획득 시 위치 기반 접두사/접미사 부여

import { Injectable } from '@nestjs/common';
import { randomUUID } from 'crypto';
import type { ItemInstance } from '../../db/types/equipment.js';
import type { RegionAffixDef } from '../../db/types/region-affix.js';
import { AFFIX_PROBABILITY } from '../../db/types/region-affix.js';
import type { StatModifier } from '../stats/stats.service.js';
import { ContentLoaderService } from '../../content/content-loader.service.js';
import type { Rng } from '../rng/rng.service.js';

const AFFIX_PRIORITY = 200; // GEAR layer와 동일 priority, source로 구분

@Injectable()
export class AffixService {
  constructor(private readonly contentLoader: ContentLoaderService) {}

  /**
   * 장비 아이템에 대해 region affix를 롤링하여 ItemInstance 생성.
   * - allowRegionAffix가 false이면 affix 없는 인스턴스 반환
   * - rarity에 따른 확률 테이블 적용
   * - locationId + profileId로 후보 필터링
   * - 가중치 기반 랜덤 선택 (RNG 사용)
   */
  createItemInstance(
    baseItemId: string,
    locationId: string,
    rng: Rng,
  ): ItemInstance {
    const itemDef = this.contentLoader.getItem(baseItemId);
    const instanceId = randomUUID();

    if (!itemDef) {
      return { instanceId, baseItemId, displayName: baseItemId };
    }

    // affix 불가능 아이템
    if (!itemDef.allowRegionAffix || !itemDef.regionAffixProfileId) {
      return { instanceId, baseItemId, displayName: itemDef.name };
    }

    const rarity = itemDef.rarity ?? 'COMMON';
    const prob = AFFIX_PROBABILITY[rarity];
    if (!prob) {
      return { instanceId, baseItemId, displayName: itemDef.name };
    }

    const profileId = itemDef.regionAffixProfileId;
    let prefixAffixId: string | undefined;
    let suffixAffixId: string | undefined;
    let prefixName = '';
    let suffixName = '';

    // prefix 롤
    if (prob.prefix > 0 && rng.next() < prob.prefix) {
      const candidates = this.contentLoader.getAffixesByLocation(locationId, 'PREFIX', profileId);
      const picked = this.weightedPick(candidates, rng);
      if (picked) {
        prefixAffixId = picked.affixId;
        prefixName = picked.name;
      }
    }

    // suffix 롤
    if (prob.suffix > 0 && rng.next() < prob.suffix) {
      const candidates = this.contentLoader.getAffixesByLocation(locationId, 'SUFFIX', profileId);
      const picked = this.weightedPick(candidates, rng);
      if (picked) {
        suffixAffixId = picked.affixId;
        suffixName = picked.name;
      }
    }

    // displayName 조합: "[prefix명] [아이템명] [suffix명]"
    const parts: string[] = [];
    if (prefixName) parts.push(prefixName);
    parts.push(itemDef.name);
    if (suffixName) parts.push(suffixName);
    const displayName = parts.join(' ');

    return {
      instanceId,
      baseItemId,
      prefixAffixId,
      suffixAffixId,
      displayName,
    };
  }

  /**
   * affix 없는 기본 ItemInstance 생성 (시작 장비, 상점 구매 등).
   */
  createPlainInstance(baseItemId: string): ItemInstance {
    const itemDef = this.contentLoader.getItem(baseItemId);
    return {
      instanceId: randomUUID(),
      baseItemId,
      displayName: itemDef?.name ?? baseItemId,
    };
  }

  /**
   * ItemInstance의 affix modifier를 StatModifier[]로 변환.
   */
  getAffixModifiers(instance: ItemInstance): StatModifier[] {
    const modifiers: StatModifier[] = [];

    if (instance.prefixAffixId) {
      const affix = this.contentLoader.getAffix(instance.prefixAffixId);
      if (affix) {
        for (const mod of affix.modifiers) {
          modifiers.push({
            stat: mod.stat as keyof import('../stats/stats.service.js').StatsSnapshot,
            op: 'FLAT',
            value: mod.value,
            priority: AFFIX_PRIORITY,
            source: `AFFIX:${affix.affixId}`,
          });
        }
      }
    }

    if (instance.suffixAffixId) {
      const affix = this.contentLoader.getAffix(instance.suffixAffixId);
      if (affix) {
        for (const mod of affix.modifiers) {
          modifiers.push({
            stat: mod.stat as keyof import('../stats/stats.service.js').StatsSnapshot,
            op: 'FLAT',
            value: mod.value,
            priority: AFFIX_PRIORITY,
            source: `AFFIX:${affix.affixId}`,
          });
        }
      }
    }

    return modifiers;
  }

  /** 가중치 기반 랜덤 선택 */
  private weightedPick(candidates: RegionAffixDef[], rng: Rng): RegionAffixDef | null {
    if (candidates.length === 0) return null;

    const totalWeight = candidates.reduce((sum, c) => sum + c.weight, 0);
    if (totalWeight <= 0) return null;

    let roll = rng.next() * totalWeight;
    for (const candidate of candidates) {
      roll -= candidate.weight;
      if (roll <= 0) return candidate;
    }

    return candidates[candidates.length - 1];
  }
}
