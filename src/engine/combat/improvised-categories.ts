// 정본: architecture/41_creative_combat_actions.md §2.2 — Tier 2 즉흥 카테고리

export interface ImprovisedEffects {
  damageBonus?: number;
  stunChance?: number;
  bleedStacks?: number;
  blindTurns?: number;
  accReduceTarget?: number;
  defBuffNextTurn?: number;
  restrainTurns?: number;
}

export interface ImprovisedCategory {
  id: string;
  keywords: string[];
  effects: ImprovisedEffects;
}

export const IMPROVISED_CATEGORIES: ImprovisedCategory[] = [
  {
    id: 'heavy',
    keywords: ['돌', '벽돌', '나무', '상자', '목재', '덩어리', '뭉치', '덩이'],
    effects: { damageBonus: 1.1, stunChance: 10 },
  },
  {
    id: 'sharp',
    keywords: ['파편', '유리', '조각', '침', '가시', '못', '쇠꼬챙이'],
    effects: { bleedStacks: 1 },
  },
  {
    id: 'light_source',
    keywords: ['등불', '촛불', '등잔', '기름', '불꽃', '횃'],
    effects: { blindTurns: 1 },
  },
  {
    id: 'obscurant',
    keywords: ['연기', '먼지', '재', '모래', '흙', '그을음'],
    effects: { accReduceTarget: -3 },
  },
  {
    id: 'restraint',
    keywords: ['끈', '줄', '포', '천', '밧줄', '사슬'],
    effects: { restrainTurns: 1 },
  },
];
