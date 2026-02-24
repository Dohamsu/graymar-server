import { Injectable } from '@nestjs/common';
import type {
  WorldState,
  TimePhaseV2,
  IncidentDef,
  IncidentImpactPatch,
} from '../../db/types/index.js';
import { IncidentManagementService } from './incident-management.service.js';
import { SignalFeedService } from './signal-feed.service.js';
import type { Rng } from '../rng/rng.service.js';

/**
 * 4상 시간 사이클 ticks:
 * DAWN=2, DAY=4, DUSK=2, NIGHT=4 → 총 12 ticks = 1일
 */
const PHASE_DURATIONS: Record<TimePhaseV2, number> = {
  DAWN: 2,
  DAY: 4,
  DUSK: 2,
  NIGHT: 4,
};

const PHASE_ORDER: TimePhaseV2[] = ['DAWN', 'DAY', 'DUSK', 'NIGHT'];
const TICKS_PER_DAY = 12;

@Injectable()
export class WorldTickService {
  constructor(
    private readonly incidentMgmt: IncidentManagementService,
    private readonly signalFeed: SignalFeedService,
  ) {}

  /**
   * Operation Step 실행 전 tick.
   * - globalClock 증가
   * - 시간 사이클 진행
   * - Incident pressure 자동 증가
   * - 새 Incident spawn 시도
   */
  preStepTick(
    ws: WorldState,
    incidentDefs: IncidentDef[],
    rng: Rng,
    timeCost: number = 1,
  ): { ws: WorldState; resolvedPatches: IncidentImpactPatch[] } {
    let updated = { ...ws };
    const allPatches: IncidentImpactPatch[] = [];

    for (let i = 0; i < timeCost; i++) {
      // globalClock 증가
      updated = {
        ...updated,
        globalClock: updated.globalClock + 1,
      };

      // 시간 사이클 진행
      updated = this.advancePhaseV2(updated);

      // Incident tick
      const { incidents, resolvedPatches } = this.incidentMgmt.tickAllIncidents(
        updated,
        incidentDefs,
      );

      // deadline 체크 (tickAllIncidents에서 못 잡은 것)
      const finalIncidents = incidents.map((inc) => {
        if (!inc.resolved && this.incidentMgmt.checkDeadline(inc, updated.globalClock)) {
          const def = incidentDefs.find((d) => d.incidentId === inc.incidentId);
          if (def) {
            allPatches.push(def.impactOnResolve.EXPIRED);
          }
          return {
            ...inc,
            resolved: true,
            outcome: 'EXPIRED' as const,
            historyLog: [
              ...inc.historyLog,
              {
                clock: updated.globalClock,
                action: 'RESOLVE' as const,
                detail: 'Deadline expired',
              },
            ],
          };
        }
        return inc;
      });

      updated = { ...updated, activeIncidents: finalIncidents };
      allPatches.push(...resolvedPatches);

      // 새 Incident spawn 시도
      const newIncident = this.incidentMgmt.trySpawnIncident(
        incidentDefs,
        updated,
        rng,
      );
      if (newIncident) {
        updated = {
          ...updated,
          activeIncidents: [...updated.activeIncidents, newIncident],
        };
      }
    }

    // 시그널 생성
    updated = {
      ...updated,
      signalFeed: this.signalFeed.generateFromIncidents(
        updated.activeIncidents,
        incidentDefs,
        updated.globalClock,
        updated.signalFeed,
      ),
    };

    return { ws: updated, resolvedPatches: allPatches };
  }

  /**
   * Operation Step 실행 후 tick.
   * - resolved Incident impact 적용
   * - HUB 안전도 재계산
   * - v1 호환 timePhase 동기화
   */
  postStepTick(
    ws: WorldState,
    resolvedPatches: IncidentImpactPatch[],
  ): WorldState {
    let updated = { ...ws };

    // resolved patches 적용
    for (const patch of resolvedPatches) {
      updated = this.applyPatch(updated, patch);
    }

    // HUB 안전도 재계산
    updated = {
      ...updated,
      hubSafety: this.computeSafety(updated.hubHeat),
    };

    // v1 호환: phaseV2 → timePhase 동기화
    updated = {
      ...updated,
      timePhase: updated.phaseV2 === 'DAWN' || updated.phaseV2 === 'DAY' ? 'DAY' : 'NIGHT',
    };

    // 만료된 시그널 정리
    updated = {
      ...updated,
      signalFeed: this.signalFeed.expireSignals(updated.signalFeed, updated.globalClock),
    };

    return updated;
  }

  /**
   * 전체 tick (preStep + postStep 통합, 단순 사용 시).
   */
  tick(
    ws: WorldState,
    incidentDefs: IncidentDef[],
    rng: Rng,
    timeCost: number = 1,
  ): WorldState {
    const { ws: preWs, resolvedPatches } = this.preStepTick(ws, incidentDefs, rng, timeCost);
    return this.postStepTick(preWs, resolvedPatches);
  }

  private advancePhaseV2(ws: WorldState): WorldState {
    const tickInDay = ws.globalClock % TICKS_PER_DAY;
    let accumulated = 0;
    let newPhase: TimePhaseV2 = 'DAWN';

    for (const phase of PHASE_ORDER) {
      accumulated += PHASE_DURATIONS[phase];
      if (tickInDay < accumulated) {
        newPhase = phase;
        break;
      }
    }

    const newDay = Math.floor(ws.globalClock / TICKS_PER_DAY) + 1;

    return {
      ...ws,
      phaseV2: newPhase,
      day: newDay,
    };
  }

  private applyPatch(ws: WorldState, patch: IncidentImpactPatch): WorldState {
    let updated = { ...ws };

    // heat
    if (patch.heatDelta) {
      updated = {
        ...updated,
        hubHeat: Math.max(0, Math.min(100, updated.hubHeat + patch.heatDelta)),
      };
    }

    // tension
    if (patch.tensionDelta) {
      updated = {
        ...updated,
        tension: Math.max(0, Math.min(10, updated.tension + patch.tensionDelta)),
      };
    }

    // reputation
    if (patch.reputationChanges) {
      const newRep = { ...updated.reputation };
      for (const [factionId, delta] of Object.entries(patch.reputationChanges)) {
        newRep[factionId] = (newRep[factionId] ?? 0) + delta;
      }
      updated = { ...updated, reputation: newRep };
    }

    // flags
    if (patch.flagsSet) {
      const newFlags = { ...updated.flags };
      for (const flag of patch.flagsSet) {
        newFlags[flag] = true;
      }
      updated = { ...updated, flags: newFlags };
    }

    return updated;
  }

  private computeSafety(heat: number): 'SAFE' | 'ALERT' | 'DANGER' {
    if (heat < 40) return 'SAFE';
    if (heat < 70) return 'ALERT';
    return 'DANGER';
  }
}
