/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access */
// P1 2026-07-11 — 무목적지 순수 이동 상용구 회귀 테스트.
//   "다른 장소로 이동한다"(playtest 기본 이동 문구이자 자연스러운 유저 표현)를
//   LLM이 TALK로 오판 → merge에서 LLM 승 → 이동이 대화에 흡수, 26턴 단일 장소
//   갇힘 실측. 문장 전체가 이동 상용구인 경우 KW_OVERRIDE로 이동을 보장하되,
//   문장 속 1-hit 오탐(불변식 21 취지)은 그대로 LLM 신뢰를 유지한다.

import { IntentParserV2Service } from './intent-parser-v2.service.js';
import { LlmIntentParserService } from './llm-intent-parser.service.js';
import { makeFakeContentForMove } from './test-support/fake-content-move.js';

describe('detectPureMoveIntent — 무목적지 순수 이동 상용구', () => {
  const parser = new IntentParserV2Service(makeFakeContentForMove());

  it.each([
    '다른 장소로 이동한다',
    '다른 곳으로 간다',
    '딴 데로 가자',
    '이제 다른 장소로 떠난다',
    '여기를 떠난다',
    '이곳에서 벗어난다',
    '이동한다',
    '이만 자리를 옮긴다',
  ])('순수 이동: "%s" → true', (input) => {
    expect(parser.detectPureMoveIntent(input)).toBe(true);
  });

  it.each([
    '장부 사건, 부두 쪽 사람들 의심하시오?', // 문장 속 언급 — 불변식 21 오탐 케이스
    '다른 사람에게 말을 건다', // "다른"이 있지만 이동 아님
    '그 장소에 대해 묻는다', // 장소 언급 질문
    '장부를 옮긴다', // 목적어 있는 물건 이동
    '다른 장소로 이동하는 게 좋겠소?', // 이동 상의 (대화)
    '동작그만', // 서브스트링 오탐 원조 케이스
  ])('오탐 방지: "%s" → false', (input) => {
    expect(parser.detectPureMoveIntent(input)).toBe(false);
  });
});

describe('mergeResults — 순수 이동 KW_OVERRIDE (LLM=TALK 흡수 방지)', () => {
  const keywordParser = new IntentParserV2Service(makeFakeContentForMove());
  const svc = new LlmIntentParserService(
    keywordParser,
    { getByName: () => null } as never,
    { getAllNpcs: () => [] } as never,
  );
  const callMerge = (
    llmActionType: string,
    inputText: string,
  ): { actionType: string; source: string } => {
    const kw = keywordParser.parse(inputText);
    const merged = (svc as any).mergeResults(
      {
        actionType: llmActionType,
        secondaryActionType: null,
        tone: 'NEUTRAL',
        target: null,
        riskLevel: 1,
        targetNpc: null,
      },
      kw,
      inputText,
      0,
      null,
    );
    return { actionType: merged.actionType, source: merged.source };
  };

  it('"다른 장소로 이동한다" + LLM=TALK → MOVE_LOCATION (실측 재현)', () => {
    const r = callMerge('TALK', '다른 장소로 이동한다');
    expect(r.actionType).toBe('MOVE_LOCATION');
    expect(r.source).toBe('RULE'); // KW_OVERRIDE
  });

  it('"여기를 떠난다" + LLM=TALK → MOVE_LOCATION', () => {
    const r = callMerge('TALK', '여기를 떠난다');
    expect(r.actionType).toBe('MOVE_LOCATION');
  });

  it('문장 속 이동 키워드 1-hit + LLM=TALK → 기존대로 LLM 신뢰 유지', () => {
    // KW가 MOVE_LOCATION으로 잡더라도 순수 이동 문장이 아니면 LLM 승 (불변식 21)
    const kw = keywordParser.parse('가장 기억에 남는 곳으로 가 본 적 있소?');
    if (kw.actionType === 'MOVE_LOCATION') {
      const r = callMerge('TALK', '가장 기억에 남는 곳으로 가 본 적 있소?');
      expect(r.actionType).toBe('TALK');
    }
  });
});
