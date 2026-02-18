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

// actionType → 관련 스탯 매핑
const ACTION_STAT_MAP: Record<string, keyof PermanentStats> = {
  FIGHT: 'atk',
  SNEAK: 'eva',
  THREATEN: 'atk',
  PERSUADE: 'speed',
  INVESTIGATE: 'acc',
  OBSERVE: 'eva',
  STEAL: 'eva',
  BRIBE: 'speed',
  HELP: 'def',
  TRADE: 'speed',
};

@Injectable()
export class ResolveService {
  resolve(
    event: EventDefV2,
    intent: ParsedIntentV2,
    ws: WorldState,
    stats: PermanentStats,
    rng: Rng,
  ): ResolveResult {
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

    // 최종 점수
    const score = diceRoll + statBonus + baseMod;

    // 결과 판정: SUCCESS >= 6, PARTIAL 3~5, FAIL < 3
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
      eventId: event.eventId,
      heatDelta,
      tensionDelta: outcome === 'FAIL' ? 1 : 0,
      influenceDelta: outcome === 'SUCCESS' ? 1 : 0,
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

  private computeOutcome(score: number): ResolveOutcome {
    if (score >= 6) return 'SUCCESS';
    if (score >= 3) return 'PARTIAL';
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
