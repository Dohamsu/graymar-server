// 정본: architecture/41_creative_combat_actions.md §1~§3 — 5-Tier 분류기

import { Injectable } from '@nestjs/common';
import {
  IMPROVISED_CATEGORIES,
  type ImprovisedCategory,
  type ImprovisedEffects,
} from './improvised-categories.js';
import { FANTASY_KEYWORDS_FLAT } from './fantasy-keywords.js';
import { ABSTRACT_KEYWORDS } from './abstract-keywords.js';

export interface PropEffects {
  damageBonus?: number;
  stunChance?: number;
  bleedStacks?: number;
  blindTurns?: number;
  accReduceTarget?: number;
  defBuffNextTurn?: number;
  restrainTurns?: number;
}

export interface EnvironmentProp {
  id: string;
  name: string;
  keywords: string[];
  locationTags?: string[];
  effects: PropEffects;
  oneTimeUse?: boolean;
  rarity?: 'common' | 'rare';
}

export interface PropMatchFlags {
  fantasy?: boolean;
  abstract?: boolean;
}

export interface PropMatchResult {
  tier: 1 | 2 | 3 | 4 | 5;
  prop?: { id: string; name: string; effects: PropEffects };
  improvised?: { categoryId: string; effects: ImprovisedEffects };
  flags?: PropMatchFlags;
}

@Injectable()
export class PropMatcherService {
  /**
   * 플레이어 rawInput을 5-Tier로 분류한다.
   *
   * 우선순위:
   *   Tier 5 (추상) → Tier 1 (등록 프롭) → Tier 2 (카테고리) → Tier 4 (환상) → Tier 3
   *
   * @param rawInput 플레이어 입력 원문
   * @param environmentProps 현재 전투 씬에 등장 가능한 프롭 목록
   */
  classify(
    rawInput: string,
    environmentProps: EnvironmentProp[],
  ): PropMatchResult {
    const input = (rawInput ?? '').trim();
    if (!input) return { tier: 3 };

    // ① Tier 5 — 추상/메타 키워드 최우선 (게임 시스템 경계 침범)
    if (this.matchesAbstract(input)) {
      return { tier: 5, flags: { abstract: true } };
    }

    // ② Tier 1 — 등록 프롭
    const propMatch = this.findRegisteredProp(input, environmentProps);
    if (propMatch) {
      return {
        tier: 1,
        prop: {
          id: propMatch.id,
          name: propMatch.name,
          effects: propMatch.effects,
        },
      };
    }

    // ③ Tier 2 — 즉흥 카테고리
    const categoryMatch = this.findImprovisedCategory(input);
    if (categoryMatch) {
      return {
        tier: 2,
        improvised: {
          categoryId: categoryMatch.id,
          effects: categoryMatch.effects,
        },
      };
    }

    // ④ Tier 4 — 환상 키워드
    if (this.matchesFantasy(input)) {
      return { tier: 4, flags: { fantasy: true } };
    }

    // ⑤ Tier 3 — 서술 커버 (fallback)
    return { tier: 3 };
  }

  private matchesAbstract(input: string): boolean {
    return ABSTRACT_KEYWORDS.some((kw) => input.includes(kw));
  }

  private findRegisteredProp(
    input: string,
    props: EnvironmentProp[],
  ): EnvironmentProp | null {
    for (const prop of props) {
      if (prop.keywords.some((kw) => input.includes(kw))) {
        return prop;
      }
    }
    return null;
  }

  private findImprovisedCategory(input: string): ImprovisedCategory | null {
    for (const cat of IMPROVISED_CATEGORIES) {
      if (cat.keywords.some((kw) => input.includes(kw))) {
        return cat;
      }
    }
    return null;
  }

  private matchesFantasy(input: string): boolean {
    return FANTASY_KEYWORDS_FLAT.some((kw) => input.includes(kw));
  }
}
