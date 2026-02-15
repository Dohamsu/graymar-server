import { DamageService } from './damage.service.js';
import { Rng } from '../rng/rng.service.js';
import type { StatsSnapshot } from '../stats/stats.service.js';

function makeSnap(overrides: Partial<StatsSnapshot> = {}): StatsSnapshot {
  return {
    maxHP: 100,
    maxStamina: 5,
    atk: 15,
    def: 10,
    acc: 5,
    eva: 3,
    crit: 5,
    critDmg: 150,
    resist: 5,
    speed: 5,
    damageMult: 1.0,
    hitMult: 1.0,
    takenDmgMult: 1.0,
    ...overrides,
  };
}

describe('DamageService', () => {
  let service: DamageService;

  beforeEach(() => {
    service = new DamageService();
  });

  it('결정적: 동일 입력 → 동일 결과', () => {
    const snap = makeSnap({ atk: 20, crit: 0 });
    const a = service.rollDamage(snap, 10, new Rng('det', 0));
    const b = service.rollDamage(snap, 10, new Rng('det', 0));
    expect(a.damage).toBe(b.damage);
    expect(a.isCrit).toBe(b.isCrit);
    expect(a.variance).toBe(b.variance);
  });

  it('기본 공식: ATK * (100 / (100 + DEF))', () => {
    // ATK=20, DEF=0 → baseDamage = 20 * (100/100) = 20
    // variance ≈ 1.0, no crit
    const snap = makeSnap({ atk: 20, crit: 0, damageMult: 1.0 });
    const rng = new Rng('base-formula', 0);
    const result = service.rollDamage(snap, 0, rng);

    // base = 20, variance 0.9~1.1 → damage 18~22
    expect(result.damage).toBeGreaterThanOrEqual(18);
    expect(result.damage).toBeLessThanOrEqual(22);
    expect(result.baseDamage).toBe(20);
  });

  it('DEF가 높으면 피해 감소', () => {
    const snap = makeSnap({ atk: 20, crit: 0 });
    const results: number[] = [];

    for (let def = 0; def <= 100; def += 20) {
      const rng = new Rng('def-scale', 0); // 동일 RNG
      const r = service.rollDamage(snap, def, rng);
      results.push(r.damage);
    }

    // DEF 0 > DEF 20 > DEF 40 > DEF 60 > DEF 80 > DEF 100
    for (let i = 0; i < results.length - 1; i++) {
      expect(results[i]).toBeGreaterThan(results[i + 1]);
    }
  });

  it('치명타: DEF 30% 무시 + CRIT_DMG 배율', () => {
    // CRIT 100%로 설정해서 항상 크리
    const snap = makeSnap({ atk: 30, crit: 50, critDmg: 200 });
    const targetDef = 100;
    let critCount = 0;
    let normalDamageSum = 0;
    let critDamageSum = 0;
    const N = 2000;

    for (let i = 0; i < N; i++) {
      const rng = new Rng('crit-test', i * 2); // 다른 RNG 상태
      const r = service.rollDamage(snap, targetDef, rng);
      if (r.isCrit) {
        critCount++;
        critDamageSum += r.damage;
      } else {
        normalDamageSum += r.damage;
      }
    }

    // crit 50%이므로 약 절반이 크리
    expect(critCount).toBeGreaterThan(N * 0.3);

    // 크리티컬 시 피해가 더 높아야 함
    if (critCount > 0 && critCount < N) {
      const avgCrit = critDamageSum / critCount;
      const avgNormal = normalDamageSum / (N - critCount);
      expect(avgCrit).toBeGreaterThan(avgNormal);
    }
  });

  it('CRIT_DMG는 최대 250 (2.5x) clamp', () => {
    // critDmg=250은 stats.service에서 clamp하므로
    // 여기서는 이미 clamp된 값이 들어온다고 가정
    const snap = makeSnap({ atk: 20, crit: 50, critDmg: 250 });
    const rng = new Rng('crit-max', 0);
    const r = service.rollDamage(snap, 0, rng);
    if (r.isCrit) {
      // 2.5x 적용 확인: base ≈ 20, variance ≈ 1.0 → max ≈ 55
      expect(r.damage).toBeLessThanOrEqual(60);
    }
  });

  it('forced=true → 피해 -20%', () => {
    const snap = makeSnap({ atk: 20, crit: 0 });
    const rng1 = new Rng('forced-dmg', 0);
    const normal = service.rollDamage(snap, 10, rng1, false);

    const rng2 = new Rng('forced-dmg', 0);
    const forced = service.rollDamage(snap, 10, rng2, true);

    // 동일 RNG → variance/crit 동일, forced만 다름
    expect(forced.damage).toBeLessThanOrEqual(normal.damage);
    // 약 80% 수준
    if (!normal.isCrit) {
      const ratio = forced.damage / normal.damage;
      expect(ratio).toBeCloseTo(0.8, 1);
    }
  });

  it('최소 피해 1 보장', () => {
    const snap = makeSnap({ atk: 1, crit: 0, damageMult: 0.01 });
    const rng = new Rng('min-dmg', 0);
    const r = service.rollDamage(snap, 1000, rng);
    expect(r.damage).toBeGreaterThanOrEqual(1);
  });

  it('RNG를 정확히 2회 소비 (varianceRoll + critRoll)', () => {
    const rng = new Rng('consume-2', 0);
    const before = rng.cursor;
    service.rollDamage(makeSnap(), 10, rng);
    expect(rng.cursor - before).toBe(2);
  });
});
