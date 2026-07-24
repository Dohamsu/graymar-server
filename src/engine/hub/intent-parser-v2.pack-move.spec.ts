/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access */
// bug b4e4da73 회귀 — 비-graymar 팩의 "장소명으로 간다" 이동 실패.
//   detectLocationBasedMove가 구 graymar 전용 하드코딩 LOCATION_NAMES를 순회해
//   star_sand의 "관측탑"을 못 잡음 → 복합감지 false → KW override 미발동 →
//   LLM 오분류(OBSERVE)가 채택되어 이동이 흡수됨(불변식 21·45).
//   수정: detectLocationBasedMove가 활성 팩 moveKeywords에서 장소명 파생.

import { IntentParserV2Service } from './intent-parser-v2.service.js';
import { LlmIntentParserService } from './llm-intent-parser.service.js';
import { makeFakeContentWithMoveKeywords } from './test-support/fake-content-move.js';

// star_sand LOC_SS_TOWER "오로라 관측탑" moveKeywords
const STAR_SAND_MOVE_KEYWORDS = [
  '관측탑', '오로라', '탑', '관측', '망원경', // LOC_SS_TOWER
  '수녀원', '등불', '절벽', // LOC_SS_CONVENT
  '심장', '웅덩이', // LOC_SS_HEART
];

describe('detectLocationBasedMove — 팩 파생 장소명 (bug b4e4da73)', () => {
  const parser = new IntentParserV2Service(
    makeFakeContentWithMoveKeywords(STAR_SAND_MOVE_KEYWORDS),
  );

  it.each(['관측탑으로 간다', '관측탑으로 가줘', '수녀원으로 향한다', '심장 웅덩이로 이동한다'])(
    '"%s" → detectLocationBasedMove true',
    (input) => {
      expect(parser.detectLocationBasedMove(input)).toBe(true);
    },
  );

  it('"관측탑으로 간다" → parse actionType MOVE_LOCATION', () => {
    expect(parser.parse('관측탑으로 간다').actionType).toBe('MOVE_LOCATION');
  });
});

describe('mergeResults — LLM 오분류(OBSERVE) KW override (bug b4e4da73)', () => {
  const keywordParser = new IntentParserV2Service(
    makeFakeContentWithMoveKeywords(STAR_SAND_MOVE_KEYWORDS),
  );
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

  it('"관측탑으로 간다" + LLM=OBSERVE → MOVE_LOCATION (실측 재현)', () => {
    const r = callMerge('OBSERVE', '관측탑으로 간다');
    expect(r.actionType).toBe('MOVE_LOCATION');
    expect(r.source).toBe('RULE'); // KW_OVERRIDE
  });

  it('"관측탑으로 가줘" + LLM=OBSERVE → MOVE_LOCATION', () => {
    const r = callMerge('OBSERVE', '관측탑으로 가줘');
    expect(r.actionType).toBe('MOVE_LOCATION');
  });
});
