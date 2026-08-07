// [A-1] nano 선택지 riskLevel 서버 검증 스펙 (버그 9fc337c9 후속)
// nano 제안을 1~3으로 clamp하고, 실패·이상치는 판돈 없음(1)으로 떨어뜨린다.
import { clampRiskLevel } from './nano-event-director.service';

describe('clampRiskLevel', () => {
  it('유효 범위 1~3은 그대로 통과', () => {
    expect(clampRiskLevel(1)).toBe(1);
    expect(clampRiskLevel(2)).toBe(2);
    expect(clampRiskLevel(3)).toBe(3);
  });

  it('범위 밖은 경계로 clamp', () => {
    expect(clampRiskLevel(0)).toBe(1);
    expect(clampRiskLevel(-5)).toBe(1);
    expect(clampRiskLevel(4)).toBe(3);
    expect(clampRiskLevel(99)).toBe(3);
  });

  it('소수는 반올림', () => {
    expect(clampRiskLevel(1.4)).toBe(1);
    expect(clampRiskLevel(2.5)).toBe(3);
    expect(clampRiskLevel(1.6)).toBe(2);
  });

  // nano 실패가 판정 인플레로 번지면 안 된다 — 기본값은 무판정 쪽.
  it('결측·비수치는 1(판돈 없음)', () => {
    for (const raw of [undefined, null, '2', NaN, Infinity, {}, []]) {
      expect(clampRiskLevel(raw)).toBe(1);
    }
  });
});
