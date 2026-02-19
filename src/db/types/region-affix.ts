// Region Affix 시스템 — 장비 획득 시 위치 기반 접두사/접미사 부여

export type AffixKind = 'PREFIX' | 'SUFFIX';

export interface AffixModifier {
  stat: string;
  value: number;
}

export interface RegionAffixDef {
  affixId: string;
  kind: AffixKind;
  locationId: string;
  name: string;
  weight: number;
  modifiers: AffixModifier[];
  allowedProfiles: string[];
}

/** Rarity별 affix 부여 확률 테이블 */
export const AFFIX_PROBABILITY: Record<string, { prefix: number; suffix: number }> = {
  COMMON:    { prefix: 0.10, suffix: 0.05 },
  RARE:      { prefix: 0.25, suffix: 0.15 },
  UNIQUE:    { prefix: 0.35, suffix: 0.25 },
  LEGENDARY: { prefix: 0,    suffix: 0    }, // quest-only, no random affix
};
