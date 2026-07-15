// [P4-5 — architecture/75 §5·§6] 동적 Fact 해석 심(seam) 검증.
//
// 목표: plotSeed.keyFacts(facts.json에 없는)가 getFact/getFactsByKeywords/
// getFactsKnownBy/npcKnowsFact를 통해 저작 fact와 동일하게 해석되는가 +
// 컨텍스트 격리 + 저작 fact 무회귀. getFact는 context-builder의 questReveal
// 서술 주입 소스이므로, 여기서 폴백이 증명되면 "발견 keyFact가 LLM 서술에
// 주입"되는 경로가 전이적으로 커버된다.

import { ContentLoaderService } from './content-loader.service.js';
import { runWithDynamicFacts } from './scenario-context.js';

describe('[P4-5] Dynamic Fact 해석 심 (architecture/75 §5)', () => {
  let loader: ContentLoaderService;

  /** applyDynamicFacts와 동일 변환을 거친 형태 (KeyFact → FactDefinition) */
  const dynFact = {
    factId: 'FACT_DYN_TEST_1',
    topic: '밀수 장부의 존재',
    description: '창고 뒤편에 위조된 밀수 장부가 숨겨져 있다',
    keywords: ['밀수', '장부', '창고'],
    knownBy: ['NPC_DYN_1', 'NPC_MIREL'],
    versions: {},
    nextHint: '창고지기가 밤마다 자리를 비운다',
  };

  beforeAll(async () => {
    loader = new ContentLoaderService();
    await loader.loadScenario('graymar_v1');
  });

  it('컨텍스트 안: getFact가 동적 fact를 해석한다 (questReveal 주입 경로)', () => {
    runWithDynamicFacts([dynFact], () => {
      const f = loader.getFact('FACT_DYN_TEST_1');
      expect(f).toBeDefined();
      expect(f!.description).toContain('밀수 장부');
      expect(f!.knownBy).toContain('NPC_DYN_1');
    });
  });

  it('컨텍스트 밖: 동적 fact는 보이지 않는다 (격리)', () => {
    expect(loader.getFact('FACT_DYN_TEST_1')).toBeUndefined();
  });

  it('getFactsByKeywords: 입력 키워드가 동적 fact에 매칭된다 (주제 우선 선택 경로)', () => {
    runWithDynamicFacts([dynFact], () => {
      const hits = loader.getFactsByKeywords(new Set(['밀수', '장부에']));
      expect(hits.some((f) => f.factId === 'FACT_DYN_TEST_1')).toBe(true);
    });
  });

  it('getFactsByKeywords: 발견된 동적 fact는 exclude로 제외된다', () => {
    runWithDynamicFacts([dynFact], () => {
      const hits = loader.getFactsByKeywords(
        new Set(['밀수', '장부']),
        new Set(['FACT_DYN_TEST_1']),
      );
      expect(hits.some((f) => f.factId === 'FACT_DYN_TEST_1')).toBe(false);
    });
  });

  it('getFactsKnownBy/npcKnowsFact: holders가 knownBy로 동작한다', () => {
    runWithDynamicFacts([dynFact], () => {
      expect(
        loader
          .getFactsKnownBy('NPC_DYN_1')
          .some((f) => f.factId === 'FACT_DYN_TEST_1'),
      ).toBe(true);
      expect(loader.npcKnowsFact('NPC_DYN_1', 'FACT_DYN_TEST_1')).toBe(true);
      expect(loader.npcKnowsFact('NPC_OTHER', 'FACT_DYN_TEST_1')).toBe(false);
    });
  });

  it('저작 fact 무회귀: 동적 컨텍스트가 있어도 저작 fact 조회는 동일', () => {
    const authoredAll = loader.getAllFacts();
    expect(authoredAll.length).toBeGreaterThan(0);
    const sample = authoredAll[0];
    runWithDynamicFacts([dynFact], () => {
      expect(loader.getFact(sample.factId)).toEqual(sample);
    });
  });
});
