// [P4 — architecture/75 §5.1] 인력(gravity)·비트 채택 순수 함수 유닛.

import type {
  BeatCandidate,
  NextBeats,
  PlotAct,
  PlotSeed,
} from '../../db/types/plot-seed.js';
import {
  getActProgress,
  getUndiscoveredKeyFacts,
  isBeatIntentAligned,
  scoreBeatCandidate,
  selectBeatForAdoption,
  type BeatAdoptionContext,
} from './beat-gravity.js';
import { AUTONOMOUS_BALANCE } from './quest-balance.config.js';

const ACTS: PlotAct[] = [
  { no: 1, turnBudget: 8, goal: '사건 인지' },
  { no: 2, turnBudget: 12, goal: '심층 규명' },
  { no: 3, turnBudget: 8, goal: '대결/해소' },
];

describe('getActProgress', () => {
  it('막 경계를 누적 예산으로 계산한다', () => {
    expect(getActProgress(ACTS, 1)).toMatchObject({
      currentAct: 1,
      turnsUsedInAct: 1,
      turnsRemainingInAct: 7,
    });
    expect(getActProgress(ACTS, 8)).toMatchObject({
      currentAct: 1,
      turnsRemainingInAct: 0,
    });
    expect(getActProgress(ACTS, 9)).toMatchObject({
      currentAct: 2,
      turnsUsedInAct: 1,
      turnsRemainingInAct: 11,
    });
    expect(getActProgress(ACTS, 28)).toMatchObject({
      currentAct: 3,
      turnsRemainingInAct: 0,
    });
  });

  it('예산 총합 초과 시 마지막 막에 머무른다 (종결은 P5 몫)', () => {
    expect(getActProgress(ACTS, 99)).toMatchObject({
      currentAct: 3,
      turnsRemainingInAct: 0,
    });
  });

  it('acts 부재 시 단일 막(예산 15)으로 간주한다', () => {
    expect(getActProgress(undefined, 5)).toMatchObject({
      currentAct: 1,
      actBudget: 15,
      turnsRemainingInAct: 10,
    });
  });
});

describe('getUndiscoveredKeyFacts', () => {
  const seed = {
    keyFacts: [
      { factId: 'F1', summary: 'a', holders: ['N1'] },
      { factId: 'F2', summary: 'b', holders: ['N2'] },
    ],
  } as unknown as PlotSeed;

  it('발견된 fact를 제외한다', () => {
    const rest = getUndiscoveredKeyFacts(seed, {
      discoveredKeyFactIds: ['F1'],
    });
    expect(rest.map((f) => f.factId)).toEqual(['F2']);
  });

  it('progress 부재 시 전체를 반환한다', () => {
    expect(getUndiscoveredKeyFacts(seed, undefined)).toHaveLength(2);
  });
});

const baseCtx = (over?: Partial<BeatAdoptionContext>): BeatAdoptionContext => ({
  turnNo: 5,
  locationId: 'LOC_1',
  actionType: 'INVESTIGATE',
  targetNpcId: null,
  lastPrimaryNpcId: null,
  undiscoveredFactIds: new Set(['F1']),
  actProgress: getActProgress(ACTS, 5),
  ...over,
});

const beat = (over?: Partial<BeatCandidate>): BeatCandidate => ({
  beatId: 'BEAT_4_0',
  premise: '창고 뒤에서 수상한 거래가 목격된다',
  involvedNpcIds: ['NPC_A'],
  locationId: 'LOC_1',
  ...over,
});

describe('scoreBeatCandidate', () => {
  it('장소 불일치 비트는 하드 불채택(-1)', () => {
    expect(scoreBeatCandidate(beat({ locationId: 'LOC_2' }), baseCtx())).toBe(
      -1,
    );
  });

  it('장소 일치 + 행동 정합 + 타겟 NPC 일치 가중이 합산된다', () => {
    const s = scoreBeatCandidate(
      beat({ affordances: ['INVESTIGATE'], involvedNpcIds: ['NPC_A'] }),
      baseCtx({ targetNpcId: 'NPC_A' }),
    );
    expect(s).toBe(
      AUTONOMOUS_BALANCE.GRAVITY_LOCATION_BONUS +
        AUTONOMOUS_BALANCE.GRAVITY_AFFORDANCE_BONUS +
        AUTONOMOUS_BALANCE.GRAVITY_NPC_BONUS,
    );
  });

  it('직전 상호작용 NPC는 타겟의 절반 가중', () => {
    const s = scoreBeatCandidate(
      beat(),
      baseCtx({ lastPrimaryNpcId: 'NPC_A' }),
    );
    expect(s).toBe(
      AUTONOMOUS_BALANCE.GRAVITY_LOCATION_BONUS +
        Math.floor(AUTONOMOUS_BALANCE.GRAVITY_NPC_BONUS / 2),
    );
  });

  it('미발견 fact 힌트 비트는 fact 가중 + 막 압박 인력', () => {
    // 막 잔여 0 (turnNo 8 = 1막 소진) → 압박 최대
    const ctx = baseCtx({
      turnNo: 8,
      actProgress: getActProgress(ACTS, 8),
    });
    const s = scoreBeatCandidate(beat({ hintedFactId: 'F1' }), ctx);
    expect(s).toBe(
      AUTONOMOUS_BALANCE.GRAVITY_LOCATION_BONUS +
        AUTONOMOUS_BALANCE.GRAVITY_FACT_BONUS +
        AUTONOMOUS_BALANCE.GRAVITY_ACT_PRESSURE_MAX,
    );
  });

  it('이미 발견된 fact 힌트에는 인력이 붙지 않는다', () => {
    const s = scoreBeatCandidate(
      beat({ hintedFactId: 'F_DISCOVERED' }),
      baseCtx(),
    );
    expect(s).toBe(AUTONOMOUS_BALANCE.GRAVITY_LOCATION_BONUS);
  });
});

describe('selectBeatForAdoption', () => {
  const freshBeats = (candidates: BeatCandidate[]): NextBeats => ({
    generatedAtTurn: 4,
    candidates,
  });

  it('임계 이상 최고 점수 후보를 채택한다', () => {
    const weak = beat({ beatId: 'W', locationId: undefined });
    const strong = beat({ beatId: 'S', hintedFactId: 'F1' });
    const r = selectBeatForAdoption(freshBeats([weak, strong]), baseCtx());
    expect(r?.beat.beatId).toBe('S');
    expect(r!.score).toBeGreaterThanOrEqual(
      AUTONOMOUS_BALANCE.BEAT_ADOPT_MIN_SCORE,
    );
  });

  it('임계 미달이면 폐기(null) — 폴백 체인 진행', () => {
    const weak = beat({ locationId: undefined }); // 장소 무관, 보너스 0
    expect(selectBeatForAdoption(freshBeats([weak]), baseCtx())).toBeNull();
  });

  it('stale 후보(BEAT_STALE_MAX_TURNS 초과)는 전체 폐기', () => {
    const ctx = baseCtx({
      turnNo: 4 + AUTONOMOUS_BALANCE.BEAT_STALE_MAX_TURNS + 1,
    });
    expect(selectBeatForAdoption(freshBeats([beat()]), ctx)).toBeNull();
  });

  it('같은 턴(age 0) 후보는 채택하지 않는다 — 선계산은 다음 턴부터', () => {
    const ctx = baseCtx({ turnNo: 4 });
    expect(selectBeatForAdoption(freshBeats([beat()]), ctx)).toBeNull();
  });

  it('후보 없음/null이면 null', () => {
    expect(selectBeatForAdoption(null, baseCtx())).toBeNull();
    expect(selectBeatForAdoption(freshBeats([]), baseCtx())).toBeNull();
  });
});

// [D1-c — arch/76] 의도 정합 계측 헬퍼
describe('isBeatIntentAligned', () => {
  it('affordance가 행동 계열을 포함하면 true', () => {
    expect(
      isBeatIntentAligned(
        beat({ affordances: ['INVESTIGATE', 'OBSERVE'] }),
        'INVESTIGATE',
      ),
    ).toBe(true);
  });

  it('affordance가 지정됐으나 불일치면 false', () => {
    expect(isBeatIntentAligned(beat({ affordances: ['SNEAK'] }), 'TALK')).toBe(
      false,
    );
  });

  it('affordances 미지정(행동 무관 비트)이면 null — 정합률 분모 제외', () => {
    expect(
      isBeatIntentAligned(beat({ affordances: undefined }), 'TALK'),
    ).toBeNull();
    expect(isBeatIntentAligned(beat({ affordances: [] }), 'TALK')).toBeNull();
  });
});

// [버그 d20c1de8 — 불변식 47 확장] 연속 상호작용 필수 NPC 필터
describe('selectBeatForAdoption — requiredNpcId (연속 상호작용 게이트)', () => {
  const freshBeats2 = (candidates: BeatCandidate[]): NextBeats => ({
    generatedAtTurn: 4,
    candidates,
  });

  it('requiredNpcId 미포함 비트는 하드 불채택 — 구타 대상 스왑 차단', () => {
    const other = beat({
      beatId: 'OTHER',
      involvedNpcIds: ['NPC_WARDEN'],
      hintedFactId: 'F1',
    });
    const r = selectBeatForAdoption(
      freshBeats2([other]),
      baseCtx({ requiredNpcId: 'NPC_GUILDMASTER' }),
    );
    expect(r).toBeNull();
  });

  it('requiredNpcId 포함 비트는 정상 채택', () => {
    const match = beat({
      beatId: 'MATCH',
      involvedNpcIds: ['NPC_A'],
      hintedFactId: 'F1',
    });
    const r = selectBeatForAdoption(
      freshBeats2([match]),
      baseCtx({ requiredNpcId: 'NPC_A' }),
    );
    expect(r?.beat.beatId).toBe('MATCH');
  });

  it('requiredNpcId 없으면(도착 턴 등) 기존 동작', () => {
    const any = beat({ beatId: 'ANY', hintedFactId: 'F1' });
    const r = selectBeatForAdoption(
      freshBeats2([any]),
      baseCtx({ requiredNpcId: null }),
    );
    expect(r?.beat.beatId).toBe('ANY');
  });
});
