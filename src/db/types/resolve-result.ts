// 정본: specs/HUB_resolve_system.md

export const RESOLVE_OUTCOME = ['SUCCESS', 'PARTIAL', 'FAIL'] as const;
export type ResolveOutcome = (typeof RESOLVE_OUTCOME)[number];

export type ResolveResult = {
  score: number;
  outcome: ResolveOutcome;
  eventId: string;
  heatDelta: number; // ±8 clamp
  tensionDelta: number;
  influenceDelta: number;
  goldDelta: number; // BRIBE/TRADE 골드 비용 (음수)
  relationChanges: Record<string, number>;
  flagsSet: string[];
  deferredEffects: Array<{
    id: string;
    type: string;
    triggerTurnDelay: number;
    data: Record<string, unknown>;
  }>;
  reputationChanges: Record<string, number>;
  agendaBucketDelta: Record<string, number>;
  commitmentDelta: number;
  triggerCombat: boolean;
  combatEncounterId?: string;
};
