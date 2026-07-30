import { Injectable, Optional } from '@nestjs/common';
import type {
  WorldState,
  TimePhaseV2,
  IncidentDef,
  IncidentImpactPatch,
} from '../../db/types/index.js';
import { deriveTimePhaseFromV2 } from '../../db/types/index.js';
import { DIALOGUE_TICK_ACCRUAL_TURNS } from '../../turns/time-cost.js';
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

    // v1 호환: phaseV2 → timePhase 파생 미러 (단일 정본 = phaseV2)
    updated = {
      ...updated,
      timePhase: deriveTimePhaseFromV2(updated.phaseV2),
    };

    // Soft deadline 근접 시그널 (mainArcClock이 있을 때만)
    const softDeadlineSig = this.signalFeed.generateSoftDeadlineSignal(
      updated.mainArcClock,
      updated.day,
      updated.globalClock,
      updated.signalFeed,
    );
    if (softDeadlineSig) {
      // mainArcClock.triggered 플래그 동기화
      if (!updated.mainArcClock?.triggered && updated.mainArcClock) {
        const daysLeft = updated.mainArcClock.softDeadlineDay - updated.day;
        if (daysLeft < 0) {
          updated = {
            ...updated,
            mainArcClock: { ...updated.mainArcClock, triggered: true },
          };
        }
      }
      updated = {
        ...updated,
        signalFeed: [...updated.signalFeed, softDeadlineSig],
      };
    }

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
      const agendaResults = this.npcAgenda.tickAgendas(
        updated,
        updated.globalClock,
      );
      // 진행된 아젠다를 ws에 저장 (LLM 목격 힌트용)
      if (agendaResults.length > 0) {
        (updated as unknown as Record<string, unknown>).recentAgendaEvents =
          agendaResults
            .map((r) => ({
              npcId: r.npcId,
              signal: r.signalEmitted,
            }))
            .filter((r) => r.signal);
      }
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

  /**
   * 이동 전용 경량 시계 전진 — arch/81 2차 재설계 (2026-07-25).
   *
   * 장소 전환 경로(HUB go_* / performLocationTransition / returnToHubFlow)는
   * 행동 파이프라인(preStepTick)을 타지 않는 조기 return이라 시간이 전혀 흐르지
   * 않았다. "시간은 이동과 시간이 걸리는 행동에서만 흐른다" 설계에 따라 이동
   * 턴에 이 헬퍼로 시계만 전진시킨다.
   *
   * 의도적으로 Incident tick·spawn·signal·packMeter는 제외한다 — 이동 SYSTEM
   * 턴에 사건 스폰/시그널이 붙는 부작용 방지. 사건 진행은 기존대로 행동 턴
   * (preStepTick)이 소유한다.
   *
   * - globalClock/phaseV2/day 전진 + timePhase 파생 미러 (불변식 49)
   * - 전환 발생 시 recentPhaseTransition 기록 → 도착 턴 LLM이 [시간대 전환]
   *   디렉티브로 "도착하니 해가 저물어 있었다"류 서술을 받는다.
   * - NPC 스케줄 재배치 (시간이 흘렀으므로 위치 갱신)
   */
  advanceClockForTravel(ws: WorldState, ticks: number): WorldState {
    if (ticks <= 0) return ws;
    const prevPhase: TimePhaseV2 =
      ws.phaseV2 ?? (ws.timePhase === 'NIGHT' ? 'NIGHT' : 'DAY');

    // [Task#2 B-1 2026-07-30] 대화 지연 틱 발효 — 이동도 비대화 시간 소유
    // 경로이므로 적립분(6대화턴=1tick)을 여기서도 소화한다.
    let accrual = ws.dialogueTickAccrual ?? 0;
    if (accrual >= DIALOGUE_TICK_ACCRUAL_TURNS) {
      ticks += Math.floor(accrual / DIALOGUE_TICK_ACCRUAL_TURNS);
      accrual = accrual % DIALOGUE_TICK_ACCRUAL_TURNS;
    }

    let updated: WorldState = {
      ...ws,
      phaseV2: prevPhase,
      globalClock: ws.globalClock + ticks,
      dialogueTickAccrual: accrual,
    };
    updated = this.advancePhaseV2(updated);
    updated = {
      ...updated,
      timePhase: deriveTimePhaseFromV2(updated.phaseV2),
      recentPhaseTransition:
        prevPhase !== updated.phaseV2
          ? {
              from: prevPhase,
              to: updated.phaseV2,
              atClock: updated.globalClock,
            }
          : null,
    };

    // 시간이 흘렀으니 NPC 위치도 스케줄 기준으로 재배치
    if (this.npcSchedule) {
      this.npcSchedule.updateAllNpcLocations(updated);
    }

    return updated;
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
