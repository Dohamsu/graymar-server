import { Injectable } from '@nestjs/common';
import type {
  IncidentDef,
  IncidentRuntime,
  IncidentImpactPatch,
  IncidentHistoryEntry,
  IncidentOutcome,
  WorldState,
  ResolveOutcome,
} from '../../db/types/index.js';
import type { Rng } from '../rng/rng.service.js';

@Injectable()
export class IncidentManagementService {
  /**
   * 런 시작 시 초기 Incident spawn.
   * spawnConditions(minDay=1, 기타 조건 무시) 만족하는 것 중 weight 기반 1~2개 선택.
   */
  initIncidents(
    allIncidents: IncidentDef[],
    ws: WorldState,
    rng: Rng,
  ): IncidentRuntime[] {
    const eligible = allIncidents.filter((inc) => {
      const sc = inc.spawnConditions;
      if (sc.minDay && sc.minDay > ws.day) return false;
      if (sc.minHeat && sc.minHeat > ws.hubHeat) return false;
      return true;
    });

    if (eligible.length === 0) return [];

    // 가중치 기반 1~2개 선택
    const count = Math.min(2, eligible.length);
    const selected: IncidentDef[] = [];
    const remaining = [...eligible];

    for (let i = 0; i < count; i++) {
      if (remaining.length === 0) break;
      const weights = remaining.map((e) => e.weight);
      const totalWeight = weights.reduce((s, w) => s + w, 0);
      let roll = rng.next() * totalWeight;
      let idx = 0;
      for (; idx < remaining.length - 1; idx++) {
        roll -= weights[idx];
        if (roll <= 0) break;
      }
      selected.push(remaining[idx]);
      remaining.splice(idx, 1);
    }

    return selected.map((def) => this.createRuntime(def, ws.globalClock));
  }

  /**
   * WorldTick에서 호출: 새 Incident spawn 시도.
   * 현재 active가 3개 미만이고 conditions 만족 시 spawn.
   */
  trySpawnIncident(
    allIncidents: IncidentDef[],
    ws: WorldState,
    rng: Rng,
  ): IncidentRuntime | null {
    if (ws.activeIncidents.length >= 3) return null;

    const activeIds = new Set(ws.activeIncidents.map((i) => i.incidentId));
    const eligible = allIncidents.filter((inc) => {
      if (activeIds.has(inc.incidentId)) return false;
      // 이미 resolved된 Incident도 제외 (flags 기반)
      const sc = inc.spawnConditions;
      if (sc.minDay && sc.minDay > ws.day) return false;
      if (sc.maxDay && sc.maxDay < ws.day) return false;
      if (sc.minHeat && sc.minHeat > ws.hubHeat) return false;
      if (sc.requiredFlags) {
        for (const flag of sc.requiredFlags) {
          if (!ws.flags[flag]) return false;
        }
      }
      if (sc.requiredReputation) {
        for (const [factionId, cond] of Object.entries(sc.requiredReputation)) {
          const rep = ws.reputation[factionId] ?? 0;
          switch (cond.op) {
            case 'gt': if (!(rep > cond.value)) return false; break;
            case 'lt': if (!(rep < cond.value)) return false; break;
            case 'gte': if (!(rep >= cond.value)) return false; break;
            case 'lte': if (!(rep <= cond.value)) return false; break;
          }
        }
      }
      return true;
    });

    if (eligible.length === 0) return null;

    // spawn 확률: 20% per tick
    if (!rng.chance(20)) return null;

    const weights = eligible.map((e) => e.weight);
    const totalWeight = weights.reduce((s, w) => s + w, 0);
    let roll = rng.next() * totalWeight;
    let idx = 0;
    for (; idx < eligible.length - 1; idx++) {
      roll -= weights[idx];
      if (roll <= 0) break;
    }

    return this.createRuntime(eligible[idx], ws.globalClock);
  }

  /**
   * 모든 active Incident를 1 tick 진행.
   * pressure 자동 증가, stage 자동 진행, resolution 체크.
   */
  tickAllIncidents(
    ws: WorldState,
    incidentDefs: IncidentDef[],
  ): { incidents: IncidentRuntime[]; resolvedPatches: IncidentImpactPatch[] } {
    const defMap = new Map(incidentDefs.map((d) => [d.incidentId, d]));
    const resolvedPatches: IncidentImpactPatch[] = [];
    const updatedIncidents: IncidentRuntime[] = [];

    for (const incident of ws.activeIncidents) {
      if (incident.resolved) {
        updatedIncidents.push(incident);
        continue;
      }

      const def = defMap.get(incident.incidentId);
      if (!def) {
        updatedIncidents.push(incident);
        continue;
      }

      const stageDef = def.stages[incident.stage];
      if (!stageDef) {
        updatedIncidents.push(incident);
        continue;
      }

      // pressure 자동 증가
      const newPressure = Math.min(100, incident.pressure + stageDef.pressurePerTick);
      const updated: IncidentRuntime = {
        ...incident,
        pressure: newPressure,
        historyLog: [
          ...incident.historyLog,
          {
            clock: ws.globalClock,
            action: 'PRESSURE_CHANGE',
            detail: `pressure +${stageDef.pressurePerTick}`,
            pressureDelta: stageDef.pressurePerTick,
          },
        ],
      };

      // resolution 체크
      const resolution = this.checkResolution(updated, def);
      if (resolution) {
        updated.resolved = true;
        updated.outcome = resolution;
        updated.historyLog.push({
          clock: ws.globalClock,
          action: 'RESOLVE',
          detail: `Resolved: ${resolution}`,
        });
        resolvedPatches.push(def.impactOnResolve[resolution]);
      }

      updatedIncidents.push(updated);
    }

    return { incidents: updatedIncidents, resolvedPatches };
  }

  /**
   * 플레이어 행동 결과 → Incident에 impact 적용.
   * control 증감, stage 진행.
   */
  applyImpact(
    incident: IncidentRuntime,
    def: IncidentDef,
    outcome: ResolveOutcome,
    clock: number,
  ): IncidentRuntime {
    const stageDef = def.stages[incident.stage];
    if (!stageDef) return incident;

    let controlDelta = 0;
    if (outcome === 'SUCCESS') {
      controlDelta = stageDef.controlReward;
    } else if (outcome === 'FAIL') {
      controlDelta = -stageDef.controlPenalty;
    } else {
      // PARTIAL: 절반
      controlDelta = Math.floor(stageDef.controlReward / 2);
    }

    const newControl = Math.max(0, Math.min(100, incident.control + controlDelta));

    // stage 진행: control 50 이상이고 다음 stage가 존재하면
    let newStage = incident.stage;
    if (newControl >= 50 && incident.stage < def.stages.length - 1) {
      newStage = incident.stage + 1;
    }

    const entry: IncidentHistoryEntry = {
      clock,
      action: newStage !== incident.stage ? 'STAGE_ADVANCE' : 'CONTROL_CHANGE',
      detail: `${outcome}: control ${controlDelta > 0 ? '+' : ''}${controlDelta}`,
      controlDelta,
    };

    return {
      ...incident,
      control: newControl,
      stage: newStage,
      historyLog: [...incident.historyLog, entry],
    };
  }

  /**
   * 현재 location에서 관련 Incident 찾기.
   * stage의 affordances와 intent의 actionType(primary OR secondary)이 매치되는 것 우선.
   */
  findRelevantIncident(
    ws: WorldState,
    locationId: string,
    actionType: string,
    incidentDefs: IncidentDef[],
    secondaryActionType?: string,
  ): { incident: IncidentRuntime; def: IncidentDef } | null {
    const defMap = new Map(incidentDefs.map((d) => [d.incidentId, d]));

    // location 매칭 + affordance 매칭 우선
    const candidates = ws.activeIncidents
      .filter((i) => !i.resolved)
      .map((i) => ({ incident: i, def: defMap.get(i.incidentId)! }))
      .filter(({ def }) => def && def.locationId === locationId);

    if (candidates.length === 0) return null;

    // affordance 매칭 우선 (primary OR secondary)
    const affordanceMatch = candidates.find(({ def, incident }) => {
      const stageDef = def.stages[incident.stage];
      return stageDef?.affordances.includes(actionType as any) ||
        (secondaryActionType && stageDef?.affordances.includes(secondaryActionType as any));
    });

    return affordanceMatch ?? candidates[0];
  }

  checkResolution(
    incident: IncidentRuntime,
    def: IncidentDef,
  ): IncidentOutcome | null {
    const rc = def.resolutionConditions;
    if (incident.control >= rc.controlThreshold) return 'CONTAINED';
    if (incident.pressure >= rc.pressureThreshold) return 'ESCALATED';
    // deadline은 globalClock 기반
    if (incident.spawnedAtClock + rc.deadlineTicks <= incident.deadlineClock) {
      // deadlineClock은 실제 current clock으로 비교해야 하므로
      // 여기서는 tickAllIncidents에서 ws.globalClock과 비교
    }
    return null;
  }

  /**
   * deadline 체크 (globalClock 기반).
   */
  checkDeadline(incident: IncidentRuntime, currentClock: number): boolean {
    return currentClock >= incident.deadlineClock;
  }

  private createRuntime(def: IncidentDef, currentClock: number): IncidentRuntime {
    return {
      incidentId: def.incidentId,
      kind: def.kind,
      stage: 0,
      control: 0,
      pressure: 0,
      deadlineClock: currentClock + def.resolutionConditions.deadlineTicks,
      spawnedAtClock: currentClock,
      resolved: false,
      historyLog: [
        {
          clock: currentClock,
          action: 'SPAWN',
          detail: `Incident spawned: ${def.title}`,
        },
      ],
    };
  }
}
