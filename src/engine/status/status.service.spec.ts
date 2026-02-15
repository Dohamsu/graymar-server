import { StatusService } from './status.service.js';
import { Rng } from '../rng/rng.service.js';
import type { StatusInstance } from '../../db/types/index.js';

describe('StatusService', () => {
  let service: StatusService;

  beforeEach(() => {
    service = new StatusService();
  });

  describe('getDefinition', () => {
    it('v1 기본 5종 + STUN_IMMUNE 존재', () => {
      expect(service.getDefinition('BLEED')).toBeDefined();
      expect(service.getDefinition('POISON')).toBeDefined();
      expect(service.getDefinition('STUN')).toBeDefined();
      expect(service.getDefinition('WEAKEN')).toBeDefined();
      expect(service.getDefinition('FORTIFY')).toBeDefined();
      expect(service.getDefinition('STUN_IMMUNE')).toBeDefined();
    });

    it('없는 상태는 undefined', () => {
      expect(service.getDefinition('NONEXISTENT')).toBeUndefined();
    });
  });

  describe('tryApplyStatus — 적용 판정', () => {
    it('높은 ACC vs 낮은 RESIST → 거의 항상 성공', () => {
      let applied = 0;
      for (let i = 0; i < 100; i++) {
        const rng = new Rng('apply-high', i);
        const result = service.tryApplyStatus(
          'BLEED',
          'player',
          'PLAYER',
          [],
          20,
          0,
          rng,
        );
        if (result.applied) applied++;
      }
      // d20 + 20 >= 10 + 0 → 항상 성공 (auto fail 제외)
      expect(applied).toBeGreaterThan(90);
    });

    it('낮은 ACC vs 높은 RESIST → 거의 항상 실패', () => {
      let applied = 0;
      for (let i = 0; i < 100; i++) {
        const rng = new Rng('apply-low', i);
        const result = service.tryApplyStatus(
          'BLEED',
          'player',
          'PLAYER',
          [],
          0,
          30,
          rng,
        );
        if (result.applied) applied++;
      }
      // d20 + 0 >= 10 + 30 = 40 → 거의 불가능
      expect(applied).toBeLessThan(10);
    });

    it('성공 시 StatusInstance가 추가된다', () => {
      // 확실한 성공을 위해 높은 ACC
      const rng = new Rng('apply-add', 0);
      const result = service.tryApplyStatus(
        'BLEED',
        'player',
        'PLAYER',
        [],
        100,
        0,
        rng,
      );
      if (result.applied) {
        expect(result.statuses).toHaveLength(1);
        expect(result.statuses[0].id).toBe('BLEED');
        expect(result.statuses[0].stacks).toBe(1);
        expect(result.statuses[0].duration).toBe(3);
        expect(result.event).toBeDefined();
        expect(result.delta?.op).toBe('APPLIED');
      }
    });

    it('stackable=true → stacks 증가, duration 갱신', () => {
      const existing: StatusInstance[] = [
        {
          id: 'BLEED',
          sourceId: 'PLAYER',
          applierId: 'player',
          duration: 1,
          stacks: 2,
          power: 1,
        },
      ];
      const rng = new Rng('stack', 0);
      const result = service.tryApplyStatus(
        'BLEED',
        'player',
        'PLAYER',
        existing,
        100,
        0,
        rng,
      );
      if (result.applied) {
        const bleed = result.statuses.find((s) => s.id === 'BLEED');
        expect(bleed?.stacks).toBe(3); // 2 + 1
        expect(bleed?.duration).toBe(3); // max(1, 3) = 3
      }
    });

    it('stackable maxStacks 제한', () => {
      const existing: StatusInstance[] = [
        {
          id: 'BLEED',
          sourceId: 'PLAYER',
          applierId: 'player',
          duration: 3,
          stacks: 5,
          power: 1,
        },
      ];
      const rng = new Rng('max-stack', 0);
      const result = service.tryApplyStatus(
        'BLEED',
        'player',
        'PLAYER',
        existing,
        100,
        0,
        rng,
      );
      if (result.applied) {
        const bleed = result.statuses.find((s) => s.id === 'BLEED');
        expect(bleed?.stacks).toBe(5); // capped at 5
      }
    });
  });

  describe('tryApplyStatus — STUN 면역', () => {
    it('STUN_IMMUNE 있으면 STUN 적용 실패', () => {
      const existing: StatusInstance[] = [
        {
          id: 'STUN_IMMUNE',
          sourceId: 'PLAYER',
          applierId: 'system',
          duration: 2,
          stacks: 1,
          power: 1,
        },
      ];
      const rng = new Rng('stun-immune', 0);
      const result = service.tryApplyStatus(
        'STUN',
        'player',
        'PLAYER',
        existing,
        100,
        0,
        rng,
      );
      expect(result.applied).toBe(false);
    });

    it('STUN_IMMUNE 없으면 STUN 적용 가능', () => {
      let applied = 0;
      for (let i = 0; i < 50; i++) {
        const rng = new Rng('stun-ok', i);
        const result = service.tryApplyStatus(
          'STUN',
          'player',
          'PLAYER',
          [],
          100,
          0,
          rng,
        );
        if (result.applied) applied++;
      }
      expect(applied).toBeGreaterThan(40);
    });
  });

  describe('tickStatuses — DOT 처리', () => {
    it('BLEED tick → 결정적 DOT 피해', () => {
      const statuses: StatusInstance[] = [
        {
          id: 'BLEED',
          sourceId: 'PLAYER',
          applierId: 'player',
          duration: 3,
          stacks: 2,
          power: 1,
        },
      ];
      const result = service.tickStatuses(statuses, 100, 1.0);

      // rawDot = floor(100 * 0.03 * 2 * 1) = floor(6) = 6
      expect(result.totalDotDamage).toBe(6);
      expect(result.events.length).toBeGreaterThan(0);

      // duration 감소
      const remaining = result.statuses.find((s) => s.id === 'BLEED');
      expect(remaining?.duration).toBe(2); // 3 - 1
    });

    it('POISON tick → DOT + TAKEN_DMG_MULT 반영', () => {
      const statuses: StatusInstance[] = [
        {
          id: 'POISON',
          sourceId: 'PLAYER',
          applierId: 'player',
          duration: 2,
          stacks: 1,
          power: 1,
        },
      ];

      // TAKEN_DMG_MULT = 1.5
      const result = service.tickStatuses(statuses, 100, 1.5);
      // rawDot = floor(100 * 0.02 * 1 * 1) = 2
      // dot = floor(2 * 1.5) = 3
      expect(result.totalDotDamage).toBe(3);
    });

    it('DOT 최소 피해 1 보장', () => {
      const statuses: StatusInstance[] = [
        {
          id: 'BLEED',
          sourceId: 'PLAYER',
          applierId: 'player',
          duration: 2,
          stacks: 1,
          power: 1,
        },
      ];
      // maxHP 1 → rawDot = floor(1 * 0.03 * 1 * 1) = 0 → min 1
      const result = service.tickStatuses(statuses, 1, 1.0);
      expect(result.totalDotDamage).toBe(1);
    });

    it('duration 0이면 제거 + REMOVED 이벤트', () => {
      const statuses: StatusInstance[] = [
        {
          id: 'WEAKEN',
          sourceId: 'PLAYER',
          applierId: 'player',
          duration: 1,
          stacks: 1,
          power: 1,
        },
      ];
      const result = service.tickStatuses(statuses, 100, 1.0);

      expect(result.statuses.find((s) => s.id === 'WEAKEN')).toBeUndefined();
      const removeEvent = result.events.find((e) => e.tags.includes('REMOVED'));
      expect(removeEvent).toBeDefined();
    });

    it('STUN 제거 시 STUN_IMMUNE 2턴 부여', () => {
      const statuses: StatusInstance[] = [
        {
          id: 'STUN',
          sourceId: 'PLAYER',
          applierId: 'enemy',
          duration: 1,
          stacks: 1,
          power: 1,
        },
      ];
      const result = service.tickStatuses(statuses, 100, 1.0);

      expect(result.statuses.find((s) => s.id === 'STUN')).toBeUndefined();
      const immune = result.statuses.find((s) => s.id === 'STUN_IMMUNE');
      expect(immune).toBeDefined();
      expect(immune?.duration).toBe(2);
    });

    it('tick은 RNG를 사용하지 않는다 (결정적)', () => {
      const statuses: StatusInstance[] = [
        {
          id: 'BLEED',
          sourceId: 'PLAYER',
          applierId: 'p',
          duration: 3,
          stacks: 2,
          power: 1,
        },
        {
          id: 'POISON',
          sourceId: 'PLAYER',
          applierId: 'p',
          duration: 2,
          stacks: 1,
          power: 1,
        },
      ];
      const r1 = service.tickStatuses(statuses, 100, 1.0);
      const r2 = service.tickStatuses(statuses, 100, 1.0);
      expect(r1.totalDotDamage).toBe(r2.totalDotDamage);
    });
  });

  describe('getModifiers', () => {
    it('WEAKEN → ATK -15% modifier', () => {
      const statuses: StatusInstance[] = [
        {
          id: 'WEAKEN',
          sourceId: 'PLAYER',
          applierId: 'e',
          duration: 2,
          stacks: 1,
          power: 1,
        },
      ];
      const mods = service.getModifiers(statuses);
      expect(mods.length).toBe(1);
      expect(mods[0].stat).toBe('atk');
      expect(mods[0].value).toBe(-0.15);
      expect(mods[0].priority).toBe(400);
    });

    it('FORTIFY → DEF +20%, TAKEN_DMG_MULT -10%', () => {
      const statuses: StatusInstance[] = [
        {
          id: 'FORTIFY',
          sourceId: 'PLAYER',
          applierId: 'p',
          duration: 2,
          stacks: 1,
          power: 1,
        },
      ];
      const mods = service.getModifiers(statuses);
      expect(mods.length).toBe(2);
      expect(mods.find((m) => m.stat === 'def')?.value).toBe(0.2);
      expect(mods.find((m) => m.stat === 'takenDmgMult')?.value).toBe(-0.1);
    });

    it('빈 배열 → modifier 없음', () => {
      const mods = service.getModifiers([]);
      expect(mods).toHaveLength(0);
    });
  });

  describe('isStunned', () => {
    it('STUN 있으면 true', () => {
      const statuses: StatusInstance[] = [
        {
          id: 'STUN',
          sourceId: 'PLAYER',
          applierId: 'e',
          duration: 1,
          stacks: 1,
          power: 1,
        },
      ];
      expect(service.isStunned(statuses)).toBe(true);
    });

    it('STUN 없으면 false', () => {
      const statuses: StatusInstance[] = [
        {
          id: 'BLEED',
          sourceId: 'PLAYER',
          applierId: 'e',
          duration: 3,
          stacks: 1,
          power: 1,
        },
      ];
      expect(service.isStunned(statuses)).toBe(false);
    });
  });
});
