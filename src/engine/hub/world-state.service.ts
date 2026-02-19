import { Injectable } from '@nestjs/common';
import type {
  WorldState,
  TimePhase,
  HubSafety,
  DeferredEffect,
} from '../../db/types/index.js';

const TIME_CYCLE_TURNS = 5;
const HEAT_DECAY_ON_HUB_RETURN = 5;
const MAX_HEAT = 100;
const MIN_HEAT = 0;

@Injectable()
export class WorldStateService {
  initWorldState(): WorldState {
    return {
      currentLocationId: null,
      timePhase: 'DAY',
      timeCounter: 0,
      hubHeat: 0,
      hubSafety: 'SAFE',
      hubHeatReasons: [],
      tension: 0,
      mainArc: {
        unlockedArcIds: [],
        completedArcIds: [],
      },
      reputation: { CITY_GUARD: 0, MERCHANT_CONSORTIUM: 0, LABOR_GUILD: 0 },
      flags: {},
      deferredEffects: [],
      combatWindowCount: 0,
      combatWindowStart: 0,
      locationStates: {
        LOC_MARKET: { security: 60, crime: 30, unrest: 20, spotlight: false },
        LOC_GUARD: { security: 80, crime: 10, unrest: 10, spotlight: false },
        LOC_HARBOR: { security: 40, crime: 50, unrest: 40, spotlight: false },
        LOC_SLUMS: { security: 20, crime: 70, unrest: 60, spotlight: false },
      },
      incidentFlags: {},
    };
  }

  moveToLocation(ws: WorldState, locationId: string): WorldState {
    return { ...ws, currentLocationId: locationId };
  }

  returnToHub(ws: WorldState): WorldState {
    const newHeat = this.clampHeatValue(ws.hubHeat - HEAT_DECAY_ON_HUB_RETURN);
    return {
      ...ws,
      currentLocationId: null,
      hubHeat: newHeat,
      hubSafety: this.computeSafety(newHeat),
    };
  }

  advanceTime(ws: WorldState): WorldState {
    const newCounter = ws.timeCounter + 1;
    let newPhase: TimePhase = ws.timePhase;
    if (newCounter % TIME_CYCLE_TURNS === 0) {
      newPhase = ws.timePhase === 'DAY' ? 'NIGHT' : 'DAY';
    }
    return { ...ws, timeCounter: newCounter, timePhase: newPhase };
  }

  updateHubSafety(ws: WorldState): WorldState {
    return { ...ws, hubSafety: this.computeSafety(ws.hubHeat) };
  }

  processDeferredEffects(
    ws: WorldState,
    currentTurnNo: number,
  ): { ws: WorldState; triggered: DeferredEffect[] } {
    const triggered: DeferredEffect[] = [];
    const remaining: DeferredEffect[] = [];

    for (const effect of ws.deferredEffects) {
      if (currentTurnNo >= effect.sourceTurnNo + effect.triggerTurnDelay) {
        triggered.push(effect);
      } else {
        remaining.push(effect);
      }
    }

    return {
      ws: { ...ws, deferredEffects: remaining },
      triggered,
    };
  }

  clampHeat(ws: WorldState): WorldState {
    return {
      ...ws,
      hubHeat: this.clampHeatValue(ws.hubHeat),
    };
  }

  private clampHeatValue(heat: number): number {
    return Math.max(MIN_HEAT, Math.min(MAX_HEAT, heat));
  }

  private computeSafety(heat: number): HubSafety {
    if (heat < 40) return 'SAFE';
    if (heat < 70) return 'ALERT';
    return 'DANGER';
  }
}
