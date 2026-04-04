import { Injectable } from '@nestjs/common';
import type {
  WorldState,
  WorldDelta,
  WorldDeltaChange,
  IncidentRuntime,
  NarrativeMark,
} from '../../db/types/index.js';

const MAX_DELTAS = 10;

@Injectable()
export class WorldDeltaService {
  /**
   * pre/post WorldState를 비교하여 WorldDelta를 생성하고 ws.worldDeltas에 추가.
   */
  build(
    turnNo: number,
    priorWs: WorldState,
    currentWs: WorldState,
  ): { ws: WorldState; delta: WorldDelta } {
    const changes: WorldDeltaChange[] = [];

    // Heat 변화
    if (priorWs.hubHeat !== currentWs.hubHeat) {
      changes.push({
        kind: 'HEAT',
        field: 'hubHeat',
        from: priorWs.hubHeat,
        to: currentWs.hubHeat,
        detail: `도시 긴장도 ${priorWs.hubHeat} → ${currentWs.hubHeat}`,
      });
    }

    // Safety 변화
    if (priorWs.hubSafety !== currentWs.hubSafety) {
      changes.push({
        kind: 'SAFETY',
        field: 'hubSafety',
        from: priorWs.hubSafety,
        to: currentWs.hubSafety,
        detail: `도시 경계 ${priorWs.hubSafety} → ${currentWs.hubSafety}`,
      });
    }

    // Time phase 변화
    if (priorWs.phaseV2 !== currentWs.phaseV2) {
      changes.push({
        kind: 'TIME_PHASE',
        field: 'phaseV2',
        from: priorWs.phaseV2,
        to: currentWs.phaseV2,
        detail: `시간대 ${priorWs.phaseV2} → ${currentWs.phaseV2}`,
      });
    }

    // Incident 변화
    this.diffIncidents(
      priorWs.activeIncidents ?? [],
      currentWs.activeIncidents ?? [],
      changes,
    );

    // Reputation 변화
    this.diffReputation(priorWs.reputation, currentWs.reputation, changes);

    // Narrative Marks 변화
    this.diffMarks(
      priorWs.narrativeMarks ?? [],
      currentWs.narrativeMarks ?? [],
      changes,
    );

    const delta: WorldDelta = {
      turnNo,
      clock: currentWs.globalClock,
      changes,
    };

    // worldDeltas에 추가 (최대 MAX_DELTAS)
    const deltas = [...(currentWs.worldDeltas ?? []), delta].slice(-MAX_DELTAS);
    const ws = { ...currentWs, worldDeltas: deltas };

    return { ws, delta };
  }

  private diffIncidents(
    prior: IncidentRuntime[],
    current: IncidentRuntime[],
    changes: WorldDeltaChange[],
  ): void {
    const priorMap = new Map(prior.map((i) => [i.incidentId, i]));

    for (const c of current) {
      const p = priorMap.get(c.incidentId);

      if (!p) {
        changes.push({
          kind: 'INCIDENT_SPAWN',
          field: `incident:${c.incidentId}`,
          from: null,
          to: c.stage,
          detail: `새로운 사건 발생: ${c.incidentId}`,
        });
        continue;
      }

      if (c.stage > p.stage) {
        changes.push({
          kind: 'INCIDENT_STAGE',
          field: `incident:${c.incidentId}.stage`,
          from: p.stage,
          to: c.stage,
          detail: `사건 ${c.incidentId} 단계 상승`,
        });
      }

      if (c.resolved && !p.resolved) {
        changes.push({
          kind: 'INCIDENT_RESOLVE',
          field: `incident:${c.incidentId}.outcome`,
          from: null,
          to: c.outcome,
          detail: `사건 ${c.incidentId} 종결: ${c.outcome}`,
        });
      }
    }
  }

  private diffReputation(
    prior: Record<string, number>,
    current: Record<string, number>,
    changes: WorldDeltaChange[],
  ): void {
    const allKeys = new Set([...Object.keys(prior), ...Object.keys(current)]);
    for (const key of allKeys) {
      const pv = prior[key] ?? 0;
      const cv = current[key] ?? 0;
      if (pv !== cv) {
        changes.push({
          kind: 'REPUTATION',
          field: `reputation.${key}`,
          from: pv,
          to: cv,
          detail: `${key} 평판 ${pv} → ${cv}`,
        });
      }
    }
  }

  private diffMarks(
    prior: NarrativeMark[],
    current: NarrativeMark[],
    changes: WorldDeltaChange[],
  ): void {
    const priorTypes = new Set(prior.map((m) => m.type));
    for (const m of current) {
      if (!priorTypes.has(m.type)) {
        changes.push({
          kind: 'NARRATIVE_MARK',
          field: `narrativeMark:${m.type}`,
          from: null,
          to: m.type,
          detail: `서사 표식 획득: ${m.type}`,
        });
      }
    }
  }
}
