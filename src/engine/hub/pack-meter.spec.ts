// [P2 — architecture/73 B1] 팩 미터 로직 테스트.

import { initPackMeters, tickPackMeters } from './pack-meter.js';
import type { PackMeterDef } from '../../db/types/pack-meter.js';

const DEFS: PackMeterDef[] = [
  {
    id: 'DREAM_TAINT',
    name: '꿈 오염',
    initial: 10,
    perTurnDelta: 2,
    maxDeltaPerTurn: 8,
    thresholds: [
      { at: 50, signal: '꿈이 번진다' },
      { at: 100, signal: '완전 각성', endingTrigger: 'BAD_DREAM' },
    ],
  },
];

describe('[P2] initPackMeters', () => {
  it('선언된 미터를 초기값으로 시드', () => {
    expect(initPackMeters(DEFS)).toEqual({ DREAM_TAINT: 10 });
  });
  it('미선언(undefined) → 빈 객체 (기존 팩 무변경)', () => {
    expect(initPackMeters(undefined)).toEqual({});
  });
  it('초기값 clamp (음수/초과)', () => {
    expect(initPackMeters([{ id: 'X', name: 'x', initial: 150 }])).toEqual({
      X: 100,
    });
  });
});

describe('[P2] tickPackMeters', () => {
  it('perTurnDelta 적용', () => {
    const { next } = tickPackMeters({ DREAM_TAINT: 10 }, DEFS);
    expect(next.DREAM_TAINT).toBe(12);
  });
  it('maxDeltaPerTurn clamp (timeCost 큰 경우)', () => {
    const { next } = tickPackMeters({ DREAM_TAINT: 10 }, DEFS, 10); // 2*10=20 → cap 8
    expect(next.DREAM_TAINT).toBe(18);
  });
  it('0~100 clamp', () => {
    const { next } = tickPackMeters({ DREAM_TAINT: 99 }, DEFS);
    expect(next.DREAM_TAINT).toBe(100);
  });
  it('상승 교차 시 crossed 수집', () => {
    const { crossed } = tickPackMeters({ DREAM_TAINT: 49 }, DEFS);
    expect(crossed).toHaveLength(1);
    expect(crossed[0].threshold.at).toBe(50);
    expect(crossed[0].value).toBe(51);
  });
  it('이미 임계 넘은 상태에서는 재교차 없음', () => {
    const { crossed } = tickPackMeters({ DREAM_TAINT: 60 }, DEFS);
    expect(crossed).toHaveLength(0);
  });
  it('미선언 → no-op (원본 유지)', () => {
    const { next, crossed } = tickPackMeters({ A: 5 }, undefined);
    expect(next).toEqual({ A: 5 });
    expect(crossed).toHaveLength(0);
  });
  it('원본 불변 (새 맵 반환)', () => {
    const cur = { DREAM_TAINT: 10 };
    tickPackMeters(cur, DEFS);
    expect(cur.DREAM_TAINT).toBe(10);
  });
});
