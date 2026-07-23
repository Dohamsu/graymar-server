import {
  IDLE_HOURS,
  isIdleRun,
  isLlmStalled,
  LLM_STALL_MINUTES,
  minutesSince,
} from './admin-ops.service.js';
import { clampDays, clampLimit, failRate } from './admin-stats.service.js';

/**
 * 어드민 관제 순수 로직 유닛 — arch/87 §4.1.
 * DB 경로(집계·조정·abort·retry)는 기존 관례대로 라이브 검증 (drizzle DSL mock 부적합).
 */
const NOW = new Date('2026-07-23T12:00:00Z');
const minsAgo = (m: number) => new Date(NOW.getTime() - m * 60_000);

describe('minutesSince', () => {
  it('경과 분을 내림으로 계산', () => {
    expect(minutesSince(minsAgo(10), NOW)).toBe(10);
    expect(minutesSince(new Date(NOW.getTime() - 90_000), NOW)).toBe(1); // 1.5분 → 1
    expect(minutesSince(NOW, NOW)).toBe(0);
  });

  it('raw SQL 문자열 timestamp 도 coerce (실측 회귀 — at.getTime TypeError)', () => {
    expect(minutesSince('2026-07-23T11:50:00Z', NOW)).toBe(10);
    expect(
      minutesSince('2026-07-23 11:50:00', new Date('2026-07-23 12:00:00')),
    ).toBe(10);
  });
});

describe('isLlmStalled (LLM_STALLED 판정)', () => {
  it('PENDING/RUNNING + 10분 이상 정체면 true', () => {
    expect(isLlmStalled('PENDING', minsAgo(LLM_STALL_MINUTES), NOW)).toBe(true);
    expect(isLlmStalled('RUNNING', minsAgo(30), NOW)).toBe(true);
  });
  it('10분 미만이면 false', () => {
    expect(isLlmStalled('PENDING', minsAgo(LLM_STALL_MINUTES - 1), NOW)).toBe(
      false,
    );
    expect(isLlmStalled('RUNNING', minsAgo(0), NOW)).toBe(false);
  });
  it('DONE/FAILED/SKIPPED 은 시간과 무관하게 false', () => {
    expect(isLlmStalled('DONE', minsAgo(60), NOW)).toBe(false);
    expect(isLlmStalled('FAILED', minsAgo(60), NOW)).toBe(false);
    expect(isLlmStalled('SKIPPED', minsAgo(60), NOW)).toBe(false);
  });
});

describe('isIdleRun (IDLE_24H 판정)', () => {
  it('RUN_ACTIVE + 24시간 이상 무턴이면 true', () => {
    expect(isIdleRun('RUN_ACTIVE', minsAgo(IDLE_HOURS * 60), NOW)).toBe(true);
    expect(isIdleRun('RUN_ACTIVE', minsAgo(IDLE_HOURS * 60 + 1), NOW)).toBe(
      true,
    );
  });
  it('24시간 미만이면 false', () => {
    expect(isIdleRun('RUN_ACTIVE', minsAgo(IDLE_HOURS * 60 - 1), NOW)).toBe(
      false,
    );
  });
  it('종료된 런은 시간과 무관하게 false', () => {
    expect(isIdleRun('RUN_ENDED', minsAgo(IDLE_HOURS * 120), NOW)).toBe(false);
    expect(isIdleRun('RUN_ABORTED', minsAgo(IDLE_HOURS * 120), NOW)).toBe(
      false,
    );
  });
});

describe('clampDays', () => {
  it('기본 30, 최대 90 클램프', () => {
    expect(clampDays(undefined)).toBe(30);
    expect(clampDays(7)).toBe(7);
    expect(clampDays(90)).toBe(90);
    expect(clampDays(365)).toBe(90);
  });
  it('비정상 입력은 fallback', () => {
    expect(clampDays(0)).toBe(30);
    expect(clampDays(-5)).toBe(30);
    expect(clampDays(NaN)).toBe(30);
  });
});

describe('clampLimit', () => {
  it('기본 50, 최대 100 클램프', () => {
    expect(clampLimit(undefined)).toBe(50);
    expect(clampLimit(20)).toBe(20);
    expect(clampLimit(100)).toBe(100);
    expect(clampLimit(500)).toBe(100);
    expect(clampLimit(0)).toBe(50);
  });
});

describe('failRate', () => {
  it('failed/total, 분모 0 이면 0', () => {
    expect(failRate(0, 0)).toBe(0);
    expect(failRate(1, 4)).toBe(0.25);
    expect(failRate(0, 10)).toBe(0);
  });
});
