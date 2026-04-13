import { Injectable, Optional } from '@nestjs/common';
import type {
  WorldState,
  TimePhaseV2,
  IncidentDef,
  IncidentImpactPatch,
} from '../../db/types/index.js';
import { IncidentManagementService } from './incident-management.service.js';
import { SignalFeedService } from './signal-feed.service.js';
import { NpcScheduleService } from './npc-schedule.service.js';
import { LocationStateService } from './location-state.service.js';
import { WorldFactService } from './world-fact.service.js';
import { NpcAgendaService } from './npc-agenda.service.js';
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
    @Optional() private readonly npcSchedule?: NpcScheduleService,
    @Optional() private readonly locationState?: LocationStateService,
    @Optional() private readonly worldFact?: WorldFactService,
    @Optional() private readonly npcAgenda?: NpcAgendaService,
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
        if (
          !inc.resolved &&
          this.incidentMgmt.checkDeadline(inc, updated.globalClock)
        ) {
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
      timePhase:
        updated.phaseV2 === 'DAWN' || updated.phaseV2 === 'DAY'
          ? 'DAY'
          : 'NIGHT',
    };

    // 만료된 시그널 정리
    updated = {
      ...updated,
      signalFeed: this.signalFeed.expireSignals(
        updated.signalFeed,
        updated.globalClock,
      ),
    };

    // --- Living World v2 tick ---
    // NPC 위치 업데이트
    if (this.npcSchedule) {
      this.npcSchedule.updateAllNpcLocations(updated);
    }

    // 장소 조건 만료 체크
    if (this.locationState) {
      this.locationState.tickConditions(updated, updated.globalClock);
    }

    // 만료 fact 정리
    if (this.worldFact) {
      this.worldFact.pruneExpired(updated, updated.globalClock);
    }

    // NPC agenda 진행
    if (this.npcAgenda) {
      this.npcAgenda.tickAgendas(updated, updated.globalClock);
    }

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
    const { ws: preWs, resolvedPatches } = this.preStepTick(
      ws,
      incidentDefs,
      rng,
      timeCost,
    );
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

    // 시간대 전환 시그널
    const oldPhase = ws.phaseV2;
    let updatedSignalFeed = ws.signalFeed;
    if (oldPhase && newPhase !== oldPhase) {
      const PHASE_TEXT: Record<string, string> = {
        DAWN: '동이 트기 시작했다. 그레이마르에 새벽이 밝았다.',
        DAY: '해가 떠올랐다. 거리에 사람들이 모여들고 있다.',
        DUSK: '해가 기울고 있다. 그림자가 길어지기 시작한다.',
        NIGHT: '밤이 내렸다. 그레이마르의 어둠이 깊어지고 있다.',
      };
      const sf = [...(ws.signalFeed ?? [])] as Array<Record<string, unknown>>;
      sf.push({
        id: `sig_phase_${newPhase}_d${newDay}_${ws.globalClock}`,
        channel: 'VISUAL',
        severity: 3,
        text: PHASE_TEXT[newPhase] ?? `시간이 흘렀다.`,
        createdAtClock: ws.globalClock,
      });
      updatedSignalFeed = sf as any;
    }

    return {
      ...ws,
      phaseV2: newPhase,
      day: newDay,
      signalFeed: updatedSignalFeed,
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
        tension: Math.max(
          0,
          Math.min(10, updated.tension + patch.tensionDelta),
        ),
      };
    }

    // reputation
    if (patch.reputationChanges) {
      const newRep = { ...updated.reputation };
      for (const [factionId, delta] of Object.entries(
        patch.reputationChanges,
      )) {
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
