import { PolicyService } from './policy.service.js';
import type { ParsedIntent } from '../../db/types/index.js';

function makeIntent(overrides: Partial<ParsedIntent> = {}): ParsedIntent {
  return {
    inputText: 'test',
    intents: ['ATTACK_MELEE'],
    targets: [],
    constraints: [],
    riskLevel: 'LOW',
    illegalFlags: [],
    source: 'RULE',
    confidence: 0.9,
    primary: 'ATTACK_MELEE',
    modifiers: [],
    ...overrides,
  };
}

describe('PolicyService', () => {
  let service: PolicyService;

  beforeEach(() => {
    service = new PolicyService();
  });

  describe('ALLOW', () => {
    it('전투 노드 + 전투 행동 → ALLOW', () => {
      const result = service.check(
        makeIntent({ intents: ['ATTACK_MELEE'] }),
        'COMBAT',
        'NODE_ACTIVE',
        5,
      );
      expect(result.result).toBe('ALLOW');
    });

    it('비전투 노드 + 비전투 행동 → ALLOW', () => {
      const result = service.check(
        makeIntent({ intents: ['TALK'] }),
        'EVENT',
        'NODE_ACTIVE',
        5,
      );
      expect(result.result).toBe('ALLOW');
    });
  });

  describe('DENY', () => {
    it('NODE_ENDED → DENY', () => {
      const result = service.check(makeIntent(), 'COMBAT', 'NODE_ENDED', 5);
      expect(result.result).toBe('DENY');
      expect(result.reason).toBeDefined();
    });

    it('illegalFlags 있으면 → DENY', () => {
      const result = service.check(
        makeIntent({ illegalFlags: ['CHEAT'] }),
        'COMBAT',
        'NODE_ACTIVE',
        5,
      );
      expect(result.result).toBe('DENY');
      expect(result.reason).toContain('Illegal');
    });
  });

  describe('TRANSFORM', () => {
    it('비전투 노드 + 전투 행동 → TRANSFORM to OBSERVE', () => {
      const result = service.check(
        makeIntent({ intents: ['ATTACK_MELEE'] }),
        'EVENT',
        'NODE_ACTIVE',
        5,
      );
      expect(result.result).toBe('TRANSFORM');
      expect(result.transformedIntents?.intents).toEqual(['OBSERVE']);
      expect(result.transformedIntents?.confidence).toBe(1.0);
    });

    it('REST 노드 + FLEE → TRANSFORM', () => {
      const result = service.check(
        makeIntent({ intents: ['FLEE'] }),
        'REST',
        'NODE_ACTIVE',
        5,
      );
      expect(result.result).toBe('TRANSFORM');
    });
  });

  describe('PARTIAL', () => {
    it('3개 이상 intents → 2개로 축약', () => {
      const result = service.check(
        makeIntent({
          intents: ['ATTACK_MELEE', 'DEFEND', 'EVADE'],
          confidence: 0.9,
        }),
        'COMBAT',
        'NODE_ACTIVE',
        5,
      );
      expect(result.result).toBe('PARTIAL');
      expect(result.transformedIntents?.intents).toHaveLength(2);
      expect(result.transformedIntents?.confidence).toBeLessThanOrEqual(0.8);
    });
  });

  describe('우선순위: DENY > TRANSFORM > PARTIAL > ALLOW', () => {
    it('NODE_ENDED는 다른 조건보다 먼저 체크', () => {
      const result = service.check(
        makeIntent({ intents: ['ATTACK_MELEE'], illegalFlags: ['CHEAT'] }),
        'EVENT',
        'NODE_ENDED',
        5,
      );
      // NODE_ENDED가 최우선
      expect(result.result).toBe('DENY');
      expect(result.reason).toContain('ended');
    });
  });
});
