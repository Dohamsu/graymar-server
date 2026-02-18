import { Injectable } from '@nestjs/common';
import type { ArcState, ArcRoute, WorldState } from '../../db/types/index.js';

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
      betrayalCount: arc.currentRoute !== null ? arc.betrayalCount + 1 : arc.betrayalCount,
      commitment: 0,
    };
  }

  isLocked(arc: ArcState): boolean {
    return arc.commitment >= COMMITMENT_LOCK;
  }

  checkUnlockConditions(ws: WorldState): string[] {
    const newUnlocks: string[] = [];

    // Heat 40+ → EXPOSE_CORRUPTION unlock
    if (
      ws.hubHeat >= 40 &&
      !ws.mainArc.unlockedArcIds.includes('EXPOSE_CORRUPTION')
    ) {
      newUnlocks.push('EXPOSE_CORRUPTION');
    }

    // tension 5+ → PROFIT_FROM_CHAOS unlock
    if (
      ws.tension >= 5 &&
      !ws.mainArc.unlockedArcIds.includes('PROFIT_FROM_CHAOS')
    ) {
      newUnlocks.push('PROFIT_FROM_CHAOS');
    }

    // flags.guard_trust → ALLY_GUARD unlock
    if (
      ws.flags['guard_trust'] &&
      !ws.mainArc.unlockedArcIds.includes('ALLY_GUARD')
    ) {
      newUnlocks.push('ALLY_GUARD');
    }

    return newUnlocks;
  }
}
