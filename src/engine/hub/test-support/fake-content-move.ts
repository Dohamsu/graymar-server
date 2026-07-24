import type { ContentLoaderService } from '../../../content/content-loader.service.js';

/**
 * IntentParserV2Service 유닛 테스트용 fake ContentLoader.
 *
 * detectLocationBasedMove(불변식 45)는 활성 팩 moveKeywords에서 장소명을
 * 파생하므로, 파서를 단독 인스턴스화하는 스펙엔 콘텐츠 스텁이 필요하다.
 * 아래 이름은 graymar_v1 locations.json의 moveKeywords/Fallback 집합(구
 * 하드코딩 LOCATION_NAMES와 동일)으로, 기존 graymar 케이스 동작을 보존한다.
 */
const GRAYMAR_MOVE_KEYWORDS = [
  // LOC_MARKET
  '시장',
  '상점가',
  '장터',
  '노점가',
  // LOC_GUARD
  '경비대',
  '초소',
  '병영',
  '수비대',
  '순찰대',
  // LOC_HARBOR
  '항만',
  '부두',
  '항구',
  '선착장',
  '포구',
  '배터',
  // LOC_SLUMS
  '빈민가',
  '슬럼',
  '하층가',
  '빈민굴',
  // LOC_NOBLE
  '귀족',
  '상류',
  '저택',
  '귀족가',
  // LOC_TAVERN
  '선술집',
  '숙소',
  '잠긴 닻',
  '거점',
  // LOC_DOCKS_WAREHOUSE
  '창고',
  '창고구',
  '하역장',
];

export function makeFakeContentForMove(): ContentLoaderService {
  return makeFakeContentWithMoveKeywords(GRAYMAR_MOVE_KEYWORDS);
}

/** 임의 팩 moveKeywords를 반환하는 fake ContentLoader (비-graymar 팩 회귀용). */
export function makeFakeContentWithMoveKeywords(
  keywords: string[],
): ContentLoaderService {
  return {
    getMoveKeywordEntries: () => [{ keywords, locationId: 'LOC_TEST' }],
  } as unknown as ContentLoaderService;
}
