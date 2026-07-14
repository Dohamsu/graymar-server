// 정본: architecture/10_region_economy.md §2 — Equipment System

import type { PermanentStats } from './permanent-stats.js';

// --- 장비 슬롯 ---

export const EQUIPMENT_SLOTS = [
  'WEAPON',
  'ARMOR',
  'TACTICAL',
  'POLITICAL',
  'RELIC',
] as const;
export type EquipmentSlot = (typeof EQUIPMENT_SLOTS)[number];

// --- 희귀도 ---

export const ITEM_RARITIES = ['COMMON', 'RARE', 'UNIQUE', 'LEGENDARY'] as const;
export type ItemRarity = (typeof ITEM_RARITIES)[number];

// --- 장비 아이템 확장 필드 ---

export type StatKey = keyof PermanentStats;

export interface EquipmentFields {
  rarity: ItemRarity;
  slot: EquipmentSlot;
  statBonus: Partial<Record<StatKey, number>>; // { atk: 3, crit: 2 } 등
  setId?: string; // 세트 소속 ID
  narrativeTags: string[]; // 서술 태그 (LLM 톤 영향)
  allowRegionAffix?: boolean; // Region Affix 부여 가능 여부
  regionAffixProfileId?: string; // affix 프로필 (PROFILE_LIGHT_WEAPON 등)
}

// --- 장비 인스턴스 (affix 포함) ---

export interface ItemInstance {
  instanceId: string; // UUID
  baseItemId: string; // items.json의 itemId 참조
  prefixAffixId?: string; // region_affixes.json 참조
  suffixAffixId?: string;
  displayName: string; // "소금기 밴 밀수업자의 단검 조류의"
  /**
   * 캠페인 이월 스냅샷 (architecture/71 §4.4) — baseItemId/affixId가 다른 팩
   * 콘텐츠라 활성 팩에서 해석 불가할 때 사용하는 동결 데이터.
   * 시나리오 완주 merge 시점(원 팩 컨텍스트)에 base statBonus + affix FLAT을
   * 합산해 기록한다. 세트 보너스는 팩 경계를 넘지 않는다(비이월).
   */
  carrySnapshot?: {
    sourceScenarioId: string;
    slot: EquipmentSlot;
    rarity: ItemRarity;
    statBonus: Record<string, number>;
    narrativeTags?: string[];
  };
}

// --- 장착 상태 ---

export type EquippedGear = Partial<Record<EquipmentSlot, ItemInstance>>; // slot → ItemInstance

// --- 세트 보너스 ---

export interface SetDefinition {
  setId: string;
  name: string;
  regionId: string;
  type: 'COMBAT' | 'POLITICAL';
  pieces: string[]; // itemIds
  bonus2: SetBonus; // 2-piece
  bonus3: SetBonus; // 3-piece
}

export interface SetBonus {
  description: string;
  statBonus?: Partial<Record<StatKey, number>>;
  specialEffect?: string; // 코드로 처리할 특수 효과 키
}

// --- 유틸 ---

export function emptyEquipped(): EquippedGear {
  return {};
}

export function countSetPieces(
  equipped: EquippedGear,
  setId: string,
  itemSetMap: Record<string, string | undefined>,
): number {
  let count = 0;
  for (const instance of Object.values(equipped)) {
    if (instance && itemSetMap[instance.baseItemId] === setId) count++;
  }
  return count;
}
