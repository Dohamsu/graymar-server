// 정본: design/HUB_arc_system.md

export const ARC_ROUTE = [
  'EXPOSE_CORRUPTION',
  'PROFIT_FROM_CHAOS',
  'ALLY_GUARD',
] as const;
export type ArcRoute = (typeof ARC_ROUTE)[number];

export type ArcState = {
  currentRoute: ArcRoute | null;
  commitment: number; // 0~3 (3 = locked)
  betrayalCount: number; // 0~2
};
