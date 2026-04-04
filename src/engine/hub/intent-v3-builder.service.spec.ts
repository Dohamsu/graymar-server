import { IntentV3BuilderService } from './intent-v3-builder.service.js';
import type {
  ParsedIntentV2,
  IntentActionType,
} from '../../db/types/parsed-intent-v2.js';
import type { ParsedIntentV3 } from '../../db/types/parsed-intent-v3.js';

function makeV2(overrides: Partial<ParsedIntentV2> = {}): ParsedIntentV2 {
  return {
    inputText: '테스트 입력',
    actionType: 'TALK',
    tone: 'NEUTRAL',
    target: null,
    riskLevel: 1,
    intentTags: [],
    confidence: 1,
    source: 'RULE',
    ...overrides,
  };
}

describe('IntentV3BuilderService', () => {
  let service: IntentV3BuilderService;

  beforeEach(() => {
    service = new IntentV3BuilderService();
  });

  // --- approachVector 매핑 ---

  const vectorCases: Array<[IntentActionType, string]> = [
    ['TALK', 'SOCIAL'],
    ['PERSUADE', 'SOCIAL'],
    ['HELP', 'SOCIAL'],
    ['BRIBE', 'ECONOMIC'],
    ['TRADE', 'ECONOMIC'],
    ['SHOP', 'ECONOMIC'],
    ['SNEAK', 'STEALTH'],
    ['STEAL', 'STEALTH'],
    ['OBSERVE', 'OBSERVATIONAL'],
    ['INVESTIGATE', 'OBSERVATIONAL'],
    ['SEARCH', 'OBSERVATIONAL'],
    ['THREATEN', 'PRESSURE'],
    ['FIGHT', 'VIOLENT'],
    ['MOVE_LOCATION', 'LOGISTICAL'],
    ['REST', 'LOGISTICAL'],
  ];

  it.each(vectorCases)(
    '%s → approachVector = %s',
    (actionType, expectedVector) => {
      const v2 = makeV2({ actionType });
      const v3 = service.build(v2, '입력', 'market');
      expect(v3.approachVector).toBe(expectedVector);
    },
  );

  // --- goalCategory 기본 매핑 ---

  const goalCases: Array<[IntentActionType, string]> = [
    ['TALK', 'GET_INFO'],
    ['OBSERVE', 'GET_INFO'],
    ['INVESTIGATE', 'GET_INFO'],
    ['SEARCH', 'GET_INFO'],
    ['PERSUADE', 'SHIFT_RELATION'],
    ['HELP', 'SHIFT_RELATION'],
    ['SNEAK', 'GAIN_ACCESS'],
    ['MOVE_LOCATION', 'GAIN_ACCESS'],
    ['BRIBE', 'GAIN_ACCESS'],
    ['THREATEN', 'ESCALATE_CONFLICT'],
    ['FIGHT', 'ESCALATE_CONFLICT'],
    ['TRADE', 'ACQUIRE_RESOURCE'],
    ['STEAL', 'ACQUIRE_RESOURCE'],
    ['SHOP', 'ACQUIRE_RESOURCE'],
    ['REST', 'DEESCALATE_CONFLICT'],
  ];

  it.each(goalCases)(
    '%s → goalCategory = %s (target 없음)',
    (actionType, expectedGoal) => {
      const v2 = makeV2({ actionType, target: null });
      const v3 = service.build(v2, '입력', 'market');
      expect(v3.goalCategory).toBe(expectedGoal);
    },
  );

  // --- target 있을 때 goalCategory 보정 ---

  it('BRIBE + target → GET_INFO로 보정', () => {
    const v2 = makeV2({ actionType: 'BRIBE', target: '상인' });
    const v3 = service.build(v2, '상인에게 뇌물', 'market');
    expect(v3.goalCategory).toBe('GET_INFO');
  });

  it('SNEAK + target → HIDE_TRACE로 보정', () => {
    const v2 = makeV2({ actionType: 'SNEAK', target: '경비' });
    const v3 = service.build(v2, '경비를 피해 숨는다', 'guard_post');
    expect(v3.goalCategory).toBe('HIDE_TRACE');
  });

  it('TALK + target → SHIFT_RELATION으로 보정', () => {
    const v2 = makeV2({ actionType: 'TALK', target: '주민' });
    const v3 = service.build(v2, '주민에게 말을 건다', 'slum');
    expect(v3.goalCategory).toBe('SHIFT_RELATION');
  });

  // --- goalText 생성 ---

  it('target 있으면 goalText에 target 포함', () => {
    const v2 = makeV2({ actionType: 'INVESTIGATE', target: '창고' });
    const v3 = service.build(v2, '창고를 조사한다', 'harbor');
    expect(v3.goalText).toBe('창고 관련 정보 확보');
  });

  it('target 없으면 goalText에 locationId 포함', () => {
    const v2 = makeV2({ actionType: 'INVESTIGATE', target: null });
    const v3 = service.build(v2, '주변을 조사한다', 'harbor');
    expect(v3.goalText).toBe('harbor에서 정보 수집');
  });

  // --- V3 기본 구조 ---

  it('version은 항상 3', () => {
    const v3 = service.build(makeV2(), '입력', 'market');
    expect(v3.version).toBe(3);
  });

  it('rawInput이 정확히 전달', () => {
    const v3 = service.build(makeV2(), '원본 텍스트', 'market');
    expect(v3.rawInput).toBe('원본 텍스트');
  });

  it('V2 필드가 V3로 정확히 복사됨', () => {
    const v2 = makeV2({
      actionType: 'FIGHT',
      secondaryActionType: 'THREATEN',
      tone: 'AGGRESSIVE',
      target: '경비',
      riskLevel: 3,
      intentTags: ['combat', 'hostile'],
      confidence: 2,
      source: 'LLM',
      suppressedActionType: 'TALK',
      escalated: true,
    });
    const v3 = service.build(v2, '싸운다', 'guard_post');

    expect(v3.primaryActionType).toBe('FIGHT');
    expect(v3.secondaryActionType).toBe('THREATEN');
    expect(v3.tone).toBe('AGGRESSIVE');
    expect(v3.targetText).toBe('경비');
    expect(v3.riskLevel).toBe(3);
    expect(v3.intentTags).toEqual(['combat', 'hostile']);
    expect(v3.confidence).toBe(2);
    expect(v3.source).toBe('LLM');
    expect(v3.suppressedActionType).toBe('TALK');
    expect(v3.escalated).toBe(true);
  });

  // --- secondaryApproachVector ---

  it('secondary가 primary와 다르면 secondaryApproachVector 설정', () => {
    const v2 = makeV2({ actionType: 'FIGHT', secondaryActionType: 'SNEAK' });
    const v3 = service.build(v2, '입력', 'market');
    expect(v3.approachVector).toBe('VIOLENT');
    expect(v3.secondaryApproachVector).toBe('STEALTH');
  });

  it('secondary가 primary와 같은 vector면 null', () => {
    const v2 = makeV2({ actionType: 'TALK', secondaryActionType: 'PERSUADE' });
    const v3 = service.build(v2, '입력', 'market');
    expect(v3.approachVector).toBe('SOCIAL');
    expect(v3.secondaryApproachVector).toBeNull();
  });

  it('secondary 없으면 null', () => {
    const v2 = makeV2({ actionType: 'TALK' });
    const v3 = service.build(v2, '입력', 'market');
    expect(v3.secondaryApproachVector).toBeNull();
  });

  // --- CHOICE source ---

  it('CHOICE source도 정상 처리', () => {
    const v2 = makeV2({ actionType: 'INVESTIGATE', source: 'CHOICE' });
    const v3 = service.build(v2, '선택지', 'market', { sourceEventId: 'evt1' });
    expect(v3.source).toBe('CHOICE');
    expect(v3.goalCategory).toBe('GET_INFO');
  });

  it('choicePayload에 goalCategory가 있으면 우선', () => {
    const v2 = makeV2({ actionType: 'TALK', source: 'CHOICE' });
    const v3 = service.build(v2, '선택지', 'market', {
      goalCategory: 'BLOCK_RIVAL',
    });
    expect(v3.goalCategory).toBe('BLOCK_RIVAL');
  });

  // --- escalated ---

  it('escalated=false → V3도 false', () => {
    const v2 = makeV2({ escalated: false });
    const v3 = service.build(v2, '입력', 'market');
    expect(v3.escalated).toBe(false);
  });

  it('escalated 미설정 → V3도 false', () => {
    const v2 = makeV2();
    const v3 = service.build(v2, '입력', 'market');
    expect(v3.escalated).toBe(false);
  });

  // --- intentTags 독립 복사 ---

  it('intentTags는 원본과 분리된 복사본', () => {
    const tags = ['tag1', 'tag2'];
    const v2 = makeV2({ intentTags: tags });
    const v3 = service.build(v2, '입력', 'market');
    v3.intentTags.push('tag3');
    expect(tags).toHaveLength(2);
  });
});
