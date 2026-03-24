import { Injectable } from '@nestjs/common';
import type {
  EventDefV2,
  ParsedIntentV2,
  ResolveResult,
  ResolveOutcome,
  WorldState,
  PermanentStats,
} from '../../db/types/index.js';
import type { Rng } from '../rng/rng.service.js';

const HEAT_DELTA_CLAMP = 8;
const MAX_COMBAT_PER_WINDOW = 3;

// 비도전(non-challenge) 행위: 주사위 판정 없이 자동 SUCCESS
const NON_CHALLENGE_ACTIONS = new Set([
  'MOVE_LOCATION',
  'REST',
  'SHOP',
  'TALK',
  // Phase 4a: 장비 착용/해제는 주사위 판정 없음
  'EQUIP',
  'UNEQUIP',
]);

// actionType → 기본 6스탯 매핑 (Living World v2)
const ACTION_STAT_MAP: Record<string, keyof PermanentStats> = {
  FIGHT: 'str',       // 힘: 전투/강탈
  THREATEN: 'str',    // 힘: 협박/위협
  SNEAK: 'dex',       // 민첩: 잠입/은밀
  STEAL: 'dex',       // 민첩: 절도
  OBSERVE: 'per',     // 통찰: 관찰/감시
  INVESTIGATE: 'wit', // 재치: 조사/분석
  SEARCH: 'wit',      // 재치: 수색/탐색
  PERSUADE: 'cha',    // 카리스마: 설득
  BRIBE: 'cha',       // 카리스마: 뇌물
  TRADE: 'cha',       // 카리스마: 거래
  HELP: 'con',        // 체질: 도움/보호
};

@Injectable()
export class ResolveService {
  /**
   * BRIBE/TRADE 골드 비용 계산
   * - specifiedGold가 있으면 플레이어가 명시한 수치 사용
   * - 없으면 기본값 (SUCCESS: 5, PARTIAL: 3)
   * - FAIL: 거래 불성사 → 비용 0
   */
  private computeGoldCost(
    actionType: string,
    outcome: string,
    specifiedGold?: number,
  ): number {
    if (actionType !== 'BRIBE' && actionType !== 'TRADE') return 0;
    if (outcome === 'FAIL') return 0; // 거래 성사 안됨 → 비용 없음

    if (specifiedGold != null && specifiedGold > 0) {
      // 플레이어 명시 금액: SUCCESS면 전액, PARTIAL이면 60% (흥정 실패)
      if (outcome === 'SUCCESS') return -specifiedGold;
      return -Math.ceil(specifiedGold * 0.6);
    }

    // 기본값 (골드 밸런스 조정: LOCATION 보상과 균형)
    if (outcome === 'SUCCESS') return -3;
    return -2; // PARTIAL
  }

  resolve(
    event: EventDefV2,
    intent: ParsedIntentV2,
    ws: WorldState,
    stats: PermanentStats,
    rng: Rng,
    activeSpecialEffects: string[] = [],
  ): ResolveResult {
    // 비도전 행위 → 주사위 없이 자동 SUCCESS
    if (NON_CHALLENGE_ACTIONS.has(intent.actionType)) {
      return this.buildAutoSuccess(event, intent);
    }

    // 1d6 주사위 (결정적 RNG)
    const diceRoll = rng.range(1, 6);

    // 그라데이션 스탯 보너스: floor(stat / 3)
    const statKey = ACTION_STAT_MAP[intent.actionType];
    const statBonus = statKey ? Math.floor((stats[statKey] as number) / 3) : 0;

    // base modifier: matchPolicy + friction + riskLevel
    let baseMod = 0;
    if (event.matchPolicy === 'SUPPORT') baseMod += 1;
    if (event.matchPolicy === 'BLOCK') baseMod -= 1;
    baseMod -= event.friction;
    if (intent.riskLevel === 3) baseMod -= 1;

    // Phase 4c: PERSUADE_BRIBE_BONUS_1 세트 효과 — PERSUADE/BRIBE 판정 시 +1
    if (
      (intent.actionType === 'PERSUADE' || intent.actionType === 'BRIBE') &&
      activeSpecialEffects.includes('PERSUADE_BRIBE_BONUS_1')
    ) {
      baseMod += 1;
    }

    // 최종 점수
    const score = diceRoll + statBonus + baseMod;

    // 결과 판정: SUCCESS >= 7, PARTIAL 4~6, FAIL < 4
    const outcome = this.computeOutcome(score);

    // heatDelta 계산 (±8 clamp)
    let heatDelta = 0;
    if (outcome === 'SUCCESS') heatDelta = event.matchPolicy === 'BLOCK' ? 3 : 1;
    if (outcome === 'FAIL') heatDelta = event.matchPolicy === 'BLOCK' ? 5 : 2;
    if (intent.actionType === 'FIGHT' || intent.actionType === 'THREATEN')
      heatDelta += 2;
    heatDelta = Math.max(-HEAT_DELTA_CLAMP, Math.min(HEAT_DELTA_CLAMP, heatDelta));

    // 전투 트리거 체크
    const triggerCombat =
      outcome === 'FAIL' &&
      event.matchPolicy === 'BLOCK' &&
      ws.combatWindowCount < MAX_COMBAT_PER_WINDOW;

    // commitment delta
    const commitmentDelta =
      outcome === 'SUCCESS' && event.commitmentDeltaOnSuccess
        ? event.commitmentDeltaOnSuccess
        : 0;

    // Deferred effects (LIE/THREATEN → delayed consequence)
    const deferredEffects: ResolveResult['deferredEffects'] = [];
    if (
      (intent.actionType === 'THREATEN' || intent.tone === 'DECEPTIVE') &&
      outcome === 'SUCCESS'
    ) {
      deferredEffects.push({
        id: `deferred_${event.eventId}_${Date.now()}`,
        type: 'REPUTATION_BACKLASH',
        triggerTurnDelay: 3,
        data: {
          eventId: event.eventId,
          actionType: intent.actionType,
          severity: intent.riskLevel,
        },
      });
    }

    // agendaBucketDelta
    const agendaBucketDelta: Record<string, number> = {};
    const tags = event.payload.tags;
    const delta = outcome === 'SUCCESS' ? 2 : outcome === 'PARTIAL' ? 1 : 0;
    if (delta > 0) {
      if (tags.includes('destabilize')) agendaBucketDelta.destabilizeGuard = delta;
      if (tags.includes('merchant')) agendaBucketDelta.allyMerchant = delta;
      if (tags.includes('underworld')) agendaBucketDelta.empowerUnderworld = delta;
      if (tags.includes('corruption')) agendaBucketDelta.exposeCorruption = delta;
      if (tags.includes('chaos')) agendaBucketDelta.profitFromChaos = delta;
    }

    // relationChanges
    const relationChanges: Record<string, number> = {};
    const npcId = event.payload.primaryNpcId;
    if (npcId) {
      if (outcome === 'SUCCESS') relationChanges[npcId] = 5;
      else if (outcome === 'PARTIAL') relationChanges[npcId] = 2;
      else relationChanges[npcId] = -3;
    }

    // reputationChanges — 이벤트 태그 기반 세력 평판 변동
    const reputationChanges: Record<string, number> = {};
    if (tags.some((t) => ['GUARD_ALLIANCE', 'GUARD_PATROL', 'CHECKPOINT', 'ARMED_GUARD'].includes(t))) {
      reputationChanges['CITY_GUARD'] = outcome === 'SUCCESS' ? 3 : outcome === 'FAIL' ? -2 : 0;
    }
    if (tags.some((t) => ['MERCHANT_GUILD', 'LEDGER', 'MERCHANT_CONSORTIUM'].includes(t))) {
      reputationChanges['MERCHANT_CONSORTIUM'] = outcome === 'SUCCESS' ? 3 : outcome === 'FAIL' ? -2 : 0;
    }
    if (tags.some((t) => ['LABOR_GUILD', 'WORKER_RIGHTS', 'DOCK_THUGS'].includes(t))) {
      reputationChanges['LABOR_GUILD'] = outcome === 'SUCCESS' ? 3 : outcome === 'FAIL' ? -2 : 0;
    }

    return {
      score,
      outcome,
      diceRoll,
      statKey: statKey ?? null,
      statValue: statKey ? (stats[statKey] as number) : 0,
      statBonus,
      baseMod,
      eventId: event.eventId,
      heatDelta,
      tensionDelta: outcome === 'FAIL' ? 1 : 0,
      influenceDelta: outcome === 'SUCCESS' ? 1 : 0,
      goldDelta: this.computeGoldCost(intent.actionType, outcome, intent.specifiedGold),
      relationChanges,
      reputationChanges,
      flagsSet: outcome === 'SUCCESS' ? event.payload.tags.filter((t) => t.startsWith('flag_')) : [],
      deferredEffects,
      agendaBucketDelta,
      commitmentDelta,
      triggerCombat,
      combatEncounterId: triggerCombat
        ? this.selectCombatEncounter(event)
        : undefined,
    };
  }

  /** 비도전 행위 자동 SUCCESS: 주사위 소비 없음, 최소 열기, 전투 트리거 없음 */
  private buildAutoSuccess(event: EventDefV2, intent: ParsedIntentV2): ResolveResult {
    const tags = event.payload.tags;

    // 관계/평판은 SUCCESS 기준 적용
    const relationChanges: Record<string, number> = {};
    const npcId = event.payload.primaryNpcId;
    if (npcId) relationChanges[npcId] = 5;

    const reputationChanges: Record<string, number> = {};
    if (tags.some((t) => ['GUARD_ALLIANCE', 'GUARD_PATROL', 'CHECKPOINT', 'ARMED_GUARD'].includes(t))) {
      reputationChanges['CITY_GUARD'] = 3;
    }
    if (tags.some((t) => ['MERCHANT_GUILD', 'LEDGER', 'MERCHANT_CONSORTIUM'].includes(t))) {
      reputationChanges['MERCHANT_CONSORTIUM'] = 3;
    }
    if (tags.some((t) => ['LABOR_GUILD', 'WORKER_RIGHTS', 'DOCK_THUGS'].includes(t))) {
      reputationChanges['LABOR_GUILD'] = 3;
    }

    const agendaBucketDelta: Record<string, number> = {};
    if (tags.includes('destabilize')) agendaBucketDelta.destabilizeGuard = 2;
    if (tags.includes('merchant')) agendaBucketDelta.allyMerchant = 2;
    if (tags.includes('underworld')) agendaBucketDelta.empowerUnderworld = 2;
    if (tags.includes('corruption')) agendaBucketDelta.exposeCorruption = 2;
    if (tags.includes('chaos')) agendaBucketDelta.profitFromChaos = 2;

    return {
      score: 8, // 자동 SUCCESS 임계값
      outcome: 'SUCCESS',
      eventId: event.eventId,
      heatDelta: 0, // 비도전 행위는 열기를 올리지 않음
      tensionDelta: 0,
      influenceDelta: 1,
      goldDelta: 0,
      relationChanges,
      reputationChanges,
      flagsSet: event.payload.tags.filter((t) => t.startsWith('flag_')),
      deferredEffects: [],
      agendaBucketDelta,
      commitmentDelta: event.commitmentDeltaOnSuccess ?? 0,
      triggerCombat: false,
    };
  }

  private computeOutcome(score: number): ResolveOutcome {
    if (score >= 7) return 'SUCCESS';
    if (score >= 4) return 'PARTIAL';
    return 'FAIL';
  }

  private selectCombatEncounter(event: EventDefV2): string {
    // AMBUSH 이벤트의 기본 encounter, 나중에 콘텐츠 기반으로 확장
    const locationEncounters: Record<string, string> = {
      LOC_MARKET: 'enc_market_thugs',
      LOC_GUARD: 'enc_guard_ambush',
      LOC_HARBOR: 'enc_harbor_pirates',
      LOC_SLUMS: 'enc_slum_gang',
    };
    return locationEncounters[event.locationId] ?? 'enc_generic';
  }
}
