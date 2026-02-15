import { StatsService, type StatModifier } from './stats.service.js';
import { DEFAULT_PERMANENT_STATS } from '../../db/types/index.js';

describe('StatsService', () => {
  let service: StatsService;

  beforeEach(() => {
    service = new StatsService();
  });

  describe('buildSnapshot — 기본', () => {
    it('modifier 없으면 기본 스탯 그대로', () => {
      const snap = service.buildSnapshot(DEFAULT_PERMANENT_STATS, []);
      expect(snap.maxHP).toBe(100);
      expect(snap.atk).toBe(15);
      expect(snap.def).toBe(10);
      expect(snap.acc).toBe(5);
      expect(snap.eva).toBe(3);
      expect(snap.crit).toBe(5);
      expect(snap.critDmg).toBe(150);
      expect(snap.resist).toBe(5);
      expect(snap.speed).toBe(5);
      expect(snap.damageMult).toBe(1.0);
      expect(snap.hitMult).toBe(1.0);
      expect(snap.takenDmgMult).toBe(1.0);
    });
  });

  describe('buildSnapshot — FLAT modifier', () => {
    it('ATK +10 FLAT → 25', () => {
      const mods: StatModifier[] = [
        { stat: 'atk', op: 'FLAT', value: 10, priority: 200 },
      ];
      const snap = service.buildSnapshot(DEFAULT_PERMANENT_STATS, mods);
      expect(snap.atk).toBe(25);
    });

    it('복수 FLAT 합산', () => {
      const mods: StatModifier[] = [
        { stat: 'def', op: 'FLAT', value: 5, priority: 200 },
        { stat: 'def', op: 'FLAT', value: 3, priority: 300 },
      ];
      const snap = service.buildSnapshot(DEFAULT_PERMANENT_STATS, mods);
      expect(snap.def).toBe(18); // 10 + 5 + 3
    });
  });

  describe('buildSnapshot — PERCENT modifier', () => {
    it('ATK +20% → 18 (15 * 1.2 = 18)', () => {
      const mods: StatModifier[] = [
        { stat: 'atk', op: 'PERCENT', value: 0.2, priority: 300 },
      ];
      const snap = service.buildSnapshot(DEFAULT_PERMANENT_STATS, mods);
      expect(snap.atk).toBe(18);
    });

    it('DEF -15% → 9 (10 * 0.85 = 8.5 → 9)', () => {
      const mods: StatModifier[] = [
        { stat: 'def', op: 'PERCENT', value: -0.15, priority: 400 },
      ];
      const snap = service.buildSnapshot(DEFAULT_PERMANENT_STATS, mods);
      expect(snap.def).toBe(9);
    });
  });

  describe('buildSnapshot — Priority 순서', () => {
    it('priority 순으로 적용 (GEAR→BUFF→DEBUFF)', () => {
      // GEAR: ATK +10 flat @200
      // BUFF: ATK +20% @300 → (15+10)*1.2 = 30
      // DEBUFF: ATK -10% @400 → 30*0.9 = 27
      const mods: StatModifier[] = [
        { stat: 'atk', op: 'PERCENT', value: -0.1, priority: 400 },
        { stat: 'atk', op: 'FLAT', value: 10, priority: 200 },
        { stat: 'atk', op: 'PERCENT', value: 0.2, priority: 300 },
      ];
      const snap = service.buildSnapshot(DEFAULT_PERMANENT_STATS, mods);
      expect(snap.atk).toBe(27);
    });
  });

  describe('buildSnapshot — clamp', () => {
    it('CRIT는 0~50 범위 clamp', () => {
      const mods: StatModifier[] = [
        { stat: 'crit', op: 'FLAT', value: 100, priority: 200 },
      ];
      const snap = service.buildSnapshot(DEFAULT_PERMANENT_STATS, mods);
      expect(snap.crit).toBe(50);
    });

    it('CRIT_DMG는 100~250 범위 clamp', () => {
      const mods: StatModifier[] = [
        { stat: 'critDmg', op: 'FLAT', value: 200, priority: 200 },
      ];
      const snap = service.buildSnapshot(DEFAULT_PERMANENT_STATS, mods);
      expect(snap.critDmg).toBe(250); // 150 + 200 = 350 → clamped 250
    });

    it('음수 스탯은 0으로 clamp', () => {
      const mods: StatModifier[] = [
        { stat: 'atk', op: 'FLAT', value: -100, priority: 200 },
      ];
      const snap = service.buildSnapshot(DEFAULT_PERMANENT_STATS, mods);
      expect(snap.atk).toBe(0);
    });
  });

  describe('getPositionModifiers — 위치 보정', () => {
    it('FRONT → modifier 없음', () => {
      const mods = service.getPositionModifiers('FRONT');
      expect(mods).toHaveLength(0);
    });

    it('SIDE → DEF -10%', () => {
      const mods = service.getPositionModifiers('SIDE');
      expect(mods).toHaveLength(1);
      expect(mods[0].stat).toBe('def');
      expect(mods[0].value).toBe(-0.1);
    });

    it('BACK → DEF -20% + CRIT +10', () => {
      const mods = service.getPositionModifiers('BACK');
      expect(mods).toHaveLength(2);
      const defMod = mods.find((m) => m.stat === 'def');
      const critMod = mods.find((m) => m.stat === 'crit');
      expect(defMod?.value).toBe(-0.2);
      expect(critMod?.value).toBe(10);
    });

    it('BACK 보정 적용 → DEF 감소, CRIT 증가', () => {
      const posMods = service.getPositionModifiers('BACK');
      const snap = service.buildSnapshot(DEFAULT_PERMANENT_STATS, posMods);
      expect(snap.def).toBe(8); // 10 * 0.8 = 8
      expect(snap.crit).toBe(15); // 5 + 10 = 15
    });
  });
});
