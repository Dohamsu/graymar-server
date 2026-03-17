import { Injectable } from '@nestjs/common';
import type {
  WorldState,
  IncidentRuntime,
  IncidentDef,
  ParsedIntentV3,
  IncidentVectorState,
  IncidentRoutingResult,
  IncidentRouteMode,
  IncidentKind,
  IntentGoalCategory,
} from '../../db/types/index.js';

/** incident.kind ↔ goalCategory 연관 점수 (0~20) */
const KIND_GOAL_AFFINITY: Partial<Record<IncidentKind, Partial<Record<IntentGoalCategory, number>>>> = {
  CRIMINAL: { GAIN_ACCESS: 15, HIDE_TRACE: 20, GET_INFO: 10, BLOCK_RIVAL: 10 },
  POLITICAL: { SHIFT_RELATION: 20, GET_INFO: 15, BLOCK_RIVAL: 15, ESCALATE_CONFLICT: 10 },
  ECONOMIC: { ACQUIRE_RESOURCE: 20, GET_INFO: 10, BLOCK_RIVAL: 10 },
  SOCIAL: { SHIFT_RELATION: 20, DEESCALATE_CONFLICT: 15, GET_INFO: 10 },
  MILITARY: { ESCALATE_CONFLICT: 20, BLOCK_RIVAL: 15, GAIN_ACCESS: 10 },
};

const MATCH_THRESHOLD = 15;

@Injectable()
export class IncidentRouterService {
  /**
   * active incident 중 intentV3와 가장 잘 맞는 incident를 선택.
   * 매칭 없으면 FALLBACK_SCENE 반환.
   */
  route(
    ws: WorldState,
    locationId: string,
    intentV3: ParsedIntentV3,
    incidentDefs: IncidentDef[],
  ): IncidentRoutingResult {
    const activeIncidents = (ws.activeIncidents ?? []).filter((i) => !i.resolved);

    if (activeIncidents.length === 0) {
      return this.fallback();
    }

    const defMap = new Map(incidentDefs.map((d) => [d.incidentId, d]));

    let bestScore = 0;
    let bestIncident: IncidentRuntime | null = null;
    let bestDef: IncidentDef | null = null;
    let bestVector: string | null = null;
    let bestMode: IncidentRouteMode = 'FALLBACK_SCENE';

    for (const incident of activeIncidents) {
      const def = defMap.get(incident.incidentId);
      if (!def) continue;

      let score = 0;
      let matchedVector: string | null = null;
      let mode: IncidentRouteMode = 'GOAL_AFFINITY';

      // 1. location 일치 가산
      if (def.locationId === locationId) {
        score += 10;
      }

      // 2. approachVector ↔ incident vectors 매칭
      const vectors = incident.vectors ?? [];
      const vectorMatch = this.findVectorMatch(vectors, intentV3.approachVector);
      if (vectorMatch) {
        score += 30 + (vectorMatch.preferred ? 15 : 0) - vectorMatch.friction * 5;
        matchedVector = vectorMatch.vector;
        mode = 'DIRECT_MATCH';
      }

      // secondary vector 체크
      if (intentV3.secondaryApproachVector) {
        const secMatch = this.findVectorMatch(vectors, intentV3.secondaryApproachVector);
        if (secMatch) {
          score += 10 + (secMatch.preferred ? 5 : 0);
          if (!matchedVector) {
            matchedVector = secMatch.vector;
            mode = 'DIRECT_MATCH';
          }
        }
      }

      // 3. kind ↔ goalCategory 연관성
      const affinity = KIND_GOAL_AFFINITY[incident.kind]?.[intentV3.goalCategory] ?? 0;
      score += affinity;

      // 4. pressure 보정 (긴급한 incident 우선)
      if (incident.pressure >= 60) score += 5;
      if (incident.pressure >= 80) score += 10;

      if (score > bestScore) {
        bestScore = score;
        bestIncident = incident;
        bestDef = def;
        bestVector = matchedVector;
        bestMode = mode;
      }
    }

    if (bestScore < MATCH_THRESHOLD || !bestIncident || !bestDef) {
      return this.fallback();
    }

    // 매칭된 incident 관련 태그 생성
    const tags = this.buildRoutingTags(bestIncident, bestDef, bestVector);

    return {
      routeMode: bestMode,
      incident: bestIncident,
      def: bestDef,
      matchScore: Math.min(100, bestScore),
      matchedVector: bestVector,
      tags,
    };
  }

  private findVectorMatch(
    vectors: IncidentVectorState[],
    approachVector: string,
  ): IncidentVectorState | null {
    return vectors.find((v) => v.enabled && v.vector === approachVector) ?? null;
  }

  private buildRoutingTags(
    incident: IncidentRuntime,
    def: IncidentDef,
    matchedVector: string | null,
  ): string[] {
    const tags: string[] = [
      `incident:${incident.incidentId}`,
      `kind:${incident.kind}`,
    ];
    if (matchedVector) {
      tags.push(`vector:${matchedVector}`);
    }
    if (def.relatedNpcIds.length > 0) {
      tags.push(...def.relatedNpcIds.map((id) => `npc:${id}`));
    }
    tags.push(...def.tags);
    return tags;
  }

  private fallback(): IncidentRoutingResult {
    return {
      routeMode: 'FALLBACK_SCENE',
      incident: null,
      def: null,
      matchScore: 0,
      matchedVector: null,
      tags: [],
    };
  }
}
