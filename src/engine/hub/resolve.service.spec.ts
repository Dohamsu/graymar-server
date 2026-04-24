// 정본 점검: HUB 판정 엔진 — 핵심 로직 회귀 방어용 스펙
// 대상: resolve.service.ts (440 LOC) / computeOutcome, computeGoldCost,
//       buildAutoSuccess, resolve 메인 파이프라인, selectCombatEncounter

import { ResolveService } from './resolve.service.js';
import { SuddenActionDetectorService } from './sudden-action-detector.service.js';
import type {
  EventDefV2,
  ParsedIntentV2,
  WorldState,
  PermanentStats,
  RunState,
} from '../../db/types/index.js';
import type { Rng } from '../rng/rng.service.js';

// ─── 공통 팩토리 ──────────────────────────────────────────────
function makeEvent(overrides: Partial<EventDefV2> = {}): EventDefV2 {
  return {
    eventId: 'TEST_EVT',
    locationId: 'LOC_MARKET',
    eventType: 'ENCOUNTER',
    priority: 50,
    weight: 10,
    conditions: null,
    gates: [],
    affordances: ['ANY'],
    friction: 0,
    matchPolicy: 'NEUTRAL',
    payload: {
      sceneFrame: '시장 근처',
      choices: [],
      effectsOnEnter: [],
      tags: [],
    },
    ...overrides,
  } as EventDefV2;
}

function makeIntent(overrides: Partial<ParsedIntentV2> = {}): ParsedIntentV2 {
  return {
    inputText: '경비에게 말을 건다',
    actionType: 'TALK',
    tone: 'NEUTRAL',
    target: null,
    riskLevel: 1,
    intentTags: [],
    confidence: 2,
    source: 'RULE',
    ...overrides,
  } as ParsedIntentV2;
}

function makeWorld(overrides: Partial<WorldState> = {}): WorldState {
  return {
    hubHeat: 20,
    hubSafety: 'SAFE',
    currentLocationId: 'LOC_MARKET',
    combatWindowCount: 0,
    timePhase: 'DAY',
    ...overrides,
  } as WorldState;
}

function makeStats(overrides: Partial<PermanentStats> = {}): PermanentStats {
  return {
    str: 10,
    dex: 10,
    wit: 10,
    con: 10,
    per: 10,
    cha: 10,
    ...overrides,
  } as PermanentStats;
}

// 결정적 Rng — 고정 값 시퀀스
function makeRng(seq: number[]): Rng {
  let i = 0;
  return {
    range: (_min: number, _max: number) => {
      const v = seq[i % seq.length];
      i++;
      return v;
    },
  } as unknown as Rng;
}

// ─── 테스트 ────────────────────────────────────────────────────
describe('ResolveService', () => {
  let service: ResolveService;

  beforeEach(() => {
    service = new ResolveService(new SuddenActionDetectorService());
  });

  // ══════════════════════════════════════════════════════════════
  describe('computeOutcome (score → SUCCESS/PARTIAL/FAIL)', () => {
    // private 함수 간접 검증 — resolve() 를 통해 확인
    it('score ≥ 5 → SUCCESS (주사위 6 + stat 10/4=2 + 없음 → 8)', () => {
      const r = service.resolve(
        makeEvent(),
        makeIntent({ actionType: 'TALK' }), // cha=10/4=2
        makeWorld(),
        makeStats({ cha: 10 }),
        makeRng([6]),
      );
      expect(r.score).toBe(8);
      expect(r.outcome).toBe('SUCCESS');
    });

    it('score 3~4 → PARTIAL (주사위 2 + stat 4/4=1 → 3)', () => {
      const r = service.resolve(
        makeEvent(),
        makeIntent({ actionType: 'TALK' }),
        makeWorld(),
        makeStats({ cha: 4 }),
        makeRng([2]),
      );
      expect(r.score).toBe(3);
      expect(r.outcome).toBe('PARTIAL');
    });

    it('score < 3 → FAIL (주사위 1 + stat 4/4=1 → 2)', () => {
      const r = service.resolve(
        makeEvent(),
        makeIntent({ actionType: 'TALK' }),
        makeWorld(),
        makeStats({ cha: 4 }),
        makeRng([1]),
      );
      expect(r.score).toBe(2);
      expect(r.outcome).toBe('FAIL');
    });
  });

  // ══════════════════════════════════════════════════════════════
  describe('비도전 행위 (NON_CHALLENGE) — 자동 SUCCESS', () => {
    it.each(['MOVE_LOCATION', 'REST', 'SHOP', 'EQUIP', 'UNEQUIP'])(
      '%s → 주사위 없이 outcome=SUCCESS, heatDelta=0, triggerCombat=false',
      (actionType) => {
        const r = service.resolve(
          makeEvent(),
          makeIntent({
            actionType: actionType as ParsedIntentV2['actionType'],
          }),
          makeWorld(),
          makeStats(),
          makeRng([1]), // 주사위 소비되지 않아야 함
        );
        expect(r.outcome).toBe('SUCCESS');
        expect(r.heatDelta).toBe(0);
        expect(r.triggerCombat).toBe(false);
        expect(r.diceRoll).toBeUndefined();
      },
    );

    it('auto SUCCESS: primaryNpcId 있으면 relationChanges +5', () => {
      const r = service.resolve(
        makeEvent({
          payload: {
            sceneFrame: '',
            choices: [],
            effectsOnEnter: [],
            tags: [],
            primaryNpcId: 'NPC_ROSA',
          },
        }),
        makeIntent({ actionType: 'MOVE_LOCATION' }),
        makeWorld(),
        makeStats(),
        makeRng([1]),
      );
      expect(r.relationChanges['NPC_ROSA']).toBe(5);
    });
  });

  // ══════════════════════════════════════════════════════════════
  describe('matchPolicy 보정', () => {
    it('SUPPORT → baseMod +1', () => {
      const r = service.resolve(
        makeEvent({ matchPolicy: 'SUPPORT' }),
        makeIntent({ actionType: 'TALK' }),
        makeWorld(),
        makeStats({ cha: 4 }), // statBonus=1
        makeRng([2]), // 1(base=SUPPORT) + 1(stat) + 2(dice) = 4
      );
      expect(r.baseMod).toBe(1);
      expect(r.score).toBe(4);
      expect(r.outcome).toBe('PARTIAL');
    });

    it('BLOCK → baseMod -1 + friction', () => {
      const r = service.resolve(
        makeEvent({ matchPolicy: 'BLOCK', friction: 2 }),
        makeIntent({ actionType: 'TALK' }),
        makeWorld(),
        makeStats({ cha: 4 }),
        makeRng([6]),
      );
      // baseMod = -1 - 2 = -3, dice=6 + stat=1 = 4
      expect(r.baseMod).toBe(-3);
      expect(r.score).toBe(4);
    });

    it('riskLevel 3 → 추가 -1 페널티', () => {
      const r = service.resolve(
        makeEvent(),
        makeIntent({ actionType: 'TALK', riskLevel: 3 }),
        makeWorld(),
        makeStats({ cha: 4 }),
        makeRng([3]),
      );
      expect(r.baseMod).toBe(-1);
    });
  });

  // ══════════════════════════════════════════════════════════════
  describe('heatDelta — outcome/matchPolicy/actionType 조합', () => {
    it('SUCCESS + NEUTRAL → heatDelta=1', () => {
      const r = service.resolve(
        makeEvent({ matchPolicy: 'NEUTRAL' }),
        makeIntent({ actionType: 'TALK' }),
        makeWorld(),
        makeStats({ cha: 20 }),
        makeRng([6]),
      );
      expect(r.outcome).toBe('SUCCESS');
      expect(r.heatDelta).toBe(1);
    });

    it('SUCCESS + BLOCK → heatDelta=3', () => {
      const r = service.resolve(
        makeEvent({ matchPolicy: 'BLOCK' }),
        makeIntent({ actionType: 'TALK' }),
        makeWorld(),
        makeStats({ cha: 40 }),
        makeRng([6]),
      );
      expect(r.outcome).toBe('SUCCESS');
      expect(r.heatDelta).toBe(3);
    });

    it('FAIL + BLOCK → heatDelta=5', () => {
      const r = service.resolve(
        makeEvent({ matchPolicy: 'BLOCK' }),
        makeIntent({ actionType: 'TALK' }),
        makeWorld(),
        makeStats({ cha: 0 }),
        makeRng([1]),
      );
      expect(r.outcome).toBe('FAIL');
      expect(r.heatDelta).toBe(5);
    });

    it('FIGHT/THREATEN → heatDelta +2 추가 (+ 돌발행동 SEVERE 자동 +3)', () => {
      const r = service.resolve(
        makeEvent({ matchPolicy: 'NEUTRAL' }),
        makeIntent({ actionType: 'FIGHT' }),
        makeWorld(),
        makeStats({ str: 20 }),
        makeRng([6]),
      );
      expect(r.outcome).toBe('SUCCESS');
      // SUCCESS NEUTRAL=1 + FIGHT actionType=2 + SuddenAction SEVERE=3 = 6
      // FIGHT 는 키워드 없이도 기본 SEVERE 판정 (sudden-action-detector 설계).
      expect(r.heatDelta).toBe(6);
      expect(r.suddenAction?.severity).toBe('SEVERE');
    });

    it('heatDelta ±8 clamp', () => {
      const r = service.resolve(
        makeEvent({ matchPolicy: 'BLOCK' }),
        makeIntent({ actionType: 'FIGHT', inputText: '죽인다' }),
        makeWorld(),
        makeStats({ str: 0 }),
        makeRng([1]),
      );
      // FAIL BLOCK=5 + FIGHT=2 + CRITICAL=6 = 13 → clamp 8
      expect(r.heatDelta).toBe(8);
    });
  });

  // ══════════════════════════════════════════════════════════════
  describe('돌발행동 통합', () => {
    it('CRITICAL "칼로 찌른다" → combat 강제 + heatDelta +6', () => {
      const r = service.resolve(
        makeEvent({ matchPolicy: 'NEUTRAL' }),
        makeIntent({
          actionType: 'FIGHT',
          inputText: '경비병을 칼로 찌른다',
          targetNpcId: 'NPC_GUARD',
        }),
        makeWorld({ combatWindowCount: 0 }),
        makeStats({ str: 40 }),
        makeRng([6]), // SUCCESS 임에도 combat 강제
      );
      expect(r.outcome).toBe('SUCCESS');
      expect(r.suddenAction?.severity).toBe('CRITICAL');
      expect(r.triggerCombat).toBe(true);
      expect(r.heatDelta).toBe(8); // SUCCESS=1 + FIGHT=2 + CRITICAL=6 = 9 clamp → 8
    });

    it('SEVERE "철퇴로 내려친다" → heatDelta +3', () => {
      const r = service.resolve(
        makeEvent({ matchPolicy: 'NEUTRAL' }),
        makeIntent({
          actionType: 'FIGHT',
          inputText: '철퇴로 내려친다',
        }),
        makeWorld(),
        makeStats({ str: 40 }),
        makeRng([6]),
      );
      expect(r.suddenAction?.severity).toBe('SEVERE');
      // SUCCESS=1 + FIGHT=2 + SEVERE=3 = 6
      expect(r.heatDelta).toBe(6);
    });

    it('MODERATE "지갑을 훔친다" (STEAL) → heatDelta +1', () => {
      const r = service.resolve(
        makeEvent({ matchPolicy: 'NEUTRAL' }),
        makeIntent({
          actionType: 'STEAL',
          inputText: '지갑을 훔친다',
        }),
        makeWorld(),
        makeStats({ dex: 40 }),
        makeRng([6]),
      );
      expect(r.suddenAction?.severity).toBe('MODERATE');
    });

    it('combatWindow MAX 도달 시 CRITICAL 이어도 combat 미트리거', () => {
      const r = service.resolve(
        makeEvent({ matchPolicy: 'NEUTRAL' }),
        makeIntent({
          actionType: 'FIGHT',
          inputText: '죽인다',
        }),
        makeWorld({ combatWindowCount: 3 }), // MAX
        makeStats({ str: 40 }),
        makeRng([6]),
      );
      expect(r.suddenAction?.severity).toBe('CRITICAL');
      expect(r.triggerCombat).toBe(false);
    });
  });

  // ══════════════════════════════════════════════════════════════
  describe('Combat 트리거', () => {
    it('FAIL + BLOCK + combatWindow 여유 → triggerCombat=true', () => {
      const r = service.resolve(
        makeEvent({ matchPolicy: 'BLOCK', locationId: 'LOC_GUARD' }),
        makeIntent({ actionType: 'TALK' }),
        makeWorld({ combatWindowCount: 0 }),
        makeStats({ cha: 0 }),
        makeRng([1]),
      );
      expect(r.outcome).toBe('FAIL');
      expect(r.triggerCombat).toBe(true);
      expect(r.combatEncounterId).toBe('enc_guard_ambush');
    });

    it('SUCCESS + BLOCK → triggerCombat=false', () => {
      const r = service.resolve(
        makeEvent({ matchPolicy: 'BLOCK' }),
        makeIntent({ actionType: 'TALK' }),
        makeWorld(),
        makeStats({ cha: 40 }),
        makeRng([6]),
      );
      expect(r.outcome).toBe('SUCCESS');
      expect(r.triggerCombat).toBe(false);
    });

    it('FAIL + NEUTRAL → triggerCombat=false', () => {
      const r = service.resolve(
        makeEvent({ matchPolicy: 'NEUTRAL' }),
        makeIntent({ actionType: 'TALK' }),
        makeWorld(),
        makeStats({ cha: 0 }),
        makeRng([1]),
      );
      expect(r.outcome).toBe('FAIL');
      expect(r.triggerCombat).toBe(false);
    });

    it('combatEncounterId 맵: LOC_MARKET → enc_market_thugs', () => {
      const r = service.resolve(
        makeEvent({ matchPolicy: 'BLOCK', locationId: 'LOC_MARKET' }),
        makeIntent({ actionType: 'TALK' }),
        makeWorld(),
        makeStats({ cha: 0 }),
        makeRng([1]),
      );
      expect(r.combatEncounterId).toBe('enc_market_thugs');
    });

    it('combatEncounterId 맵: 미등록 location → enc_generic', () => {
      const r = service.resolve(
        makeEvent({ matchPolicy: 'BLOCK', locationId: 'LOC_UNKNOWN' }),
        makeIntent({ actionType: 'TALK' }),
        makeWorld({ currentLocationId: 'LOC_UNKNOWN' }),
        makeStats({ cha: 0 }),
        makeRng([1]),
      );
      expect(r.combatEncounterId).toBe('enc_generic');
    });
  });

  // ══════════════════════════════════════════════════════════════
  describe('BRIBE/TRADE 골드 비용 (computeGoldCost)', () => {
    it('BRIBE SUCCESS 기본값 → goldDelta=-3', () => {
      const r = service.resolve(
        makeEvent(),
        makeIntent({ actionType: 'BRIBE' }),
        makeWorld(),
        makeStats({ cha: 40 }),
        makeRng([6]),
      );
      expect(r.outcome).toBe('SUCCESS');
      expect(r.goldDelta).toBe(-3);
    });

    it('BRIBE PARTIAL 기본값 → goldDelta=-2', () => {
      const r = service.resolve(
        makeEvent(),
        makeIntent({ actionType: 'BRIBE' }),
        makeWorld(),
        makeStats({ cha: 4 }),
        makeRng([2]),
      );
      expect(r.outcome).toBe('PARTIAL');
      expect(r.goldDelta).toBe(-2);
    });

    it('BRIBE FAIL → goldDelta=0 (거래 불성사)', () => {
      const r = service.resolve(
        makeEvent(),
        makeIntent({ actionType: 'BRIBE' }),
        makeWorld(),
        makeStats({ cha: 0 }),
        makeRng([1]),
      );
      expect(r.outcome).toBe('FAIL');
      expect(r.goldDelta).toBe(0);
    });

    it('BRIBE SUCCESS specifiedGold=10 → goldDelta=-10 (전액)', () => {
      const r = service.resolve(
        makeEvent(),
        makeIntent({ actionType: 'BRIBE', specifiedGold: 10 }),
        makeWorld(),
        makeStats({ cha: 40 }),
        makeRng([6]),
      );
      expect(r.goldDelta).toBe(-10);
    });

    it('BRIBE PARTIAL specifiedGold=10 → goldDelta=-6 (60% ceil)', () => {
      const r = service.resolve(
        makeEvent(),
        makeIntent({ actionType: 'BRIBE', specifiedGold: 10 }),
        makeWorld(),
        makeStats({ cha: 4 }),
        makeRng([2]),
      );
      expect(r.outcome).toBe('PARTIAL');
      expect(r.goldDelta).toBe(-6);
    });

    it('TALK (비거래) → goldDelta=0', () => {
      const r = service.resolve(
        makeEvent(),
        makeIntent({ actionType: 'TALK' }),
        makeWorld(),
        makeStats(),
        makeRng([4]),
      );
      expect(r.goldDelta).toBe(0);
    });
  });

  // ══════════════════════════════════════════════════════════════
  describe('relationChanges + reputationChanges', () => {
    it('SUCCESS + primaryNpcId → +5', () => {
      const r = service.resolve(
        makeEvent({
          payload: {
            sceneFrame: '',
            choices: [],
            effectsOnEnter: [],
            tags: [],
            primaryNpcId: 'NPC_X',
          },
        }),
        makeIntent({ actionType: 'TALK' }),
        makeWorld(),
        makeStats({ cha: 40 }),
        makeRng([6]),
      );
      expect(r.relationChanges['NPC_X']).toBe(5);
    });

    it('PARTIAL → +2, FAIL → -3', () => {
      const evt = makeEvent({
        payload: {
          sceneFrame: '',
          choices: [],
          effectsOnEnter: [],
          tags: [],
          primaryNpcId: 'NPC_Y',
        },
      });
      const partial = service.resolve(
        evt,
        makeIntent({ actionType: 'TALK' }),
        makeWorld(),
        makeStats({ cha: 4 }),
        makeRng([2]),
      );
      expect(partial.relationChanges['NPC_Y']).toBe(2);

      const fail = service.resolve(
        evt,
        makeIntent({ actionType: 'TALK' }),
        makeWorld(),
        makeStats({ cha: 0 }),
        makeRng([1]),
      );
      expect(fail.relationChanges['NPC_Y']).toBe(-3);
    });

    it('GUARD 태그 → CITY_GUARD 평판 반영', () => {
      const r = service.resolve(
        makeEvent({
          payload: {
            sceneFrame: '',
            choices: [],
            effectsOnEnter: [],
            tags: ['GUARD_PATROL'],
          },
        }),
        makeIntent({ actionType: 'TALK' }),
        makeWorld(),
        makeStats({ cha: 40 }),
        makeRng([6]),
      );
      expect(r.reputationChanges['CITY_GUARD']).toBe(3);
    });

    it('MERCHANT_GUILD 태그 → MERCHANT_CONSORTIUM 평판', () => {
      const r = service.resolve(
        makeEvent({
          payload: {
            sceneFrame: '',
            choices: [],
            effectsOnEnter: [],
            tags: ['MERCHANT_GUILD'],
          },
        }),
        makeIntent({ actionType: 'TALK' }),
        makeWorld(),
        makeStats({ cha: 40 }),
        makeRng([6]),
      );
      expect(r.reputationChanges['MERCHANT_CONSORTIUM']).toBe(3);
    });

    it('태그 없고 NPC faction 만 있을 때 fallback 평판 +2', () => {
      const r = service.resolve(
        makeEvent({
          payload: {
            sceneFrame: '',
            choices: [],
            effectsOnEnter: [],
            tags: [],
          },
        }),
        makeIntent({ actionType: 'TALK' }),
        makeWorld(),
        makeStats({ cha: 40 }),
        makeRng([6]),
        [], // activeSpecialEffects
        undefined,
        'CITY_GUARD',
      );
      expect(r.reputationChanges['CITY_GUARD']).toBe(2);
    });
  });

  // ══════════════════════════════════════════════════════════════
  describe('특성 런타임 효과', () => {
    it('BLOOD_OATH: HP 25% 이하 → traitBonus +3', () => {
      const runState = {
        hp: 20,
        maxHp: 100,
        traitEffects: {
          lowHpBonus: { threshold50: 2, threshold25: 1 },
        },
      } as unknown as RunState;
      const r = service.resolve(
        makeEvent(),
        makeIntent({ actionType: 'TALK' }),
        makeWorld(),
        makeStats({ cha: 0 }),
        makeRng([1]),
        [],
        undefined,
        null,
        runState,
      );
      expect(r.traitBonus).toBe(3);
    });

    it('BLOOD_OATH: HP 50% 이하 → traitBonus +2', () => {
      const runState = {
        hp: 40,
        maxHp: 100,
        traitEffects: {
          lowHpBonus: { threshold50: 2, threshold25: 1 },
        },
      } as unknown as RunState;
      const r = service.resolve(
        makeEvent(),
        makeIntent({ actionType: 'TALK' }),
        makeWorld(),
        makeStats({ cha: 0 }),
        makeRng([1]),
        [],
        undefined,
        null,
        runState,
      );
      expect(r.traitBonus).toBe(2);
    });

    it('NIGHT_CHILD: NIGHT → +2 / DAY → -1', () => {
      const runState = {
        hp: 100,
        maxHp: 100,
        traitEffects: {
          nightBonus: 2,
          dayPenalty: -1,
        },
      } as unknown as RunState;
      const night = service.resolve(
        makeEvent(),
        makeIntent({ actionType: 'TALK' }),
        makeWorld({ timePhase: 'NIGHT' }),
        makeStats({ cha: 10 }),
        makeRng([3]),
        [],
        undefined,
        null,
        runState,
      );
      expect(night.traitBonus).toBe(2);

      const day = service.resolve(
        makeEvent(),
        makeIntent({ actionType: 'TALK' }),
        makeWorld({ timePhase: 'DAY' }),
        makeStats({ cha: 10 }),
        makeRng([3]),
        [],
        undefined,
        null,
        runState,
      );
      expect(day.traitBonus).toBe(-1);
    });

    it('GAMBLER_LUCK: FAIL + 확률 100% → PARTIAL 승격', () => {
      const runState = {
        hp: 100,
        maxHp: 100,
        traitEffects: {
          failToPartialChance: 100,
        },
      } as unknown as RunState;
      const r = service.resolve(
        makeEvent(),
        makeIntent({ actionType: 'TALK' }),
        makeWorld(),
        makeStats({ cha: 0 }),
        makeRng([1, 0]), // dice=1, luck=0 < 100
        [],
        undefined,
        null,
        runState,
      );
      expect(r.outcome).toBe('PARTIAL');
      expect(r.gamblerLuckTriggered).toBe(true);
    });

    it('GAMBLER_LUCK: FAIL + 확률 0% → FAIL 유지', () => {
      const runState = {
        hp: 100,
        maxHp: 100,
        traitEffects: {
          failToPartialChance: 0,
        },
      } as unknown as RunState;
      const r = service.resolve(
        makeEvent(),
        makeIntent({ actionType: 'TALK' }),
        makeWorld(),
        makeStats({ cha: 0 }),
        makeRng([1, 50]),
        [],
        undefined,
        null,
        runState,
      );
      expect(r.outcome).toBe('FAIL');
      expect(r.gamblerLuckTriggered).toBeFalsy();
    });
  });

  // ══════════════════════════════════════════════════════════════
  describe('기타 modifier', () => {
    it('PERSUADE_BRIBE_BONUS_1 세트 효과 → baseMod +1 (PERSUADE)', () => {
      const r = service.resolve(
        makeEvent(),
        makeIntent({ actionType: 'PERSUADE' }),
        makeWorld(),
        makeStats({ cha: 10 }),
        makeRng([2]),
        ['PERSUADE_BRIBE_BONUS_1'],
      );
      expect(r.baseMod).toBe(1);
    });

    it('presetActionBonuses[TALK]=2 → baseMod +2', () => {
      const r = service.resolve(
        makeEvent(),
        makeIntent({ actionType: 'TALK' }),
        makeWorld(),
        makeStats({ cha: 10 }),
        makeRng([2]),
        [],
        { TALK: 2 },
      );
      expect(r.baseMod).toBe(2);
    });

    it('장소 blockedActions 포함 시 baseMod -2', () => {
      const r = service.resolve(
        makeEvent(),
        makeIntent({ actionType: 'TALK' }),
        makeWorld({
          locationDynamicStates: {
            LOC_MARKET: {
              activeConditions: [{ effects: { blockedActions: ['TALK'] } }],
            },
          } as unknown as WorldState['locationDynamicStates'],
        }),
        makeStats(),
        makeRng([4]),
      );
      expect(r.baseMod).toBe(-2);
    });

    it('장소 boostedActions 포함 시 baseMod +1', () => {
      const r = service.resolve(
        makeEvent(),
        makeIntent({ actionType: 'TALK' }),
        makeWorld({
          locationDynamicStates: {
            LOC_MARKET: {
              activeConditions: [{ effects: { boostedActions: ['TALK'] } }],
            },
          } as unknown as WorldState['locationDynamicStates'],
        }),
        makeStats(),
        makeRng([4]),
      );
      expect(r.baseMod).toBe(1);
    });
  });

  // ══════════════════════════════════════════════════════════════
  describe('deferredEffects', () => {
    it('THREATEN SUCCESS → REPUTATION_BACKLASH 3턴 지연', () => {
      const r = service.resolve(
        makeEvent(),
        makeIntent({ actionType: 'THREATEN' }),
        makeWorld(),
        makeStats({ str: 40 }),
        makeRng([6]),
      );
      expect(r.outcome).toBe('SUCCESS');
      expect(r.deferredEffects.length).toBe(1);
      expect(r.deferredEffects[0].type).toBe('REPUTATION_BACKLASH');
      expect(r.deferredEffects[0].triggerTurnDelay).toBe(3);
    });

    it('DECEPTIVE tone SUCCESS → REPUTATION_BACKLASH', () => {
      const r = service.resolve(
        makeEvent(),
        makeIntent({ actionType: 'TALK', tone: 'DECEPTIVE' }),
        makeWorld(),
        makeStats({ cha: 40 }),
        makeRng([6]),
      );
      expect(r.deferredEffects.length).toBe(1);
    });

    it('TALK NEUTRAL SUCCESS → deferredEffects 없음', () => {
      const r = service.resolve(
        makeEvent(),
        makeIntent({ actionType: 'TALK' }),
        makeWorld(),
        makeStats({ cha: 40 }),
        makeRng([6]),
      );
      expect(r.deferredEffects.length).toBe(0);
    });
  });

  // ══════════════════════════════════════════════════════════════
  describe('agendaBucketDelta (태그 기반)', () => {
    it('SUCCESS + destabilize 태그 → destabilizeGuard=2', () => {
      const r = service.resolve(
        makeEvent({
          payload: {
            sceneFrame: '',
            choices: [],
            effectsOnEnter: [],
            tags: ['destabilize'],
          },
        }),
        makeIntent({ actionType: 'TALK' }),
        makeWorld(),
        makeStats({ cha: 40 }),
        makeRng([6]),
      );
      expect(r.agendaBucketDelta.destabilizeGuard).toBe(2);
    });

    it('PARTIAL + corruption 태그 → exposeCorruption=1', () => {
      const r = service.resolve(
        makeEvent({
          payload: {
            sceneFrame: '',
            choices: [],
            effectsOnEnter: [],
            tags: ['corruption'],
          },
        }),
        makeIntent({ actionType: 'TALK' }),
        makeWorld(),
        makeStats({ cha: 4 }),
        makeRng([2]),
      );
      expect(r.agendaBucketDelta.exposeCorruption).toBe(1);
    });

    it('FAIL → agendaBucketDelta 비어있음', () => {
      const r = service.resolve(
        makeEvent({
          payload: {
            sceneFrame: '',
            choices: [],
            effectsOnEnter: [],
            tags: ['merchant'],
          },
        }),
        makeIntent({ actionType: 'TALK' }),
        makeWorld(),
        makeStats({ cha: 0 }),
        makeRng([1]),
      );
      expect(Object.keys(r.agendaBucketDelta).length).toBe(0);
    });
  });

  // ══════════════════════════════════════════════════════════════
  describe('commitmentDelta + flagsSet', () => {
    it('SUCCESS + commitmentDeltaOnSuccess=5 → commitmentDelta=5', () => {
      const r = service.resolve(
        makeEvent({ commitmentDeltaOnSuccess: 5 }),
        makeIntent({ actionType: 'TALK' }),
        makeWorld(),
        makeStats({ cha: 40 }),
        makeRng([6]),
      );
      expect(r.commitmentDelta).toBe(5);
    });

    it('SUCCESS + flag_* 태그 → flagsSet에 수집', () => {
      const r = service.resolve(
        makeEvent({
          payload: {
            sceneFrame: '',
            choices: [],
            effectsOnEnter: [],
            tags: ['flag_bribed_guard', 'MERCHANT_GUILD'],
          },
        }),
        makeIntent({ actionType: 'TALK' }),
        makeWorld(),
        makeStats({ cha: 40 }),
        makeRng([6]),
      );
      expect(r.flagsSet).toContain('flag_bribed_guard');
      expect(r.flagsSet).not.toContain('MERCHANT_GUILD');
    });

    it('FAIL → flagsSet 비어있음', () => {
      const r = service.resolve(
        makeEvent({
          payload: {
            sceneFrame: '',
            choices: [],
            effectsOnEnter: [],
            tags: ['flag_secret_passed'],
          },
        }),
        makeIntent({ actionType: 'TALK' }),
        makeWorld(),
        makeStats({ cha: 0 }),
        makeRng([1]),
      );
      expect(r.flagsSet).toHaveLength(0);
    });
  });
});
