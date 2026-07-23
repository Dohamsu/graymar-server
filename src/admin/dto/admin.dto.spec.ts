import {
  AbortRunBodySchema,
  AdminRunsQuerySchema,
  AdminUsersQuerySchema,
  PointsAdjustBodySchema,
} from './admin.dto.js';

/** 어드민 DTO 검증 유닛 — arch/87 §4.1 (points-adjust 0/비정수 거부가 핵심) */
describe('PointsAdjustBodySchema', () => {
  it('± 정수 + reason 은 통과', () => {
    expect(
      PointsAdjustBodySchema.parse({ amount: 50, reason: '보상 지급' }),
    ).toEqual({ amount: 50, reason: '보상 지급' });
    expect(
      PointsAdjustBodySchema.parse({ amount: -10, reason: '오지급 회수' }),
    ).toEqual({ amount: -10, reason: '오지급 회수' });
  });
  it('amount 0 은 거부', () => {
    expect(
      PointsAdjustBodySchema.safeParse({ amount: 0, reason: 'x' }).success,
    ).toBe(false);
  });
  it('비정수·문자열 amount 는 거부', () => {
    expect(
      PointsAdjustBodySchema.safeParse({ amount: 1.5, reason: 'x' }).success,
    ).toBe(false);
    expect(
      PointsAdjustBodySchema.safeParse({ amount: '10', reason: 'x' }).success,
    ).toBe(false);
  });
  it('reason 누락·빈 문자열은 거부', () => {
    expect(PointsAdjustBodySchema.safeParse({ amount: 10 }).success).toBe(
      false,
    );
    expect(
      PointsAdjustBodySchema.safeParse({ amount: 10, reason: '' }).success,
    ).toBe(false);
  });
});

describe('AbortRunBodySchema', () => {
  it('reason 필수', () => {
    expect(AbortRunBodySchema.safeParse({}).success).toBe(false);
    expect(AbortRunBodySchema.safeParse({ reason: '' }).success).toBe(false);
    expect(AbortRunBodySchema.safeParse({ reason: '스턱 정리' }).success).toBe(
      true,
    );
  });
});

describe('AdminUsersQuerySchema', () => {
  it('page/limit 문자열 coerce + 기본값', () => {
    expect(AdminUsersQuerySchema.parse({})).toEqual({ page: 1, limit: 20 });
    expect(
      AdminUsersQuerySchema.parse({ q: 'foo', page: '2', limit: '50' }),
    ).toEqual({ q: 'foo', page: 2, limit: 50 });
  });
  it('limit 100 초과는 거부', () => {
    expect(AdminUsersQuerySchema.safeParse({ limit: '200' }).success).toBe(
      false,
    );
  });
});

describe('AdminRunsQuerySchema', () => {
  it('status 는 RUN_STATUS enum 만 허용', () => {
    expect(AdminRunsQuerySchema.parse({ status: 'RUN_ACTIVE' }).status).toBe(
      'RUN_ACTIVE',
    );
    expect(AdminRunsQuerySchema.safeParse({ status: 'WHATEVER' }).success).toBe(
      false,
    );
  });
});
