// 정본: architecture/10_region_economy.md §1 — RegionState 계층

import type { TimePhase, HubSafety } from './world-state.js';

// --- RegionState: 리전별 영속 상태 ---

export interface RegionClock {
  timePhase: TimePhase;
  timeCounter: number;
}

export interface RegionHeat {
  hubHeat: number; // 0~100
  hubSafety: HubSafety;
}

export interface RegionTension {
  localTension: number; // 0~10
  stage: 'STABLE' | 'RISING' | 'PEAK' | 'DECLINING';
}

export interface RegionFactions {
  reputation: Record<string, number>;
  flags: Record<string, boolean>;
}

export interface RegionQuests {
  active: Record<string, unknown>;
  completed: string[];
}

export interface RegionArcs {
  currentRoute: string | null;
  commitment: number; // 0~3
  resolvedRoutes: string[];
}

export interface RegionEconomy {
  priceIndex: number; // 기본 1.0, tension/crime 영향
  shopStocks: Record<string, ShopStock>;
}

export interface ShopStock {
  items: StockItem[];
  lastRefreshTurn: number;
  refreshInterval: number; // 턴 수
}

export interface StockItem {
  itemId: string;
  qty: number;
  priceOverride?: number; // null이면 기본 가격 × priceIndex
}

export interface RegionState {
  regionId: string;
  name: string;
  chapterIndex: number;
  clock: RegionClock;
  heat: RegionHeat;
  tension: RegionTension;
  factions: RegionFactions;
  npcs: {
    npcStates: Record<string, unknown>;
    generatedNpcPool: Record<string, unknown>;
  };
  quests: RegionQuests;
  arcs: RegionArcs;
  locations: {
    unlockedLocationIds: string[];
  };
  economy: RegionEconomy;
  history: {
    majorEvents: string[];
  };
}

// --- WorldStateGlobal: 전역 영속 상태 ---

export interface WorldStateGlobal {
  currentRegionId: string;
  unlockedRegionIds: string[];
  completedRegionIds: string[];
  regions: Record<string, RegionState>;
  globalFlags: Record<string, boolean>;
}

// 초기 Graymar 리전 생성
export function initGraymarRegion(): RegionState {
  return {
    regionId: 'REG_GRAYMAR_HARBOR',
    name: 'Graymar Harbor',
    chapterIndex: 0,
    clock: { timePhase: 'DAY', timeCounter: 0 },
    heat: { hubHeat: 0, hubSafety: 'SAFE' },
    tension: { localTension: 0, stage: 'STABLE' },
    factions: {
      reputation: { CITY_GUARD: 0, MERCHANT_CONSORTIUM: 0, LABOR_GUILD: 0 },
      flags: {},
    },
    npcs: { npcStates: {}, generatedNpcPool: {} },
    quests: { active: {}, completed: [] },
    arcs: { currentRoute: null, commitment: 0, resolvedRoutes: [] },
    locations: {
      unlockedLocationIds: ['LOC_MARKET', 'LOC_GUARD', 'LOC_HARBOR', 'LOC_SLUMS'],
    },
    economy: {
      priceIndex: 1.0,
      shopStocks: {},
    },
    history: { majorEvents: [] },
  };
}
