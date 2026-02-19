// 정본: architecture/10_region_economy.md §2 — Equipment System

import { Injectable } from '@nestjs/common';
import type { EquipmentSlot, EquippedGear, StatKey, ItemInstance } from '../../db/types/equipment.js';
import { EQUIPMENT_SLOTS, emptyEquipped } from '../../db/types/equipment.js';
import type { StatModifier } from '../stats/stats.service.js';
import { ContentLoaderService } from '../../content/content-loader.service.js';
import { AffixService } from './affix.service.js';

const GEAR_PRIORITY = 200; // Modifier Stack: BASE(100) → GEAR(200) → BUFF(300)

@Injectable()
export class EquipmentService {
  constructor(
    private readonly contentLoader: ContentLoaderService,
    private readonly affixService: AffixService,
  ) {}

  /**
   * 장비 착용. 해당 슬롯에 이미 장비가 있으면 교체 (기존 장비 인스턴스는 반환).
   */
  equip(
    equipped: EquippedGear,
    instance: ItemInstance,
  ): { equipped: EquippedGear; unequippedInstance: ItemInstance | null } {
    const itemDef = this.contentLoader.getItem(instance.baseItemId);
    if (!itemDef || itemDef.type !== 'EQUIPMENT' || !itemDef.slot) {
      return { equipped, unequippedInstance: null };
    }

    // Legendary는 RELIC 슬롯만 가능
    if (itemDef.rarity === 'LEGENDARY' && itemDef.slot !== 'RELIC') {
      return { equipped, unequippedInstance: null };
    }

    const slot = itemDef.slot as EquipmentSlot;
    const unequippedInstance = equipped[slot] ?? null;

    return {
      equipped: { ...equipped, [slot]: instance },
      unequippedInstance,
    };
  }

  /**
   * 장비 해제. 해당 슬롯의 장비를 벗는다.
   */
  unequip(
    equipped: EquippedGear,
    slot: EquipmentSlot,
  ): { equipped: EquippedGear; unequippedInstance: ItemInstance | null } {
    const unequippedInstance = equipped[slot] ?? null;
    const updated = { ...equipped };
    delete updated[slot];
    return { equipped: updated, unequippedInstance };
  }

  /**
   * 장착 장비에서 Modifier Stack GEAR layer 생성.
   * Set 보너스 포함.
   */
  getGearModifiers(equipped: EquippedGear): StatModifier[] {
    const modifiers: StatModifier[] = [];

    // 개별 장비 statBonus + affix modifier
    for (const slot of EQUIPMENT_SLOTS) {
      const instance = equipped[slot];
      if (!instance) continue;

      const itemDef = this.contentLoader.getItem(instance.baseItemId);
      if (itemDef?.statBonus) {
        for (const [stat, value] of Object.entries(itemDef.statBonus)) {
          if (value === 0) continue;
          modifiers.push({
            stat: stat as keyof import('../stats/stats.service.js').StatsSnapshot,
            op: 'FLAT',
            value,
            priority: GEAR_PRIORITY,
            source: `GEAR:${instance.baseItemId}`,
          });
        }
      }

      // Affix modifier 추가
      const affixMods = this.affixService.getAffixModifiers(instance);
      modifiers.push(...affixMods);
    }

    // 세트 보너스
    const setModifiers = this.getSetBonusModifiers(equipped);
    modifiers.push(...setModifiers);

    return modifiers;
  }

  /**
   * 세트 보너스 modifier 계산.
   */
  private getSetBonusModifiers(equipped: EquippedGear): StatModifier[] {
    const modifiers: StatModifier[] = [];
    const itemSetMap = this.contentLoader.getItemSetMap();

    // 세트별 장착 피스 수 집계
    const setCounts = new Map<string, number>();
    for (const instance of Object.values(equipped)) {
      if (!instance) continue;
      const setId = itemSetMap[instance.baseItemId];
      if (setId) setCounts.set(setId, (setCounts.get(setId) ?? 0) + 1);
    }

    for (const [setId, count] of setCounts) {
      const setDef = this.contentLoader.getSet(setId);
      if (!setDef) continue;

      // 2-piece 보너스
      if (count >= 2 && setDef.bonus2.statBonus) {
        for (const [stat, value] of Object.entries(setDef.bonus2.statBonus)) {
          if (value === 0) continue;
          modifiers.push({
            stat: stat as keyof import('../stats/stats.service.js').StatsSnapshot,
            op: 'FLAT',
            value,
            priority: GEAR_PRIORITY + 1, // 개별 장비 직후
            source: `SET2:${setId}`,
          });
        }
      }

      // 3-piece 보너스
      if (count >= 3 && setDef.bonus3.statBonus) {
        for (const [stat, value] of Object.entries(setDef.bonus3.statBonus)) {
          if (value === 0) continue;
          modifiers.push({
            stat: stat as keyof import('../stats/stats.service.js').StatsSnapshot,
            op: 'FLAT',
            value,
            priority: GEAR_PRIORITY + 2,
            source: `SET3:${setId}`,
          });
        }
      }
    }

    return modifiers;
  }

  /**
   * 현재 장비의 서술 태그 수집 (LLM 톤 영향, 최대 6개).
   */
  getNarrativeTags(equipped: EquippedGear): string[] {
    const tags: string[] = [];
    for (const slot of EQUIPMENT_SLOTS) {
      const instance = equipped[slot];
      if (!instance) continue;
      const itemDef = this.contentLoader.getItem(instance.baseItemId);
      if (itemDef?.narrativeTags) {
        tags.push(...itemDef.narrativeTags);
      }
    }
    // 최대 6개, 중복 제거
    return [...new Set(tags)].slice(0, 6);
  }

  /**
   * 활성 세트 보너스 정보 (UI/LLM용).
   */
  getActiveSetBonuses(equipped: EquippedGear): Array<{
    setId: string;
    name: string;
    count: number;
    bonus2Active: boolean;
    bonus3Active: boolean;
    bonus2Desc: string;
    bonus3Desc: string;
  }> {
    const itemSetMap = this.contentLoader.getItemSetMap();
    const setCounts = new Map<string, number>();
    for (const instance of Object.values(equipped)) {
      if (!instance) continue;
      const setId = itemSetMap[instance.baseItemId];
      if (setId) setCounts.set(setId, (setCounts.get(setId) ?? 0) + 1);
    }

    const result: Array<{
      setId: string;
      name: string;
      count: number;
      bonus2Active: boolean;
      bonus3Active: boolean;
      bonus2Desc: string;
      bonus3Desc: string;
    }> = [];

    for (const [setId, count] of setCounts) {
      const setDef = this.contentLoader.getSet(setId);
      if (!setDef) continue;
      result.push({
        setId,
        name: setDef.name,
        count,
        bonus2Active: count >= 2,
        bonus3Active: count >= 3,
        bonus2Desc: setDef.bonus2.description,
        bonus3Desc: setDef.bonus3.description,
      });
    }

    return result;
  }
}
