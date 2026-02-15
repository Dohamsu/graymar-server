import { HitService } from './hit.service.js';
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

describe('HitService', () => {
  let hitService: HitService;

  beforeEach(() => {
    hitService = new HitService();
  });

  it('d20=1 → 자동 실패 (autoFail)', () => {
    // 특정 seed에서 d20=1이 나오는 cursor를 찾기
    let cursor = -1;
    for (let i = 0; i < 10000; i++) {
      const testRng = new Rng('hit-d20-1', i);
      if (testRng.d20() === 1) {
        cursor = i;
        break;
      }
    }
    expect(cursor).toBeGreaterThanOrEqual(0);

    const testRng = new Rng('hit-d20-1', cursor);
    const result = hitService.rollHit(makeSnap({ acc: 100 }), 0, testRng);
    expect(result.hit).toBe(false);
    expect(result.autoFail).toBe(true);
    expect(result.roll).toBe(1);
  });

  it('d20=20 → 자동 성공 (autoHit)', () => {
    let cursor = -1;
    for (let i = 0; i < 10000; i++) {
      const testRng = new Rng('hit-d20-20', i);
      if (testRng.d20() === 20) {
        cursor = i;
        break;
      }
    }
    expect(cursor).toBeGreaterThanOrEqual(0);

    const testRng = new Rng('hit-d20-20', cursor);
    const result = hitService.rollHit(makeSnap({ acc: 0 }), 100, testRng);
    expect(result.hit).toBe(true);
    expect(result.autoHit).toBe(true);
    expect(result.roll).toBe(20);
  });

  it('공식: roll + ACC * HIT_MULT >= 10 + targetEVA', () => {
    // 확률적으로 많이 돌려서 공식 검증
    const attacker = makeSnap({ acc: 10, hitMult: 1.0 });
    const targetEva = 5; // threshold = 15
    const rng = new Rng('formula-test', 0);

    let hits = 0;
    let misses = 0;
    const N = 5000;

    for (let i = 0; i < N; i++) {
      const r = hitService.rollHit(attacker, targetEva, rng);
      if (r.autoFail || r.autoHit) continue;
      // roll + 10 >= 15 → roll >= 5 → 16/20 chance
      if (r.hit) hits++;
      else misses++;
    }

    // 약 80% 명중 예상 (roll 5~20)
    const hitRate = hits / (hits + misses);
    expect(hitRate).toBeGreaterThan(0.65);
    expect(hitRate).toBeLessThan(0.95);
  });

  it('forced=true → ACC -5 패널티 적용', () => {
    const rng = new Rng('forced-hit', 0);
    const attacker = makeSnap({ acc: 5, hitMult: 1.0 });
    const targetEva = 5;

    // 강행 시 effectiveAcc = 5 - 5 = 0
    // threshold = 15, roll + 0 >= 15 → roll >= 15 → 6/20 = 30%
    let hits = 0;
    const N = 3000;
    for (let i = 0; i < N; i++) {
      const r = hitService.rollHit(attacker, targetEva, rng, true);
      if (r.hit) hits++;
    }
    const hitRate = hits / N;
    // forced면 명중률이 크게 낮아야 함 (약 30% + auto-hit 보정)
    expect(hitRate).toBeLessThan(0.5);
  });

  it('RNG를 정확히 1회 소비한다', () => {
    const rng = new Rng('consume-1', 0);
    const before = rng.cursor;
    hitService.rollHit(makeSnap(), 3, rng);
    expect(rng.cursor - before).toBe(1);
  });
});
