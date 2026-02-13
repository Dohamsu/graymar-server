import { Rng, RngService } from './rng.service.js';

describe('RngService', () => {
  let service: RngService;

  beforeEach(() => {
    service = new RngService();
  });

  it('should create an Rng instance', () => {
    const rng = service.create('test-seed', 0);
    expect(rng).toBeInstanceOf(Rng);
  });
});

describe('Rng — 결정성', () => {
  it('동일 seed + cursor → 동일 시퀀스', () => {
    const a = new Rng('seed-abc', 0);
    const b = new Rng('seed-abc', 0);

    for (let i = 0; i < 100; i++) {
      expect(a.next()).toBe(b.next());
    }
  });

  it('다른 seed → 다른 시퀀스', () => {
    const a = new Rng('seed-1', 0);
    const b = new Rng('seed-2', 0);

    // 최소 하나는 달라야 한다
    const results = Array.from({ length: 10 }, () => a.next() === b.next());
    expect(results.some((same) => !same)).toBe(true);
  });

  it('cursor 복원 — 중간부터 시작해도 동일 결과', () => {
    const full = new Rng('seed-xyz', 0);
    // 50번 소비
    for (let i = 0; i < 50; i++) full.next();
    const afterFifty = full.next();

    // cursor=50에서 시작
    const resumed = new Rng('seed-xyz', 50);
    expect(resumed.next()).toBe(afterFifty);
  });

  it('cursor 추적이 정확하다', () => {
    const rng = new Rng('track', 10);
    expect(rng.cursor).toBe(10);
    rng.next();
    expect(rng.cursor).toBe(11);
    rng.d20();
    expect(rng.cursor).toBe(12);
    rng.range(1, 100);
    expect(rng.cursor).toBe(13);
  });

  it('consumed는 현재 세션에서 소비한 횟수만', () => {
    const rng = new Rng('consumed', 100);
    expect(rng.consumed).toBe(0);
    rng.next();
    rng.next();
    expect(rng.consumed).toBe(2);
    expect(rng.cursor).toBe(102);
  });
});

describe('Rng — d20', () => {
  it('1~20 범위 안에 있다', () => {
    const rng = new Rng('d20-test', 0);
    for (let i = 0; i < 1000; i++) {
      const val = rng.d20();
      expect(val).toBeGreaterThanOrEqual(1);
      expect(val).toBeLessThanOrEqual(20);
    }
  });

  it('분포가 균등에 가깝다 (1000회)', () => {
    const rng = new Rng('d20-dist', 0);
    const counts = new Array(20).fill(0);
    const N = 10000;
    for (let i = 0; i < N; i++) {
      counts[rng.d20() - 1]++;
    }
    // 각 값이 최소 N/20 * 0.5 이상
    const minExpected = (N / 20) * 0.5;
    for (let i = 0; i < 20; i++) {
      expect(counts[i]).toBeGreaterThan(minExpected);
    }
  });
});

describe('Rng — range', () => {
  it('min~max 범위 안에 있다', () => {
    const rng = new Rng('range-test', 0);
    for (let i = 0; i < 500; i++) {
      const val = rng.range(5, 15);
      expect(val).toBeGreaterThanOrEqual(5);
      expect(val).toBeLessThanOrEqual(15);
    }
  });
});

describe('Rng — chance', () => {
  it('0% chance → 항상 false', () => {
    const rng = new Rng('chance-0', 0);
    for (let i = 0; i < 100; i++) {
      expect(rng.chance(0)).toBe(false);
    }
  });

  it('100% chance → 항상 true', () => {
    const rng = new Rng('chance-100', 0);
    for (let i = 0; i < 100; i++) {
      expect(rng.chance(100)).toBe(true);
    }
  });
});
