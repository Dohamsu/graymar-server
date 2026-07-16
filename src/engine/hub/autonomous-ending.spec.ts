import {
  computeClearanceRate,
  clearanceBand,
  checkAutonomousEnding,
  selectEndingTone,
  MIN_AUTONOMOUS_END_TURNS,
} from './autonomous-ending.js';
import type { PlotSeed, PlotProgress } from '../../db/types/plot-seed.js';

// [P5 — architecture/75 §6] AUTONOMOUS 종결·규명율 순수 로직 테스트.
function seed(keyFactCount = 9, actsBudget = [8, 12, 8]): PlotSeed {
  return {
    motifs: ['M1', 'M2'],
    truth: { what: 'x', culpritNpcId: 'NPC_A', why: 'y', whereLocationId: 'L1' },
    casting: {},
    keyFacts: Array.from({ length: keyFactCount }, (_, i) => ({
      factId: `FACT_${i}`,
      summary: `s${i}`,
      holders: ['NPC_A'],
    })),
    endingCandidates: [{ id: 'E1', premise: 'p' }],
    acts: actsBudget.map((b, i) => ({ no: i + 1, turnBudget: b, goal: 'g' })),
  };
}

describe('computeClearanceRate', () => {
  it('발견 4 / 전체 9 → 0.44', () => {
    const pp: PlotProgress = {
      discoveredKeyFactIds: ['FACT_0', 'FACT_1', 'FACT_2', 'FACT_3'],
    };
    expect(computeClearanceRate(seed(9), pp)).toBeCloseTo(4 / 9, 5);
  });
  it('진행 없음 → 0', () => {
    expect(computeClearanceRate(seed(9), undefined)).toBe(0);
  });
  it('시드에 없는 발견 id는 분자에서 제외', () => {
    const pp: PlotProgress = { discoveredKeyFactIds: ['FACT_0', 'GHOST'] };
    expect(computeClearanceRate(seed(9), pp)).toBeCloseTo(1 / 9, 5);
  });
});

describe('clearanceBand', () => {
  it('0.8 → HIGH', () => expect(clearanceBand(0.8)).toBe('HIGH'));
  it('0.7 경계 → HIGH', () => expect(clearanceBand(0.7)).toBe('HIGH'));
  it('0.5 → MID', () => expect(clearanceBand(0.5)).toBe('MID'));
  it('0.3 경계 → MID', () => expect(clearanceBand(0.3)).toBe('MID'));
  it('0.2 → LOW', () => expect(clearanceBand(0.2)).toBe('LOW'));
});

describe('checkAutonomousEnding', () => {
  it('15턴 미만 → 종결 금지(불변식 19)', () => {
    const r = checkAutonomousEnding({
      seed: seed(),
      totalTurns: MIN_AUTONOMOUS_END_TURNS - 1,
      gaugeCritical: true,
    });
    expect(r.shouldEnd).toBe(false);
  });
  it('게이지 임계 → AUTONOMOUS_GAUGE (잔여 예산 무관)', () => {
    const r = checkAutonomousEnding({
      seed: seed(),
      totalTurns: 16,
      gaugeCritical: true,
    });
    expect(r).toEqual({ shouldEnd: true, reason: 'AUTONOMOUS_GAUGE' });
  });
  it('acts 총합(28) 소진 → AUTONOMOUS_ACTS', () => {
    const r = checkAutonomousEnding({
      seed: seed(9, [8, 12, 8]),
      totalTurns: 28,
      gaugeCritical: false,
    });
    expect(r).toEqual({ shouldEnd: true, reason: 'AUTONOMOUS_ACTS' });
  });
  it('acts 미소진 + 게이지 정상 → 미종결', () => {
    const r = checkAutonomousEnding({
      seed: seed(9, [8, 12, 8]),
      totalTurns: 20,
      gaugeCritical: false,
    });
    expect(r.shouldEnd).toBe(false);
  });
});

describe('selectEndingTone', () => {
  const tones = {
    HIGH: { endingType: 'REVEAL', tone: '진실 규명' },
    LOW: { endingType: 'MISS', tone: '미제' },
    gaugeCollapse: { endingType: 'COLLAPSE', tone: '세계 붕괴' },
  };
  it('팩 계약 HIGH 우선', () => {
    expect(selectEndingTone('HIGH', false, tones).endingType).toBe('REVEAL');
  });
  it('게이지 종결 → gaugeCollapse 오버레이', () => {
    expect(selectEndingTone('HIGH', true, tones).endingType).toBe('COLLAPSE');
  });
  it('팩 미선언 band → 중립 fallback', () => {
    expect(selectEndingTone('MID', false, tones).endingType).toBe(
      'PARTIAL_TRUTH',
    );
  });
  it('tones 자체가 없으면 전부 중립', () => {
    expect(selectEndingTone('LOW', false, undefined).endingType).toBe(
      'UNRESOLVED',
    );
  });
});
