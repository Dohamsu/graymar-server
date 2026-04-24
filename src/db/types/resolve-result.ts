// 정본: specs/HUB_resolve_system.md + Narrative_Engine_v1_Integrated_Spec.md

import type { IncidentImpactPatch } from './incident.js';

export const RESOLVE_OUTCOME = ['SUCCESS', 'PARTIAL', 'FAIL'] as const;
export type ResolveOutcome = (typeof RESOLVE_OUTCOME)[number];

export type ResolveResult = {
  score: number;
  outcome: ResolveOutcome;
  // UI 표시용 주사위 분해 (비도전 행위에는 없음)
  diceRoll?: number;
  statKey?: string | null;
  statValue?: number;
  statBonus?: number;
  baseMod?: number;
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
  // Trait runtime effects
  traitBonus?: number; // BLOOD_OATH lowHpBonus + NIGHT_CHILD time bonus 합산
  gamblerLuckTriggered?: boolean; // GAMBLER_LUCK FAIL->PARTIAL 승격 발동 여부
  // Narrative Engine v1
  incidentPatches?: IncidentImpactPatch[];
  matchedIncidentId?: string;
  // architecture/43: 돌발행동 감지 결과 (turns.service가 NPC 상태 반영)
  suddenAction?: {
    severity: 'CRITICAL' | 'SEVERE' | 'MODERATE' | 'MINOR';
    type:
      | 'KILL_ATTEMPT'
      | 'ASSAULT'
      | 'WEAPON_THREAT'
      | 'THEFT'
      | 'VERBAL_THREAT';
    targetNpcId: string | null;
    summary: string;
  };
};
