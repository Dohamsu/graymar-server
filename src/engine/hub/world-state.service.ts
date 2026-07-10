import { Injectable } from '@nestjs/common';
import { ContentLoaderService } from '../../content/content-loader.service.js';
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
  constructor(private readonly content: ContentLoaderService) {}

  /** architecture/63: locations.json hubState 파생 초기 장소 상태 */
  private buildInitialLocationStates(): Record<
    string,
    { security: number; crime: number; unrest: number; spotlight: boolean }
  > {
    const out: Record<
      string,
      { security: number; crime: number; unrest: number; spotlight: boolean }
    > = {};
    for (const loc of this.content.getAllLocations()) {
      if (loc.hubState) {
        out[loc.locationId] = { ...loc.hubState, spotlight: false };
      }
    }
    return out;
  }

  initWorldState(): WorldState {
    return {
      currentLocationId: null,
      timePhase: 'DAY',
      timeCounter: 0,
      hubHeat: 15,
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
      // architecture/63: locations.json hubState 파생 (구 하드코딩)
      locationStates: this.buildInitialLocationStates(),
      // Narrative Engine v1
      globalClock: 0,
      day: 1,
      phaseV2: 'DAWN',
      activeIncidents: [],
      npcGoals: {},
      signalFeed: [],
      narrativeMarks: [],
      mainArcClock: { startDay: 1, softDeadlineDay: 14, triggered: false },
      operationSession: null,
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
      combatWindowCount: 0, // HUB 복귀 시 전투 윈도우 초기화
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

  /**
   * 기존 active run에서 v1 필드가 없을 때 defaults 적용 (마이그레이션)
   */
  migrateWorldState(ws: WorldState): WorldState {
    return {
      ...ws,
      globalClock: ws.globalClock ?? 0,
      day: ws.day ?? 1,
      phaseV2: ws.phaseV2 ?? (ws.timePhase === 'NIGHT' ? 'NIGHT' : 'DAY'),
      activeIncidents: ws.activeIncidents ?? [],
      npcGoals: ws.npcGoals ?? {},
      signalFeed: ws.signalFeed ?? [],
      narrativeMarks: ws.narrativeMarks ?? [],
      mainArcClock: ws.mainArcClock ?? {
        startDay: 1,
        softDeadlineDay: 14,
        triggered: false,
      },
      operationSession: ws.operationSession ?? null,
    };
  }
}
