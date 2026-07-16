// [P5 — architecture/75 §6] AUTONOMOUS 런 종결 판정 + 규명율 엔딩 (순수 모듈).
//
// AUTHORED 팩은 checkEndingConditions(Incident resolved)로 종결하지만, AUTONOMOUS는
// 진상이 런타임 생성이라 종결 축이 다르다:
//   ① acts.turnBudget 총합 소진(3막 완주)  ② packMeter 임계(게이지 클라이맥스)
//   — 둘 다 최소 15턴 가드(불변식 19). 규명율 = 발견 keyFacts / 전체.
// 순수 함수만 — autonomous-ending.spec 대상.

import type { PlotSeed, PlotProgress } from '../../db/types/plot-seed.js';

/** AUTONOMOUS 종결 사유 — generateEnding endingReason 확장. */
export type AutonomousEndReason = 'AUTONOMOUS_ACTS' | 'AUTONOMOUS_GAUGE';

/** 최소 종결 턴 (불변식 19 — NATURAL 최소 15턴). */
export const MIN_AUTONOMOUS_END_TURNS = 15;

/** 규명율 구간 임계. */
export const CLEARANCE_HIGH = 0.7;
export const CLEARANCE_LOW = 0.3;

/** 규명율 = 발견 keyFacts / 전체 keyFacts (0~1). 전체 0이면 0. */
export function computeClearanceRate(
  seed: PlotSeed,
  progress: PlotProgress | undefined,
): number {
  const total = seed.keyFacts.length;
  if (total === 0) return 0;
  const found = new Set(progress?.discoveredKeyFactIds ?? []);
  const validFound = seed.keyFacts.filter((f) => found.has(f.factId)).length;
  return validFound / total;
}

export type ClearanceBand = 'HIGH' | 'MID' | 'LOW';

export function clearanceBand(rate: number): ClearanceBand {
  if (rate >= CLEARANCE_HIGH) return 'HIGH';
  if (rate >= CLEARANCE_LOW) return 'MID';
  return 'LOW';
}

export interface AutonomousEndCheck {
  shouldEnd: boolean;
  reason: AutonomousEndReason | null;
}

/**
 * AUTONOMOUS 종결 판정.
 * - totalTurns < 15 → 종결 금지(불변식 19)
 * - 게이지 임계 도달(gaugeCritical) → 잔여 예산 무관 클라이맥스 (§6 "세계가 기다려주지 않는다")
 * - acts.turnBudget 총합 소진 → 3막 완주 종결
 */
export function checkAutonomousEnding(args: {
  seed: PlotSeed;
  totalTurns: number;
  /** packMeter가 endingTrigger 임계를 넘었는지 (게이지 클라이맥스) */
  gaugeCritical: boolean;
}): AutonomousEndCheck {
  const { seed, totalTurns, gaugeCritical } = args;
  if (totalTurns < MIN_AUTONOMOUS_END_TURNS) {
    return { shouldEnd: false, reason: null };
  }
  if (gaugeCritical) {
    return { shouldEnd: true, reason: 'AUTONOMOUS_GAUGE' };
  }
  const actsBudget = (seed.acts ?? []).reduce(
    (s, a) => s + (a.turnBudget || 0),
    0,
  );
  if (actsBudget > 0 && totalTurns >= actsBudget) {
    return { shouldEnd: true, reason: 'AUTONOMOUS_ACTS' };
  }
  return { shouldEnd: false, reason: null };
}

/** 규명율×게이지 → 엔딩 톤. endingTones 팩 계약(scenario.json)에서 선택. */
export interface EndingToneEntry {
  /** 엔딩 유형 식별자 (prompt-builder 톤 매핑·아카이브용) */
  endingType: string;
  /** 서술 톤 가이드 (LLM 주입 — 추상, 예시 어구 금지) */
  tone: string;
}

/** 팩 계약: 규명율 구간별 톤 + 게이지 붕괴 시 오버레이. */
export interface EndingTonesConfig {
  HIGH?: EndingToneEntry;
  MID?: EndingToneEntry;
  LOW?: EndingToneEntry;
  /** 게이지 임계 종결 시 추가 붕괴 뉘앙스 (선택) */
  gaugeCollapse?: EndingToneEntry;
}

const NEUTRAL_TONE: Record<ClearanceBand, EndingToneEntry> = {
  HIGH: {
    endingType: 'TRUTH_REVEALED',
    tone: '사건의 전모가 드러났다. 진실을 밝힌 자로 기록된다.',
  },
  MID: {
    endingType: 'PARTIAL_TRUTH',
    tone: '절반의 진실만 드러났고, 남은 의문이 뒤에 남았다.',
  },
  LOW: {
    endingType: 'UNRESOLVED',
    tone: '진실은 어둠에 묻힌 채 미제로 남았다. 당신은 떠난다.',
  },
};

/**
 * 엔딩 톤 선택 — endingTones 팩 계약 우선, 없으면 팩 중립 fallback.
 * 게이지 종결이면 gaugeCollapse 오버레이가 있으면 그것으로 교체.
 */
export function selectEndingTone(
  band: ClearanceBand,
  gaugeEnd: boolean,
  tones: EndingTonesConfig | undefined,
): EndingToneEntry {
  if (gaugeEnd && tones?.gaugeCollapse) return tones.gaugeCollapse;
  return tones?.[band] ?? NEUTRAL_TONE[band];
}
