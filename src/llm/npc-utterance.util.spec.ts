import {
  extractNpcUtterances,
  collectRecentNpcUtterances,
} from './npc-utterance.util.js';

const NARRATIVE_1 = [
  '회계사의 날카로운 눈빛이 당신을 찌른다.',
  '@[날카로운 눈매의 회계사|/npc-portraits/edric_veil.webp] "처음이라니, 시장의 공기가 그리 달콤해 보였소?"',
  '그는 말을 마친 뒤 급히 옷깃을 매만지며 시선을 돌린다.',
  '@[날카로운 눈매의 회계사|/npc-portraits/edric_veil.webp] "더는 말하기 어렵소. 그대가 직접 확인하시오."',
  '@[낡은 망토의 여인|/npc-portraits/rosa.webp] "저쪽 골목은 조심하는 게 좋을 거요."',
].join('\n\n');

const TARGET = {
  npcId: 'NPC_EDRIC_VEIL',
  displayNames: ['에드릭 베일', '날카로운 눈매의 회계사', '회계사'],
};

describe('extractNpcUtterances', () => {
  it('대상 NPC의 발화만 순서대로 추출한다', () => {
    const result = extractNpcUtterances(NARRATIVE_1, TARGET);
    expect(result).toEqual([
      '처음이라니, 시장의 공기가 그리 달콤해 보였소?',
      '더는 말하기 어렵소. 그대가 직접 확인하시오.',
    ]);
  });

  it('다른 NPC의 발화는 제외한다', () => {
    const result = extractNpcUtterances(NARRATIVE_1, TARGET);
    expect(result.join(' ')).not.toContain('저쪽 골목');
  });

  it('별칭 축약 변형(부분 포함)도 매칭한다', () => {
    const result = extractNpcUtterances(
      '@[회계사|/x.webp] "장부가 문제요."',
      TARGET,
    );
    expect(result).toEqual(['장부가 문제요.']);
  });

  it('@NPC_ID 서버 중간 형식도 추출한다', () => {
    const result = extractNpcUtterances(
      '@NPC_EDRIC_VEIL "숫자는 거짓말을 하지 않소."',
      TARGET,
    );
    expect(result).toEqual(['숫자는 거짓말을 하지 않소.']);
  });

  it('곡선 따옴표(u201C/u201D)도 처리한다', () => {
    const result = extractNpcUtterances(
      '@[날카로운 눈매의 회계사|/x.webp] “엿새 전부터 기록이 꼬였소.”',
      TARGET,
    );
    expect(result).toEqual(['엿새 전부터 기록이 꼬였소.']);
  });

  it('마커 없는 서술/빈 입력은 빈 배열', () => {
    expect(
      extractNpcUtterances('그는 조용히 고개를 끄덕였다.', TARGET),
    ).toEqual([]);
    expect(extractNpcUtterances(null, TARGET)).toEqual([]);
    expect(extractNpcUtterances(undefined, TARGET)).toEqual([]);
  });
});

describe('collectRecentNpcUtterances', () => {
  it('과거→최신 배열에서 최신순으로 각 턴의 마지막 발화를 수집한다', () => {
    const narratives = [
      '@[날카로운 눈매의 회계사|/x.webp] "첫 턴 대사요."',
      '마커 없는 턴 서술.',
      NARRATIVE_1,
    ];
    const result = collectRecentNpcUtterances(narratives, TARGET, 3);
    expect(result).toEqual([
      '더는 말하기 어렵소. 그대가 직접 확인하시오.', // 최신 턴의 마지막 발화
      '첫 턴 대사요.',
    ]);
  });

  it('maxCount를 초과하지 않는다', () => {
    const narratives = [
      '@[회계사|/x.webp] "하나."',
      '@[회계사|/x.webp] "둘."',
      '@[회계사|/x.webp] "셋."',
    ];
    expect(collectRecentNpcUtterances(narratives, TARGET, 2)).toEqual([
      '셋.',
      '둘.',
    ]);
  });
});
