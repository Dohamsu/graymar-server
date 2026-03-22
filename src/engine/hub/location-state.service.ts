// Living World v2: 장소 동적 상태 관리

import { Injectable } from '@nestjs/common';
import type {
  WorldState,
  LocationDynamicState,
  LocationCondition,
} from '../../db/types/index.js';
import { MAX_CONDITIONS_PER_LOCATION } from '../../db/types/location-state.js';

@Injectable()
export class LocationStateService {
  /** 장소 동적 상태 초기화 (콘텐츠 데이터에서) */
  initializeLocationStates(
    locationDefs: Array<{
      locationId: string;
      baseState?: {
        controllingFaction: string | null;
        security: number;
        prosperity: number;
        unrest: number;
      };
    }>,
  ): Record<string, LocationDynamicState> {
    const states: Record<string, LocationDynamicState> = {};
    for (const loc of locationDefs) {
      const base = loc.baseState;
      states[loc.locationId] = {
        locationId: loc.locationId,
        controllingFaction: base?.controllingFaction ?? null,
        controlStrength: 70,
        security: base?.security ?? 50,
        prosperity: base?.prosperity ?? 50,
        unrest: base?.unrest ?? 20,
        activeConditions: [],
        presentNpcs: [],
        recentEventIds: [],
        playerVisitCount: 0,
        lastVisitTurn: 0,
      };
    }
    return states;
  }

  /** 장소 상태 조회 (없으면 기본값) */
  getState(ws: WorldState, locationId: string): LocationDynamicState | undefined {
    return ws.locationDynamicStates?.[locationId];
  }

  /** 장소에 조건 추가 */
  addCondition(
    ws: WorldState,
    locationId: string,
    condition: Omit<LocationCondition, 'startTurn'>,
    currentTurn: number,
  ): boolean {
    const state = ws.locationDynamicStates?.[locationId];
    if (!state) return false;

    // 동일 id 조건이 이미 있으면 갱신
    const existing = state.activeConditions.findIndex((c) => c.id === condition.id);
    const fullCondition: LocationCondition = { ...condition, startTurn: currentTurn };

    if (existing >= 0) {
      state.activeConditions[existing] = fullCondition;
      return true;
    }

    // 최대 개수 제한
    if (state.activeConditions.length >= MAX_CONDITIONS_PER_LOCATION) {
      return false;
    }

    state.activeConditions.push(fullCondition);
    return true;
  }

  /** 장소에서 조건 제거 */
  removeCondition(ws: WorldState, locationId: string, conditionId: string): boolean {
    const state = ws.locationDynamicStates?.[locationId];
    if (!state) return false;

    const idx = state.activeConditions.findIndex((c) => c.id === conditionId);
    if (idx < 0) return false;

    state.activeConditions.splice(idx, 1);
    return true;
  }

  /** 만료된 조건 자동 제거 (매 WorldTick에서 호출) */
  tickConditions(ws: WorldState, currentTurn: number): string[] {
    const removed: string[] = [];
    if (!ws.locationDynamicStates) return removed;

    for (const state of Object.values(ws.locationDynamicStates)) {
      state.activeConditions = state.activeConditions.filter((c) => {
        if (c.duration === -1) return true; // 영구 조건
        if (currentTurn - c.startTurn >= c.duration) {
          removed.push(`${state.locationId}:${c.id}`);
          return false;
        }
        return true;
      });
    }
    return removed;
  }

  /** 장소의 현재 NPC 목록 갱신 */
  updatePresentNpcs(ws: WorldState, locationId: string, npcIds: string[]): void {
    const state = ws.locationDynamicStates?.[locationId];
    if (state) {
      state.presentNpcs = npcIds;
    }
  }

  /** 플레이어 방문 기록 */
  recordVisit(ws: WorldState, locationId: string, turnNo: number): void {
    const state = ws.locationDynamicStates?.[locationId];
    if (state) {
      state.playerVisitCount += 1;
      state.lastVisitTurn = turnNo;
    }
  }

  /** 최근 이벤트 id 추가 (최대 5개 유지) */
  addRecentEvent(ws: WorldState, locationId: string, eventId: string): void {
    const state = ws.locationDynamicStates?.[locationId];
    if (state) {
      state.recentEventIds.push(eventId);
      if (state.recentEventIds.length > 5) {
        state.recentEventIds.shift();
      }
    }
  }

  /** 장소 수치의 자연 회귀 (매 일 단위, WorldTick에서 호출) */
  naturalDecay(ws: WorldState, baseStates: Record<string, { security: number; prosperity: number; unrest: number }>): void {
    if (!ws.locationDynamicStates) return;

    for (const [locId, state] of Object.entries(ws.locationDynamicStates)) {
      const base = baseStates[locId];
      if (!base) continue;

      // 10% 회귀
      state.security += Math.round((base.security - state.security) * 0.1);
      state.prosperity += Math.round((base.prosperity - state.prosperity) * 0.1);
      state.unrest += Math.round((base.unrest - state.unrest) * 0.1);

      // 클램프
      state.security = Math.max(0, Math.min(100, state.security));
      state.prosperity = Math.max(0, Math.min(100, state.prosperity));
      state.unrest = Math.max(0, Math.min(100, state.unrest));
    }
  }
}
