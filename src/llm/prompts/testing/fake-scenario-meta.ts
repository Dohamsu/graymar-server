/**
 * spec 전용 — architecture/63 시나리오 파생 API의 공용 fake.
 * prompt-builder 계열 spec 3곳에 verbatim 복붙되어 있던 것을 단일화 (리뷰 반영).
 */

export const FAKE_WORLD_META = {
  settingLine: '중세 판타지 왕국',
  regionSummary:
    '그레이마르 7개 지역 자유 탐험. 선술집이 거점. Heat(경계도) 변동. 시간대별 분위기 차이.',
};

export const FAKE_HUB_META = {
  locationId: 'LOC_TAVERN',
  name: '잠긴 닻 선술집',
  returnLabel: "'잠긴 닻' 선술집으로 돌아간다",
  returnHint: '선술집에서 정보를 정리하고 다른 지역을 탐색한다',
  defaultLocationId: 'LOC_MARKET',
};

export const fakeScenarioAccessors = {
  getWorldMeta: (): typeof FAKE_WORLD_META => FAKE_WORLD_META,
  getHubMeta: (): typeof FAKE_HUB_META => FAKE_HUB_META,
  getLocationDisplayName: (id: string): string => id,
  getLocationShortName: (id: string): string => id,
};
