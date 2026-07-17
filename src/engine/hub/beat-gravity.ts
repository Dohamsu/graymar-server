// [P4 — architecture/75 §5.1] Emergent Director 인력(gravity)·비트 채택 순수 모듈.
//
// 워커가 선계산한 BeatCandidate를 다음 턴 동기 경로에서 채택할지 결정한다.
// - 인력: 현재 장소·플레이어 타겟 NPC·미발견 keyFact·막 잔여 예산에 비례 가중.
// - 채택 임계 미달/stale 후보는 폐기 → 기존 폴백 체인(SitGen→EventDirector→Procedural).
// 순수 함수만 — 유닛 테스트 대상(beat-gravity.spec.ts).

import type {
  BeatCandidate,
  KeyFact,
  NextBeats,
  PlotAct,
  PlotProgress,
  PlotSeed,
} from '../../db/types/plot-seed.js';
import { AUTONOMOUS_BALANCE } from './quest-balance.config.js';

/** 막 진행 — plotSeed.acts 누적 예산과 현재 턴으로 파생(별도 상태 없음). */
export interface ActProgress {
  /** 현재 막 번호 (acts[].no — 예산 총합 초과 시 마지막 막) */
  currentAct: number;
  goal: string;
  /** 현재 막에서 소진한 턴 수 */
  turnsUsedInAct: number;
  /** 현재 막 잔여 턴 (음수 없음 — 소진 시 0) */
  turnsRemainingInAct: number;
  /** 현재 막 예산 */
  actBudget: number;
}

/**
 * 턴 번호 → 막 진행 파생. acts가 비면 단일 막(예산 15)으로 간주.
 * turnNo는 1부터 시작하는 런 전체 턴 번호.
 */
export function getActProgress(
  acts: PlotAct[] | undefined,
  turnNo: number,
): ActProgress {
  const list =
    acts && acts.length > 0
      ? acts
      : [{ no: 1, turnBudget: 15, goal: '사건 규명' }];
  let cumulative = 0;
  for (const act of list) {
    const start = cumulative; // 이 막이 시작되는 직전 누적 턴
    cumulative += act.turnBudget;
    if (turnNo <= cumulative) {
      const used = turnNo - start;
      return {
        currentAct: act.no,
        goal: act.goal,
        turnsUsedInAct: used,
        turnsRemainingInAct: Math.max(0, act.turnBudget - used),
        actBudget: act.turnBudget,
      };
    }
  }
  // 예산 총합 초과 — 마지막 막에 머무름 (종결은 P5 파이프 몫)
  const last = list[list.length - 1];
  return {
    currentAct: last.no,
    goal: last.goal,
    turnsUsedInAct: last.turnBudget,
    turnsRemainingInAct: 0,
    actBudget: last.turnBudget,
  };
}

/** 미발견 keyFacts — 규명율 분모에서 분자를 뺀 것 (인력의 표적). */
export function getUndiscoveredKeyFacts(
  seed: PlotSeed,
  progress: PlotProgress | undefined,
): KeyFact[] {
  const discovered = new Set(progress?.discoveredKeyFactIds ?? []);
  return seed.keyFacts.filter((f) => !discovered.has(f.factId));
}

/** 비트 채택 정합 판단 컨텍스트 — 턴 동기 경로에서 조립. */
export interface BeatAdoptionContext {
  turnNo: number;
  locationId: string;
  actionType: string;
  /** 플레이어가 지목한 NPC (있으면 비트 인물 일치 가중) */
  targetNpcId?: string | null;
  /** 직전 턴 primary NPC (약한 연결 가중) */
  lastPrimaryNpcId?: string | null;
  /** 미발견 keyFact id 집합 */
  undiscoveredFactIds: ReadonlySet<string>;
  /** 막 진행 (getActProgress 산출) */
  actProgress: ActProgress;
  /**
   * [버그 d20c1de8 — 불변식 47 확장] 연속 상호작용 필수 NPC. 플레이어가 직전
   * 턴과 같은 NPC와 상호작용을 잇는 중(사교든 폭력이든, contextNpcId)이면,
   * 이 NPC를 포함하지 않는 비트는 채택하지 않는다 — 채택 비트가 화자를
   * 가로채 "구타 대상이 관리로 스왑"되던 실측 결함 차단. 의도 존중은
   * 대화가 아니라 상호작용 단위다.
   */
  requiredNpcId?: string | null;
}

/**
 * 비트 후보 1개의 정합 점수. 음수 = 하드 불채택(장소 불일치).
 *
 * 인력 규칙(§5.1): 장소 일치 + NPC 일치 + 미발견 fact 힌트 + 막 압박(잔여
 * 예산 소진 비례 — fact 힌트 비트에만 적용해 규명 쪽으로 끌어당긴다).
 */
export function scoreBeatCandidate(
  beat: BeatCandidate,
  ctx: BeatAdoptionContext,
): number {
  const B = AUTONOMOUS_BALANCE;

  // 장소 구속 비트는 그 장소에서만 성립
  if (beat.locationId && beat.locationId !== ctx.locationId) return -1;

  let score = 0;
  if (beat.locationId === ctx.locationId) score += B.GRAVITY_LOCATION_BONUS;

  // 행동 계열 정합 (affordances 미지정 = 행동 무관 비트, 보너스 없음)
  if (beat.affordances?.includes(ctx.actionType)) {
    score += B.GRAVITY_AFFORDANCE_BONUS;
  }

  // 인물 정합 — 플레이어 타겟 일치가 최대, 직전 상호작용은 절반
  if (ctx.targetNpcId && beat.involvedNpcIds.includes(ctx.targetNpcId)) {
    score += B.GRAVITY_NPC_BONUS;
  } else if (
    ctx.lastPrimaryNpcId &&
    beat.involvedNpcIds.includes(ctx.lastPrimaryNpcId)
  ) {
    score += Math.floor(B.GRAVITY_NPC_BONUS / 2);
  }

  // 미발견 keyFact 힌트 + 막 압박 인력
  if (beat.hintedFactId && ctx.undiscoveredFactIds.has(beat.hintedFactId)) {
    score += B.GRAVITY_FACT_BONUS;
    const { actBudget, turnsRemainingInAct } = ctx.actProgress;
    if (actBudget > 0) {
      const consumedRatio = 1 - turnsRemainingInAct / actBudget;
      score += Math.round(consumedRatio * B.GRAVITY_ACT_PRESSURE_MAX);
    }
  }

  return score;
}

export interface BeatAdoptionResult {
  beat: BeatCandidate;
  score: number;
}

/**
 * [D1-c — arch/76] 채택 비트의 의도 정합 여부 (계측 전용 — 채택 결정에 무영향).
 * true = 비트 affordance가 플레이어 행동 계열과 일치,
 * false = affordance가 지정됐으나 불일치,
 * null = 행동 무관 비트(affordances 미지정 — 정합률 분모에서 제외).
 */
export function isBeatIntentAligned(
  beat: BeatCandidate,
  actionType: string,
): boolean | null {
  if (!beat.affordances || beat.affordances.length === 0) return null;
  return beat.affordances.includes(actionType);
}

/**
 * 저장된 선계산 묶음에서 채택할 비트 선택.
 * - stale(생성 후 BEAT_STALE_MAX_TURNS 초과) → 전체 폐기(null)
 * - 최고 점수가 BEAT_ADOPT_MIN_SCORE 미만 → 폐기(null)
 * null 반환 = 기존 폴백 체인으로 그 턴 진행 (불변식 C — 디렉터 재호출 금지).
 */
export function selectBeatForAdoption(
  nextBeats: NextBeats | null | undefined,
  ctx: BeatAdoptionContext,
): BeatAdoptionResult | null {
  if (!nextBeats || nextBeats.candidates.length === 0) return null;
  const age = ctx.turnNo - nextBeats.generatedAtTurn;
  if (age < 1 || age > AUTONOMOUS_BALANCE.BEAT_STALE_MAX_TURNS) return null;

  let best: BeatAdoptionResult | null = null;
  for (const beat of nextBeats.candidates) {
    // [불변식 47 확장] 연속 상호작용 중 — 그 NPC 무관 비트는 하드 불채택.
    if (ctx.requiredNpcId && !beat.involvedNpcIds.includes(ctx.requiredNpcId)) {
      continue;
    }
    const score = scoreBeatCandidate(beat, ctx);
    if (score < 0) continue;
    if (!best || score > best.score) best = { beat, score };
  }
  if (!best || best.score < AUTONOMOUS_BALANCE.BEAT_ADOPT_MIN_SCORE) {
    return null;
  }
  return best;
}
