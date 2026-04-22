// 정본: architecture/41_creative_combat_actions.md §2.3 — Tier 4 환상 키워드

export const FANTASY_KEYWORDS: Record<string, string[]> = {
  magic: ['마법', '주문', '봉인', '강령', '저주', '축복', '성화', '신력'],
  creature: ['드래곤', '용', '유니콘', '그리폰', '정령', '악마', '천사'],
  element: ['번개', '화염', '얼음', '폭풍', '화산', '지진', '허리케인'],
  spacetime: ['순간이동', '이동술', '시간', '되돌림', '멈춤', '예지', '환영'],
  summon: ['소환', '부름', '불러냄', '창조', '제물'],
  resurrection: ['부활', '환생', '영생', '불사'],
};

/** 플래튼된 전체 키워드 리스트 (매칭 시 빠른 스캔용) */
export const FANTASY_KEYWORDS_FLAT: string[] = Object.values(
  FANTASY_KEYWORDS,
).flat();
