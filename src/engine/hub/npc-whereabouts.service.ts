/**
 * NpcWhereaboutsService — architecture/48 Layer 2.
 *
 * NPC가 현재 어디에 있는지 lookup. 주어진 NPC와 현재 시간대 기준으로:
 *  - 같은 장소: SAME_LOCATION + activity
 *  - 다른 장소: DIFFERENT_LOCATION + locationId + activity
 *  - 알 수 없음 (interactable=false 또는 schedule 없음): UNKNOWN
 *
 * Living World v2의 dynamicOverride(npcLocations)를 우선 사용,
 * 없으면 schedule.default[timePhase] fallback.
 */

import { Injectable } from '@nestjs/common';

import { ContentLoaderService } from '../../content/content-loader.service.js';
import type { TimePhaseV2 } from '../../db/types/world-state.js';

export type NpcLocationStatus =
  | { kind: 'SAME_LOCATION'; activity?: string }
  | {
      kind: 'DIFFERENT_LOCATION';
      locationId: string;
      locationLabel: string;
      activity?: string;
    }
  | { kind: 'UNKNOWN' };

/** 장소 ID → 한글 라벨 (locations.json 반영). */
const LOC_LABELS: Record<string, string> = {
  LOC_MARKET: '시장 거리',
  LOC_GUARD: '경비대 지구',
  LOC_HARBOR: '항만 부두',
  LOC_SLUMS: '빈민가',
  LOC_NOBLE: '상류 거리',
  LOC_TAVERN: '잠긴 닻 선술집',
  LOC_DOCKS_WAREHOUSE: '항만 창고구',
};

@Injectable()
export class NpcWhereaboutsService {
  constructor(private readonly content: ContentLoaderService) {}

  /**
   * 특정 NPC의 현재 위치 lookup.
   * @param npcId
   * @param currentLocationId 플레이어 현재 위치
   * @param timePhase 현재 시간대 (DAWN/DAY/DUSK/NIGHT)
   * @param runState 옵션 (Living World v2 dynamicOverride 활용)
   */
  lookupNpc(
    npcId: string,
    currentLocationId: string,
    timePhase: TimePhaseV2,
    runState?: {
      worldState?: { npcLocations?: Record<string, string> };
    } | null,
  ): NpcLocationStatus {
    // 1. Living World dynamicOverride (npcLocations) 우선
    const dynamicLocId = runState?.worldState?.npcLocations?.[npcId];
    if (dynamicLocId) {
      if (dynamicLocId === currentLocationId) {
        return { kind: 'SAME_LOCATION' };
      }
      return {
        kind: 'DIFFERENT_LOCATION',
        locationId: dynamicLocId,
        locationLabel: LOC_LABELS[dynamicLocId] ?? dynamicLocId,
      };
    }

    // 2. NPC schedule 기반 lookup
    const npc = this.content.getNpc(npcId);
    if (!npc?.schedule?.default) {
      return { kind: 'UNKNOWN' };
    }
    const slot = npc.schedule.default[timePhase];
    if (!slot) {
      return { kind: 'UNKNOWN' };
    }
    if (!slot.interactable) {
      // 상호작용 불가 (취침 등) — 위치는 알지만 만날 수 없음
      // 다른 장소로 안내해도 의미 없으니 UNKNOWN 처리
      return { kind: 'UNKNOWN' };
    }
    if (slot.locationId === currentLocationId) {
      return { kind: 'SAME_LOCATION', activity: slot.activity };
    }
    return {
      kind: 'DIFFERENT_LOCATION',
      locationId: slot.locationId,
      locationLabel: LOC_LABELS[slot.locationId] ?? slot.locationId,
      activity: slot.activity,
    };
  }

  /**
   * 장소 ID → 한글 라벨 변환 (외부 사용).
   */
  getLocationLabel(locationId: string): string {
    return LOC_LABELS[locationId] ?? locationId;
  }
}
