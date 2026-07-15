import { Injectable } from '@nestjs/common';
import type {
  ArcState,
  ArcRoute,
  WorldState,
  ArcRouteUnlockDef,
} from '../../db/types/index.js';

const COMMITMENT_LOCK = 3;
const MAX_BETRAYALS = 2;

@Injectable()
export class ArcService {
  initArcState(): ArcState {
    return {
      currentRoute: null,
      commitment: 0,
      betrayalCount: 0,
    };
  }

  canSwitchRoute(arc: ArcState): boolean {
    return arc.commitment <= 2 && arc.betrayalCount < MAX_BETRAYALS;
  }

  progressCommitment(arc: ArcState, delta: number): ArcState {
    const newCommitment = Math.min(
      COMMITMENT_LOCK,
      Math.max(0, arc.commitment + delta),
    );
    return { ...arc, commitment: newCommitment };
  }

  switchRoute(arc: ArcState, newRoute: ArcRoute): ArcState {
    if (!this.canSwitchRoute(arc)) return arc;
    return {
      ...arc,
      currentRoute: newRoute,
      betrayalCount:
        arc.currentRoute !== null ? arc.betrayalCount + 1 : arc.betrayalCount,
      commitment: 0,
    };
  }

  isLocked(arc: ArcState): boolean {
    return arc.commitment >= COMMITMENT_LOCK;
  }

  /**
   * [73 §11 B2] 팩 선언(scenario.json arcRoutes)의 언락 조건으로 아크 루트 언락.
   * 엔진 하드코딩(Heat 40/tension 5/guard_trust) 제거 — 밸런스는 콘텐츠로(불변식 45).
   * 미선언 팩(arcRoutes 빈 배열)은 언락 0 — 아크 자산 없는 팩의 기존 동작.
   */
  checkUnlockConditions(
    ws: WorldState,
    arcRoutes: ArcRouteUnlockDef[] = [],
  ): string[] {
    const newUnlocks: string[] = [];
    for (const route of arcRoutes) {
      if (ws.mainArc.unlockedArcIds.includes(route.id)) continue;
      if (this.evalUnlock(ws, route.unlock)) newUnlocks.push(route.id);
    }
    return newUnlocks;
  }

  /** 언락 조건 1건 평가 — field(점표기)를 ws에서 해석 후 op 비교. */
  private evalUnlock(
    ws: WorldState,
    unlock: ArcRouteUnlockDef['unlock'],
  ): boolean {
    const val = this.resolveField(ws, unlock.field);
    switch (unlock.op) {
      case 'truthy':
        return !!val;
      case 'gte':
        return typeof val === 'number' && val >= Number(unlock.value ?? 0);
      case 'lte':
        return typeof val === 'number' && val <= Number(unlock.value ?? 0);
      case 'eq':
        return val === unlock.value;
      default:
        return false;
    }
  }

  /** WorldState 점표기 경로 해석 ('hubHeat' | 'flags.guard_trust' 등). */
  private resolveField(ws: WorldState, field: string): unknown {
    const parts = field.split('.');
    let obj: unknown = ws;
    for (const p of parts) {
      if (obj == null || typeof obj !== 'object') return undefined;
      obj = (obj as Record<string, unknown>)[p];
    }
    return obj;
  }
}
