import { Injectable } from '@nestjs/common';
import { ContentLoaderService } from '../../content/content-loader.service.js';
import { Logger } from '@nestjs/common';
import type {
  EventDefV2,
  ParsedIntentV2,
  ResolveResult,
  ResolveOutcome,
  WorldState,
  PermanentStats,
  RunState,
} from '../../db/types/index.js';
import type { TraitEffects } from '../../content/content.types.js';
import type { Rng } from '../rng/rng.service.js';
import { SuddenActionDetectorService } from './sudden-action-detector.service.js';
import { QUEST_BALANCE } from './quest-balance.config.js';

const HEAT_DELTA_CLAMP = 8;
const MAX_COMBAT_PER_WINDOW = 3;

// [불변식 12 / D2 — arch/76] LOCATION 판정 임계 — 단일 정본. UI 부족분 표시에도 사용.
export const RESOLVE_SUCCESS_THRESHOLD = 5; // SUCCESS >= 5
export const RESOLVE_PARTIAL_THRESHOLD = 3; // PARTIAL 3~4, FAIL < 3

// 비도전(non-challenge) 행위: 주사위 판정 없이 자동 SUCCESS
const NON_CHALLENGE_ACTIONS = new Set([
  'MOVE_LOCATION',
  'REST',
  'SHOP',
  // Phase 4a: 장비 착용/해제는 주사위 판정 없음
  'EQUIP',
  'UNEQUIP',
]);

// actionType → 기본 6스탯 매핑 (Living World v2)
const ACTION_STAT_MAP: Record<string, keyof PermanentStats> = {
  FIGHT: 'str', // 힘: 전투/강탈
  THREATEN: 'str', // 힘: 협박/위협
  SNEAK: 'dex', // 민첩: 잠입/은밀
  STEAL: 'dex', // 민첩: 절도
  OBSERVE: 'per', // 통찰: 관찰/감시
  INVESTIGATE: 'wit', // 재치: 조사/분석
  SEARCH: 'wit', // 재치: 수색/탐색
  PERSUADE: 'cha', // 카리스마: 설득
  BRIBE: 'cha', // 카리스마: 뇌물
  TRADE: 'cha', // 카리스마: 거래
  TALK: 'cha', // 카리스마: 대화/설득
  HELP: 'con', // 체질: 도움/보호
};

@Injectable()
export class ResolveService {
  private readonly logger = new Logger(ResolveService.name);

  constructor(
    private readonly suddenActionDetector: SuddenActionDetectorService,
    private readonly content: ContentLoaderService,
  ) {}

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

    // 기본값 — 경제 루프 2026-07-11: fact 사례금(기본 5G)과의 균형상 config로 외부화
    if (outcome === 'SUCCESS') return -QUEST_BALANCE.BRIBE_DEFAULT_COST_SUCCESS;
    return -QUEST_BALANCE.BRIBE_DEFAULT_COST_PARTIAL; // PARTIAL
  }

  resolve(
    event: EventDefV2,
    intent: ParsedIntentV2,
    ws: WorldState,
    stats: PermanentStats,
    rng: Rng,
    activeSpecialEffects: string[] = [],
    presetActionBonuses?: Record<string, number>,
    npcFaction?: string | null,
    runState?: RunState,
    // [arch/76 D3] ChallengeClassifier 감정 결과 — 행동-특정 스탯/난이도.
    // nano 제안은 classifier에서 이미 검증됨(스탯 허용집합·난이도 clamp).
    appraisal?: { statHint?: string | null; difficultyMod?: number },
  ): ResolveResult {
    // 비도전 행위 → 주사위 없이 자동 SUCCESS
    if (NON_CHALLENGE_ACTIONS.has(intent.actionType)) {
      return this.buildAutoSuccess(event, intent);
    }

    // 1d6 주사위 (결정적 RNG)
    const diceRoll = rng.range(1, 6);

    // 그라데이션 스탯 보너스: floor(stat / 4) — 고스탯 과도 성공 방지
    // [arch/76 D3-①] statHint가 유효 스탯이면 actionType 기본 대신 사용.
    //   "벽을 타 넘는다"가 TALK로 분류돼도 dex로 판정 — 버킷 고정 해소.
    const statHintKey =
      appraisal?.statHint && appraisal.statHint in stats
        ? (appraisal.statHint as keyof PermanentStats)
        : null;
    const statKey = statHintKey ?? ACTION_STAT_MAP[intent.actionType];
    const statBonus = statKey ? Math.floor((stats[statKey] as number) / 4) : 0;

    // base modifier: matchPolicy + friction + riskLevel
    // [D2-b — arch/76] 각 기여원을 modifiers에 라벨과 함께 누적 (UI 판정 투명성).
    let baseMod = 0;
    const modifiers: Array<{ label: string; value: number }> = [];
    const addMod = (label: string, value: number) => {
      if (value === 0) return;
      baseMod += value;
      modifiers.push({ label, value });
    };
    if (event.matchPolicy === 'SUPPORT') addMod('지형 유리', 1);
    if (event.matchPolicy === 'BLOCK') addMod('지형 불리', -1);
    if (event.friction) addMod('소란', -event.friction);
    if (intent.riskLevel === 3) addMod('위험 감수', -1);
    // [arch/76 D3-②] 행동 과감함/규모 보정 (classifier clamp [-2,+2]).
    //   과감할수록 음수 → 어렵게. "왕을 반역시킨다" 같은 큰 시도가 실제로 어려워진다.
    if (appraisal?.difficultyMod)
      addMod('행동 난이도', appraisal.difficultyMod);

    // Phase 4c: PERSUADE_BRIBE_BONUS_1 세트 효과 — PERSUADE/BRIBE 판정 시 +1
    if (
      (intent.actionType === 'PERSUADE' || intent.actionType === 'BRIBE') &&
      activeSpecialEffects.includes('PERSUADE_BRIBE_BONUS_1')
    ) {
      addMod('언변 세트', 1);
    }

    // 프리셋별 actionType 보너스 — 배경 경험에 기반한 판정 보정 (+1 수준)
    if (presetActionBonuses && presetActionBonuses[intent.actionType]) {
      addMod('배경 경험', presetActionBonuses[intent.actionType]);
    }

    // Living World: 장소 활성 조건(activeConditions)에 의한 판정 보정
    const locState = ws.locationDynamicStates?.[
      ws.currentLocationId as string
    ] as
      | {
          activeConditions?: Array<{
            effects: { blockedActions?: string[]; boostedActions?: string[] };
          }>;
        }
      | undefined;
    if (locState?.activeConditions) {
      for (const cond of locState.activeConditions) {
        if (cond.effects.blockedActions?.includes(intent.actionType)) {
          addMod('장소 제약', -2); // 차단된 행동 → 심각한 패널티
        }
        if (cond.effects.boostedActions?.includes(intent.actionType)) {
          addMod('장소 이점', 1); // 유리한 행동 → 소폭 보너스
        }
      }
    }

    // Phase 4 특성 런타임 효과: BLOOD_OATH lowHpBonus + NIGHT_CHILD time bonus
    const traitEffects: TraitEffects | undefined = runState?.traitEffects;
    let traitBonus = 0;

    // BLOOD_OATH: HP 비율이 낮을수록 판정 보너스
    if (traitEffects?.lowHpBonus && runState) {
      const hpRatio = runState.maxHp > 0 ? runState.hp / runState.maxHp : 1;
      const { threshold50, threshold25 } = traitEffects.lowHpBonus;
      if (hpRatio <= 0.25) {
        traitBonus += threshold50 + threshold25; // +3
      } else if (hpRatio <= 0.5) {
        traitBonus += threshold50; // +2
      }
      if (traitBonus > 0) {
        this.logger.debug(
          `[Trait:BLOOD_OATH] HP ${runState.hp}/${runState.maxHp} (${(hpRatio * 100).toFixed(0)}%) -> lowHpBonus +${traitBonus}`,
        );
      }
    }

    // NIGHT_CHILD: 시간대에 따른 판정 보너스/패널티
    if (
      traitEffects &&
      (traitEffects.nightBonus != null || traitEffects.dayPenalty != null)
    ) {
      const timePhase = ws.phaseV2 ?? ws.timePhase;
      let timeBonus = 0;
      if (timePhase === 'NIGHT' || timePhase === 'DUSK') {
        timeBonus = traitEffects.nightBonus ?? 0;
      } else if (timePhase === 'DAY' || timePhase === 'DAWN') {
        timeBonus = traitEffects.dayPenalty ?? 0; // negative value
      }
      if (timeBonus !== 0) {
        traitBonus += timeBonus;
        this.logger.debug(
          `[Trait:NIGHT_CHILD] timePhase=${timePhase} -> timeBonus ${timeBonus > 0 ? '+' : ''}${timeBonus}`,
        );
      }
    }

    // 최종 점수
    const score = diceRoll + statBonus + baseMod + traitBonus;

    // 결과 판정: SUCCESS >= 5, PARTIAL 3~4, FAIL < 3
    let outcome = this.computeOutcome(score);

    // GAMBLER_LUCK: FAIL 판정 시 확률적 PARTIAL 승격
    let gamblerLuckTriggered = false;
    if (outcome === 'FAIL' && traitEffects?.failToPartialChance) {
      const luckRoll = rng.range(0, 99);
      if (luckRoll < traitEffects.failToPartialChance) {
        outcome = 'PARTIAL';
        gamblerLuckTriggered = true;
        this.logger.debug(
          `[Trait:GAMBLER_LUCK] FAIL->PARTIAL (roll=${luckRoll} < ${traitEffects.failToPartialChance}%)`,
        );
      }
    }

    // heatDelta 계산 (±8 clamp)
    let heatDelta = 0;
    if (outcome === 'SUCCESS')
      heatDelta = event.matchPolicy === 'BLOCK' ? 3 : 1;
    if (outcome === 'FAIL') heatDelta = event.matchPolicy === 'BLOCK' ? 5 : 2;
    if (intent.actionType === 'FIGHT' || intent.actionType === 'THREATEN')
      heatDelta += 2;

    // architecture/43: 돌발행동 감지 — severity별 heatDelta 상향
    const suddenAction = this.suddenActionDetector.detect(
      intent,
      intent.inputText ?? '',
    );
    if (suddenAction) {
      if (suddenAction.severity === 'CRITICAL') heatDelta += 6;
      else if (suddenAction.severity === 'SEVERE') heatDelta += 3;
      else if (suddenAction.severity === 'MODERATE') heatDelta += 1;
    }

    heatDelta = Math.max(
      -HEAT_DELTA_CLAMP,
      Math.min(HEAT_DELTA_CLAMP, heatDelta),
    );

    // 전투 트리거 체크
    // architecture/43: CRITICAL 돌발행동은 outcome 무관 combat 강제
    const baseTriggerCombat =
      outcome === 'FAIL' &&
      event.matchPolicy === 'BLOCK' &&
      ws.combatWindowCount < MAX_COMBAT_PER_WINDOW;
    const criticalForceCombat =
      suddenAction?.severity === 'CRITICAL' &&
      ws.combatWindowCount < MAX_COMBAT_PER_WINDOW;
    const triggerCombat = baseTriggerCombat || criticalForceCombat;

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
      if (tags.includes('destabilize'))
        agendaBucketDelta.destabilizeGuard = delta;
      if (tags.includes('merchant')) agendaBucketDelta.allyMerchant = delta;
      if (tags.includes('underworld'))
        agendaBucketDelta.empowerUnderworld = delta;
      if (tags.includes('corruption'))
        agendaBucketDelta.exposeCorruption = delta;
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

    // reputationChanges — 이벤트 태그 기반 세력 평판 변동 (PARTIAL도 소량 반영)
    const reputationChanges: Record<string, number> = {};
    if (
      tags.some((t) =>
        [
          'GUARD_ALLIANCE',
          'GUARD_PATROL',
          'CHECKPOINT',
          'ARMED_GUARD',
        ].includes(t),
      )
    ) {
      reputationChanges['CITY_GUARD'] =
        outcome === 'SUCCESS' ? 3 : outcome === 'FAIL' ? -2 : 1;
    }
    if (
      tags.some((t) =>
        ['MERCHANT_GUILD', 'LEDGER', 'MERCHANT_CONSORTIUM'].includes(t),
      )
    ) {
      reputationChanges['MERCHANT_CONSORTIUM'] =
        outcome === 'SUCCESS' ? 3 : outcome === 'FAIL' ? -2 : 1;
    }
    if (
      tags.some((t) =>
        ['LABOR_GUILD', 'WORKER_RIGHTS', 'DOCK_THUGS'].includes(t),
      )
    ) {
      reputationChanges['LABOR_GUILD'] =
        outcome === 'SUCCESS' ? 3 : outcome === 'FAIL' ? -2 : 1;
    }

    // NPC faction 기반 자동 평판 — 태그 없는 이벤트에서도 NPC 소속 세력에 소량 반영
    if (Object.keys(reputationChanges).length === 0 && npcFaction) {
      const factionDelta =
        outcome === 'SUCCESS' ? 2 : outcome === 'FAIL' ? -1 : 1;
      reputationChanges[npcFaction] = factionDelta;
    }

    return {
      score,
      outcome,
      diceRoll,
      statKey: statKey ?? null,
      statValue: statKey ? (stats[statKey] as number) : 0,
      statBonus,
      baseMod,
      modifiers: modifiers.length > 0 ? modifiers : undefined,
      traitBonus: traitBonus !== 0 ? traitBonus : undefined,
      gamblerLuckTriggered: gamblerLuckTriggered || undefined,
      eventId: event.eventId,
      heatDelta,
      tensionDelta: outcome === 'FAIL' ? 1 : 0,
      influenceDelta: outcome === 'SUCCESS' ? 1 : 0,
      goldDelta: this.computeGoldCost(
        intent.actionType,
        outcome,
        intent.specifiedGold,
      ),
      relationChanges,
      reputationChanges,
      flagsSet:
        outcome === 'SUCCESS'
          ? event.payload.tags.filter((t) => t.startsWith('flag_'))
          : [],
      deferredEffects,
      agendaBucketDelta,
      commitmentDelta,
      triggerCombat,
      combatEncounterId: triggerCombat
        ? this.selectCombatEncounter(event)
        : undefined,
      suddenAction: suddenAction ?? undefined,
    };
  }

  /**
   * 외부에서 자동 SUCCESS를 강제할 때 호출 (ChallengeClassifier가 FREE 판단한 경우 등).
   * 주사위 소비 없이 buildAutoSuccess와 동일 결과 반환.
   */
  forceAutoSuccess(event: EventDefV2, intent: ParsedIntentV2): ResolveResult {
    return this.buildAutoSuccess(event, intent);
  }

  /** 비도전 행위 자동 SUCCESS: 주사위 소비 없음, 최소 열기, 전투 트리거 없음 */
  private buildAutoSuccess(
    event: EventDefV2,
    _intent: ParsedIntentV2,
  ): ResolveResult {
    const tags = event.payload.tags;

    // 관계/평판은 SUCCESS 기준 적용
    const relationChanges: Record<string, number> = {};
    const npcId = event.payload.primaryNpcId;
    if (npcId) relationChanges[npcId] = 5;

    const reputationChanges: Record<string, number> = {};
    if (
      tags.some((t) =>
        [
          'GUARD_ALLIANCE',
          'GUARD_PATROL',
          'CHECKPOINT',
          'ARMED_GUARD',
        ].includes(t),
      )
    ) {
      reputationChanges['CITY_GUARD'] = 3;
    }
    if (
      tags.some((t) =>
        ['MERCHANT_GUILD', 'LEDGER', 'MERCHANT_CONSORTIUM'].includes(t),
      )
    ) {
      reputationChanges['MERCHANT_CONSORTIUM'] = 3;
    }
    if (
      tags.some((t) =>
        ['LABOR_GUILD', 'WORKER_RIGHTS', 'DOCK_THUGS'].includes(t),
      )
    ) {
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
    if (score >= RESOLVE_SUCCESS_THRESHOLD) return 'SUCCESS';
    if (score >= RESOLVE_PARTIAL_THRESHOLD) return 'PARTIAL';
    return 'FAIL';
  }

  private selectCombatEncounter(event: EventDefV2): string {
    // architecture/63: locations.json ambushEncounterId 파생 (fallback은 로더 단일 지점)
    return this.content.getAmbushEncounterId(event.locationId);
  }
}
