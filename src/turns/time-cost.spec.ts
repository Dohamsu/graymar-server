import { computeTurnTimeCost, MOVE_TIME_COST } from './time-cost.js';

describe('computeTurnTimeCost (arch/81 2차 — 대화는 시간 정지)', () => {
  it('사교 발화(dialogueAct)는 actionType 무관 0', () => {
    expect(computeTurnTimeCost('INVESTIGATE', 'GREETING')).toBe(0);
    expect(computeTurnTimeCost('TALK', 'FAREWELL')).toBe(0);
  });

  it('대화 계열 행동은 0 — 대화로는 해가 지지 않는다', () => {
    for (const a of [
      'TALK',
      'PERSUADE',
      'BRIBE',
      'THREATEN',
      'HELP',
      'TRADE',
      'OBSERVE',
    ]) {
      expect(computeTurnTimeCost(a, null)).toBe(0);
    }
  });

  it('시간이 걸리는 행동은 1', () => {
    for (const a of [
      'INVESTIGATE',
      'SEARCH',
      'SNEAK',
      'STEAL',
      'FIGHT',
      'SHOP',
    ]) {
      expect(computeTurnTimeCost(a, null)).toBe(1);
    }
  });

  it('휴식은 2, MOVE_LOCATION 방어값은 이동 비용과 동일', () => {
    expect(computeTurnTimeCost('REST', null)).toBe(2);
    expect(computeTurnTimeCost('MOVE_LOCATION', null)).toBe(MOVE_TIME_COST);
  });
});
