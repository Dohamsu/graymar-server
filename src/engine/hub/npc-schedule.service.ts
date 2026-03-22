// Living World v2: NPC 일정 관리
// NPC의 시간대별 위치를 계산하고, 장소별 NPC 목록을 관리한다.

import { Injectable, Inject } from '@nestjs/common';
import type {
  WorldState,
  TimePhaseV2,
  NpcSchedule,
  NpcScheduleEntry,
} from '../../db/types/index.js';
import { ContentLoaderService } from '../../content/content-loader.service.js';

@Injectable()
export class NpcScheduleService {
  constructor(
    @Inject(ContentLoaderService) private readonly content: ContentLoaderService,
  ) {}

  /**
   * 특정 NPC의 현재 위치/활동 계산
   * override 조건을 순서대로 체크하여 일치하면 해당 일정 사용
   */
  getNpcLocation(
    npcId: string,
    timePhase: TimePhaseV2,
    ws: WorldState,
  ): NpcScheduleEntry | null {
    const npcDef = this.content.getNpc(npcId);
    if (!npcDef) return null;

    const schedule: NpcSchedule | undefined = npcDef.schedule;
    if (!schedule) return null;

    // override 조건 체크 (순서대로, 첫 번째 일치 사용)
    if (schedule.overrides) {
      for (const override of schedule.overrides) {
        if (this.evaluateCondition(override.condition, ws)) {
          const entry = override.schedule[timePhase];
          if (entry) return entry;
        }
      }
    }

    // 기본 일정
    return schedule.default[timePhase] ?? null;
  }

  /**
   * 특정 장소에 현재 있는 NPC 목록
   */
  getPresentNpcs(
    locationId: string,
    timePhase: TimePhaseV2,
    ws: WorldState,
  ): string[] {
    const allNpcs = this.content.getAllNpcs().map((n) => n.npcId);
    const present: string[] = [];

    for (const npcId of allNpcs) {
      const entry = this.getNpcLocation(npcId, timePhase, ws);
      if (entry && entry.locationId === locationId) {
        present.push(npcId);
      }
    }

    return present;
  }

  /**
   * 전체 NPC 위치 일괄 업데이트 (WorldTick에서 호출)
   * ws.npcLocations와 각 LocationDynamicState.presentNpcs를 갱신
   */
  updateAllNpcLocations(ws: WorldState): void {
    const timePhase = ws.phaseV2;
    const allNpcs = this.content.getAllNpcs().map((n) => n.npcId);

    // npcLocations 초기화
    if (!ws.npcLocations) ws.npcLocations = {};
    const npcLocations: Record<string, string> = {};

    // 장소별 NPC 집계
    const locationNpcs: Record<string, string[]> = {};

    for (const npcId of allNpcs) {
      const entry = this.getNpcLocation(npcId, timePhase, ws);
      if (entry) {
        npcLocations[npcId] = entry.locationId;
        if (!locationNpcs[entry.locationId]) {
          locationNpcs[entry.locationId] = [];
        }
        locationNpcs[entry.locationId].push(npcId);
      }
    }

    // WorldState 갱신
    ws.npcLocations = npcLocations;

    // LocationDynamicState.presentNpcs 갱신
    if (ws.locationDynamicStates) {
      for (const [locId, state] of Object.entries(ws.locationDynamicStates)) {
        state.presentNpcs = locationNpcs[locId] ?? [];
      }
    }
  }

  /**
   * 간단한 조건 평가기
   * 형식: "incident.INC_SMUGGLING.stage >= 2" 또는 "day >= 5"
   * 복잡한 AND/OR은 지원하지 않음 (향후 확장 가능)
   */
  private evaluateCondition(condition: string, ws: WorldState): boolean {
    try {
      // "day >= N" 형식
      const dayMatch = condition.match(/^day\s*(>=|>|<=|<|==)\s*(\d+)$/);
      if (dayMatch) {
        return this.compareNumber(ws.day, dayMatch[1], parseInt(dayMatch[2], 10));
      }

      // "incident.INC_XXX.stage >= N" 형식
      const incidentMatch = condition.match(/^incident\.(\w+)\.stage\s*(>=|>|<=|<|==)\s*(\d+)$/);
      if (incidentMatch) {
        const incident = ws.activeIncidents?.find((i) => i.incidentId === incidentMatch[1]);
        if (!incident) return false;
        return this.compareNumber(incident.stage, incidentMatch[2], parseInt(incidentMatch[3], 10));
      }

      // "hubHeat >= N" 형식
      const heatMatch = condition.match(/^hubHeat\s*(>=|>|<=|<|==)\s*(\d+)$/);
      if (heatMatch) {
        return this.compareNumber(ws.hubHeat, heatMatch[1], parseInt(heatMatch[2], 10));
      }

      // "flag.XXX" 형식 (플래그 존재 여부)
      const flagMatch = condition.match(/^flag\.(\w+)$/);
      if (flagMatch) {
        return ws.flags[flagMatch[1]] === true;
      }

      return false;
    } catch {
      return false;
    }
  }

  private compareNumber(actual: number, op: string, expected: number): boolean {
    switch (op) {
      case '>=': return actual >= expected;
      case '>': return actual > expected;
      case '<=': return actual <= expected;
      case '<': return actual < expected;
      case '==': return actual === expected;
      default: return false;
    }
  }
}
