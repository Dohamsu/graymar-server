import { WorldTickService } from './world-tick.service.js';
import type { WorldState } from '../../db/types/index.js';

// travel 헬퍼는 incidentMgmt/signalFeed를 사용하지 않는다 — 최소 mock
const svc = new WorldTickService(null as never, null as never);

function baseWs(overrides: Partial<WorldState> = {}): WorldState {
  return {
    globalClock: 0,
    phaseV2: 'DAWN',
    timePhase: 'DAY',
    day: 1,
    hubHeat: 0,
    hubSafety: 'SAFE',
    tension: 0,
    reputation: {},
    flags: {},
    activeIncidents: [],
    signalFeed: [],
    deferredEffects: [],
    narrativeMarks: [],
    combatWindowCount: 0,
    currentLocationId: null,
    mainArc: { unlockedArcIds: [] },
    ...overrides,
  } as unknown as WorldState;
}

describe('WorldTickService.advanceClockForTravel (arch/81 2차 — 이동=시간 소요)', () => {
  it('ticks만큼 시계가 전진하고 phaseV2/day가 재계산된다', () => {
    // DAWN=tick 0~1 → +2면 tick 2 = DAY
    const next = svc.advanceClockForTravel(baseWs(), 2);
    expect(next.globalClock).toBe(2);
    expect(next.phaseV2).toBe('DAY');
    expect(next.day).toBe(1);
  });

  it('전환 발생 시 recentPhaseTransition 기록 + timePhase 파생 미러 (불변식 49)', () => {
    // tick 6 = DUSK 시작 직전(DAY 마지막 tick 5) → +2 = tick 8 = NIGHT? (DUSK=6~7)
    const ws = baseWs({ globalClock: 6, phaseV2: 'DUSK' } as never);
    const next = svc.advanceClockForTravel(ws, 2);
    expect(next.globalClock).toBe(8);
    expect(next.phaseV2).toBe('NIGHT');
    expect(next.timePhase).toBe('NIGHT');
    expect(next.recentPhaseTransition).toEqual({
      from: 'DUSK',
      to: 'NIGHT',
      atClock: 8,
    });
  });

  it('같은 phase 내 이동이면 recentPhaseTransition = null (묵은 전환 잔재 정리)', () => {
    const ws = baseWs({
      globalClock: 2,
      phaseV2: 'DAY',
      recentPhaseTransition: { from: 'DAWN', to: 'DAY', atClock: 2 },
    } as never);
    const next = svc.advanceClockForTravel(ws, 1); // tick 3 = 여전히 DAY
    expect(next.phaseV2).toBe('DAY');
    expect(next.recentPhaseTransition).toBeNull();
  });

  it('ticks<=0 이면 무동작', () => {
    const ws = baseWs();
    expect(svc.advanceClockForTravel(ws, 0)).toBe(ws);
  });

  it('phaseV2 없는 구 런은 timePhase에서 파생해 방어', () => {
    const ws = baseWs({
      globalClock: 9,
      phaseV2: undefined,
      timePhase: 'NIGHT',
    } as never);
    const next = svc.advanceClockForTravel(ws, 2);
    expect(next.globalClock).toBe(11);
    expect(next.phaseV2).toBe('NIGHT'); // tick 11 = NIGHT (8~11)
    expect(next.timePhase).toBe('NIGHT');
  });

  it('자정을 넘으면 day가 증가한다', () => {
    const ws = baseWs({ globalClock: 11, phaseV2: 'NIGHT' } as never);
    const next = svc.advanceClockForTravel(ws, 2); // tick 13 → day 2, tickInDay 1 = DAWN
    expect(next.day).toBe(2);
    expect(next.phaseV2).toBe('DAWN');
    expect(next.recentPhaseTransition?.to).toBe('DAWN');
  });
});
