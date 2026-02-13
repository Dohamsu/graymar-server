import { RuleParserService } from './rule-parser.service.js';

describe('RuleParserService', () => {
  let parser: RuleParserService;

  beforeEach(() => {
    parser = new RuleParserService();
  });

  describe('단일 키워드 매칭', () => {
    it('"검으로 베다" → ATTACK_MELEE, confidence 0.9', () => {
      const result = parser.parse('검으로 베다');
      expect(result.intents).toContain('ATTACK_MELEE');
      expect(result.confidence).toBe(0.9);
      expect(result.source).toBe('RULE');
    });

    it('"활을 쏜다" → ATTACK_RANGED', () => {
      const result = parser.parse('활을 쏜다');
      expect(result.intents).toContain('ATTACK_RANGED');
    });

    it('"방어" → DEFEND', () => {
      const result = parser.parse('방어');
      expect(result.intents).toContain('DEFEND');
    });

    it('"회피한다" → EVADE', () => {
      const result = parser.parse('몸을 낮추며 회피');
      expect(result.intents).toContain('EVADE');
    });

    it('"도망친다" → FLEE', () => {
      const result = parser.parse('도망친다');
      expect(result.intents).toContain('FLEE');
    });

    it('"포션 사용" → USE_ITEM', () => {
      const result = parser.parse('포션 사용');
      expect(result.intents).toContain('USE_ITEM');
    });

    it('"대화한다" → TALK', () => {
      const result = parser.parse('대화한다');
      expect(result.intents).toContain('TALK');
    });

    it('"조사한다" → SEARCH', () => {
      const result = parser.parse('주변을 조사한다');
      expect(result.intents).toContain('SEARCH');
    });

    it('"관찰한다" → OBSERVE', () => {
      const result = parser.parse('적을 관찰한다');
      expect(result.intents).toContain('OBSERVE');
    });
  });

  describe('복합 키워드', () => {
    it('2개 매칭 → confidence 0.8', () => {
      const result = parser.parse('검으로 공격하고 방어한다');
      expect(result.intents).toContain('ATTACK_MELEE');
      expect(result.intents).toContain('DEFEND');
      expect(result.confidence).toBe(0.8);
    });

    it('3개 이상 → confidence 0.6', () => {
      const result = parser.parse('공격하고 방어하면서 회피');
      expect(result.intents.length).toBeGreaterThanOrEqual(3);
      expect(result.confidence).toBe(0.6);
    });
  });

  describe('매칭 실패', () => {
    it('키워드 없음 → OBSERVE fallback, confidence 0.0', () => {
      const result = parser.parse('아무것도 하지 않는다');
      expect(result.intents).toEqual(['OBSERVE']);
      expect(result.confidence).toBe(0.0);
    });
  });

  describe('방향 추출', () => {
    it('"오른쪽" → RIGHT', () => {
      const result = parser.parse('오른쪽으로 이동');
      expect(result.direction).toBe('RIGHT');
    });

    it('"왼쪽" → LEFT', () => {
      const result = parser.parse('왼쪽으로 이동');
      expect(result.direction).toBe('LEFT');
    });

    it('"앞으로" → FORWARD', () => {
      const result = parser.parse('앞으로 다가간다');
      expect(result.direction).toBe('FORWARD');
    });

    it('"뒤로" → BACK', () => {
      const result = parser.parse('뒤로 물러난다');
      expect(result.direction).toBe('BACK');
    });
  });

  describe('제약 조건 추출', () => {
    it('"조심스럽게" → careful', () => {
      const result = parser.parse('조심스럽게 공격한다');
      expect(result.constraints).toContain('careful');
    });

    it('"빨리" → fast', () => {
      const result = parser.parse('빨리 도망');
      expect(result.constraints).toContain('fast');
    });

    it('"몰래" → stealth', () => {
      const result = parser.parse('몰래 이동한다');
      expect(result.constraints).toContain('stealth');
    });
  });

  describe('riskLevel', () => {
    it('1개 intent → LOW', () => {
      const result = parser.parse('공격한다');
      expect(result.riskLevel).toBe('LOW');
    });

    it('2개 intent → MED', () => {
      const result = parser.parse('공격하고 방어');
      expect(result.riskLevel).toBe('MED');
    });

    it('3개 이상 intent → HIGH', () => {
      const result = parser.parse('공격하고 방어하면서 회피');
      expect(result.riskLevel).toBe('HIGH');
    });
  });

  describe('inputText 보존', () => {
    it('원본 텍스트가 결과에 포함', () => {
      const text = '검으로 적을 공격한다';
      const result = parser.parse(text);
      expect(result.inputText).toBe(text);
    });
  });
});
