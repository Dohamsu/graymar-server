// [P2 — architecture/73 B1] 팩 세계축 게이지 로직 (순수 함수).
//
// 추가형: Heat와 병존하는 팩 선언 미터. 상태를 갖지 않는 순수 계산이라
// 서비스 없이 turns 파이프라인/createRun에서 직접 호출한다.

import type {
  PackMeterDef,
  PackMeterThreshold,
} from '../../db/types/pack-meter.js';

const clamp = (v: number): number => Math.max(0, Math.min(100, v));

export interface PackMeterUIItem {
  id: string;
  name: string;
  value: number;
  max: number;
  warnAt?: number;
}

/** [P2] 클라 HUD용 미터 배열 조립 (값 + 표시명 + 경고 임계). 미선언 시 빈 배열. */
export function buildPackMetersUI(
  current: Record<string, number> | undefined,
  defs: PackMeterDef[] | undefined,
): PackMeterUIItem[] {
  if (!defs || defs.length === 0) return [];
  return defs.map((d) => ({
    id: d.id,
    name: d.name,
    value: current?.[d.id] ?? clamp(d.initial ?? 0),
    max: 100,
    warnAt:
      d.thresholds && d.thresholds.length > 0 ? d.thresholds[0].at : undefined,
  }));
}

/** 팩 미터 초기값 맵 생성 (createRun). 미선언 시 빈 객체. */
export function initPackMeters(defs?: PackMeterDef[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const d of defs ?? []) out[d.id] = clamp(d.initial ?? 0);
  return out;
}

export interface MeterCross {
  id: string;
  name: string;
  value: number;
  threshold: PackMeterThreshold;
}

/**
 * 매 턴 미터 틱: perTurnDelta 적용(maxDeltaPerTurn clamp, 0~100 clamp) +
 * 상승 교차한 임계 수집. 원본 불변(새 맵 반환).
 */
export function tickPackMeters(
  current: Record<string, number> | undefined,
  defs: PackMeterDef[] | undefined,
  timeCost = 1,
): { next: Record<string, number>; crossed: MeterCross[] } {
  const next: Record<string, number> = { ...(current ?? {}) };
  const crossed: MeterCross[] = [];
  for (const d of defs ?? []) {
    const before = next[d.id] ?? clamp(d.initial ?? 0);
    let delta = (d.perTurnDelta ?? 0) * timeCost;
    if (d.maxDeltaPerTurn != null) {
      const cap = Math.abs(d.maxDeltaPerTurn);
      delta = Math.max(-cap, Math.min(cap, delta));
    }
    const after = clamp(before + delta);
    next[d.id] = after;
    for (const th of d.thresholds ?? []) {
      if (before < th.at && after >= th.at) {
        crossed.push({ id: d.id, name: d.name, value: after, threshold: th });
      }
    }
  }
  return { next, crossed };
}
