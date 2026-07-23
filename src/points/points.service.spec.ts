import {
  generateRedeemCode,
  isUniqueViolation,
  parsePointEnv,
} from './points.service.js';

/**
 * PointsService 순수 헬퍼 유닛. DB 경로(charge/redeem/refund/insufficient/bonus)는
 * 라이브 E2E 로 검증됨 — arch/85 §8 (drizzle DSL 은 mock 부적합).
 */
describe('generateRedeemCode', () => {
  it('XXXX-XXXX 포맷 + 혼동 문자(0/O/1/I) 미포함', () => {
    for (let i = 0; i < 200; i++) {
      const code = generateRedeemCode();
      expect(code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
      expect(code).not.toMatch(/[O0I1]/);
    }
  });

  it('충돌 가능성 낮음 (200회 대부분 유일)', () => {
    const set = new Set(
      Array.from({ length: 200 }, () => generateRedeemCode()),
    );
    expect(set.size).toBeGreaterThan(195);
  });
});

describe('parsePointEnv', () => {
  it('유효 수치는 그대로', () => {
    expect(parsePointEnv('5', 99)).toBe(5);
    expect(parsePointEnv('0', 99)).toBe(0);
  });
  it('음수·비수치·undefined 는 fallback', () => {
    expect(parsePointEnv('-3', 99)).toBe(99);
    expect(parsePointEnv('abc', 99)).toBe(99);
    expect(parsePointEnv(undefined, 99)).toBe(99);
    expect(parsePointEnv('', 99)).toBe(99);
  });
});

describe('isUniqueViolation', () => {
  it('23505 를 code / cause.code 양쪽에서 감지', () => {
    expect(isUniqueViolation({ code: '23505' })).toBe(true);
    expect(isUniqueViolation({ cause: { code: '23505' } })).toBe(true);
  });
  it('그 외는 false', () => {
    expect(isUniqueViolation({ code: '23503' })).toBe(false);
    expect(isUniqueViolation(new Error('x'))).toBe(false);
    expect(isUniqueViolation(null)).toBe(false);
  });
});
