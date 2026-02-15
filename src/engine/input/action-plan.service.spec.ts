import { ActionPlanService } from './action-plan.service.js';
import type { ParsedIntent } from '../../db/types/index.js';

function makeIntent(overrides: Partial<ParsedIntent> = {}): ParsedIntent {
  return {
    inputText: 'test',
    intents: ['ATTACK_MELEE'],
    targets: ['enemy_01'],
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

describe('ActionPlanService', () => {
  let service: ActionPlanService;

  beforeEach(() => {
    service = new ActionPlanService();
  });

  describe('기본 슬롯', () => {
    it('1개 combat intent → 1개 unit, 스태미나 1', () => {
      const plan = service.buildPlan(
        makeIntent({ intents: ['ATTACK_MELEE'] }),
        'ALLOW',
        5,
      );
      expect(plan.units).toHaveLength(1);
      expect(plan.units[0].type).toBe('ATTACK_MELEE');
      expect(plan.staminaCost).toBe(1);
      expect(plan.consumedSlots.used).toBe(1);
      expect(plan.consumedSlots.bonusUsed).toBe(false);
    });

    it('2개 combat intent → 2개 unit, 스태미나 2', () => {
      const plan = service.buildPlan(
        makeIntent({ intents: ['ATTACK_MELEE', 'DEFEND'] }),
        'ALLOW',
        5,
      );
      expect(plan.units).toHaveLength(2);
      expect(plan.staminaCost).toBe(2);
      expect(plan.consumedSlots.used).toBe(2);
    });

    it('3개 combat intent (보너스 없음) → 2개로 제한', () => {
      const plan = service.buildPlan(
        makeIntent({ intents: ['ATTACK_MELEE', 'DEFEND', 'EVADE'] }),
        'ALLOW',
        5,
        false,
      );
      expect(plan.units).toHaveLength(2);
      expect(plan.staminaCost).toBe(2);
    });
  });

  describe('보너스 슬롯', () => {
    it('bonusAvailable=true + 3개 intent + 충분한 스태미나 → 3개 unit', () => {
      const plan = service.buildPlan(
        makeIntent({ intents: ['ATTACK_MELEE', 'DEFEND', 'EVADE'] }),
        'ALLOW',
        5,
        true,
      );
      expect(plan.units).toHaveLength(3);
      expect(plan.staminaCost).toBe(4); // 1 + 1 + 2 (bonus)
      expect(plan.consumedSlots.bonusUsed).toBe(true);
    });

    it('bonusAvailable=true + 스태미나 부족 → 2개로 제한', () => {
      const plan = service.buildPlan(
        makeIntent({ intents: ['ATTACK_MELEE', 'DEFEND', 'EVADE'] }),
        'ALLOW',
        3,
        true, // 스태미나 3, 비용 1+1+2=4 → 부족
      );
      expect(plan.units).toHaveLength(2);
      expect(plan.staminaCost).toBe(2);
      expect(plan.consumedSlots.bonusUsed).toBe(false);
    });
  });

  describe('비전투 intent', () => {
    it('TALK만 → INTERACT로 매핑, 스태미나 0', () => {
      const plan = service.buildPlan(
        makeIntent({ intents: ['TALK'] }),
        'ALLOW',
        5,
      );
      expect(plan.units).toHaveLength(1);
      expect(plan.units[0].type).toBe('INTERACT');
      expect(plan.units[0].meta?.originalIntent).toBe('TALK');
      expect(plan.staminaCost).toBe(0);
    });

    it('OBSERVE → INTERACT 매핑', () => {
      const plan = service.buildPlan(
        makeIntent({ intents: ['OBSERVE'] }),
        'ALLOW',
        5,
      );
      expect(plan.units).toHaveLength(1);
      expect(plan.units[0].type).toBe('INTERACT');
    });
  });

  describe('타겟/방향 전달', () => {
    it('target이 unit에 전달됨', () => {
      const plan = service.buildPlan(
        makeIntent({ intents: ['ATTACK_MELEE'], targets: ['enemy_02'] }),
        'ALLOW',
        5,
      );
      expect(plan.units[0].targetId).toBe('enemy_02');
    });

    it('direction이 unit에 전달됨', () => {
      const plan = service.buildPlan(
        makeIntent({ intents: ['MOVE'], direction: 'LEFT' }),
        'ALLOW',
        5,
      );
      expect(plan.units[0].direction).toBe('LEFT');
    });
  });

  describe('policyResult/parsedBy 전달', () => {
    it('plan에 policyResult 포함', () => {
      const plan = service.buildPlan(makeIntent(), 'TRANSFORM', 5);
      expect(plan.policyResult).toBe('TRANSFORM');
    });

    it('plan에 parsedBy 포함', () => {
      const plan = service.buildPlan(makeIntent({ source: 'LLM' }), 'ALLOW', 5);
      expect(plan.parsedBy).toBe('LLM');
    });
  });
});
