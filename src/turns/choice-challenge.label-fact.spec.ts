// [A-3] 라벨 주제어 판돈 — 실제 팩 콘텐츠 대조 회귀 (버그 리포트 9fc337c9)
//
// 증상: "덩치 큰 하역 인부에게 밀수 루트에 대해 묻는다"(TALK·nano 선택지)를
// 클릭했는데 주사위 없이 "일상 행동 — 판정 불필요"로 처리됐다. 판돈 룰의
// 5개 조건(강행동·이벤트 fact·followup 접두·BLOCK·riskLevel)을 전부 비껴가
// 라벨 의미를 볼 경로가 없었다.
//
// 이 스펙은 turns.service 호출부와 **같은 매칭기**(getFactsByKeywords)로
// labelFactStake를 산출해, 실제 graymar_v1 콘텐츠에서 CHECK가 나오는지 본다.
import { ContentLoaderService } from '../content/content-loader.service.js';
import { runInScenarioContext } from '../content/scenario-context.js';
import { extractKoreanKeywords } from '../common/text-utils.js';
import { decideChoiceChallengeCore } from './choice-challenge.core.js';

describe('CHOICE 판돈 — 라벨 주제어 ↔ 미발견 fact (실 콘텐츠)', () => {
  let loader: ContentLoaderService;

  beforeAll(async () => {
    loader = new ContentLoaderService();
    await loader.ensurePack('graymar_v1');
  });

  /** turns.service 호출부와 동일한 산출 경로 */
  const stakeOf = (label: string, discovered: string[]): boolean => {
    const kw = extractKoreanKeywords(label);
    return (
      kw.size > 0 &&
      loader.getFactsByKeywords(kw, new Set(discovered)).length > 0
    );
  };

  // 버그 당시 실제 런(9db4250d) 24턴의 상태
  const BUG_LABEL = '덩치 큰 하역 인부에게 밀수 루트에 대해 묻는다';
  const BUG_DISCOVERED = [
    'FACT_WAGE_FRAUD_PATTERN',
    'FACT_LEDGER_EXISTS',
    'FACT_ROUTE_TO_EAST_DOCK',
    'FACT_TAMPERED_LOGS',
  ];

  it('버그 재현 케이스: 밀수 루트 질문은 이제 주사위를 굴린다', () => {
    runInScenarioContext('graymar_v1', () => {
      const labelFactStake = stakeOf(BUG_LABEL, BUG_DISCOVERED);
      expect(labelFactStake).toBe(true); // FACT_SMUGGLE_ROUTE_GUILD 미발견

      const d = decideChoiceChallengeCore({
        actionType: 'TALK',
        choiceId: 'nano_23_0',
        choiceRiskLevel: null,
        choiceAffordance: 'TALK',
        eventMatchPolicy: 'SUPPORT',
        eventDiscoverableFact: null,
        factAlreadyDiscovered: false,
        labelFactStake,
      });
      expect(d.result).toBe('CHECK');
      expect(d.reason).toBe('label fact stake');
    });
  });

  it('해당 단서를 이미 발견했으면 판돈이 아니다 — 재질문은 FREE', () => {
    runInScenarioContext('graymar_v1', () => {
      const labelFactStake = stakeOf(BUG_LABEL, [
        ...BUG_DISCOVERED,
        'FACT_SMUGGLE_ROUTE_GUILD',
      ]);
      expect(labelFactStake).toBe(false);

      const d = decideChoiceChallengeCore({
        actionType: 'TALK',
        choiceId: 'nano_23_0',
        choiceAffordance: 'TALK',
        labelFactStake,
      });
      expect(d.result).toBe('FREE');
    });
  });

  it('단서와 무관한 잡담은 여전히 무판정 — 판정 인플레 방지', () => {
    runInScenarioContext('graymar_v1', () => {
      for (const label of [
        '그의 묵직한 목소리에 답한다',
        '고개를 끄덕이며 인사한다',
      ]) {
        const d = decideChoiceChallengeCore({
          actionType: 'TALK',
          choiceId: 'nano_9_0',
          choiceAffordance: 'TALK',
          labelFactStake: stakeOf(label, BUG_DISCOVERED),
        });
        expect(d.result).toBe('FREE');
      }
    });
  });
});
