import { Injectable } from '@nestjs/common';
import type {
  WorldState,
  ResolveOutcome,
  IncidentRoutingResult,
  IncidentRuntime,
} from '../../db/types/index.js';

/**
 * ResolveResult + IncidentRoutingResult → incident 확장 필드 업데이트.
 * PR2에서 추가된 suspicion/security/playerProgress/rivalProgress/vectors를
 * 라우팅 결과와 판정 결과에 따라 세밀하게 조정.
 */
@Injectable()
export class IncidentResolutionBridgeService {
  /**
   * resolve 이후 incident 확장 필드를 업데이트.
   * routingResult가 FALLBACK_SCENE이거나 incident가 없으면 ws를 그대로 반환.
   */
  apply(
    ws: WorldState,
    outcome: ResolveOutcome,
    routingResult: IncidentRoutingResult,
  ): WorldState {
    if (
      routingResult.routeMode === 'FALLBACK_SCENE' ||
      !routingResult.incident
    ) {
      return ws;
    }

    const targetId = routingResult.incident.incidentId;
    const matchedVector = routingResult.matchedVector;

    const updatedIncidents = (ws.activeIncidents ?? []).map((inc) => {
      if (inc.incidentId !== targetId) return inc;

      let updated: IncidentRuntime = { ...inc };

      // 1. vector 매칭 결과에 따른 효과
      if (matchedVector && updated.vectors) {
        updated = this.applyVectorEffect(updated, matchedVector, outcome);
      }

      // 2. outcome에 따른 suspicion/security 조정
      updated = this.applyOutcomeEffect(updated, outcome, routingResult);

      return updated;
    });

    return { ...ws, activeIncidents: updatedIncidents };
  }

  private applyVectorEffect(
    inc: IncidentRuntime,
    matchedVector: string,
    outcome: ResolveOutcome,
  ): IncidentRuntime {
    const vectors = (inc.vectors ?? []).map((v) => {
      if (v.vector !== matchedVector) return v;

      const updated = { ...v };

      if (outcome === 'SUCCESS') {
        // 성공 시 friction 감소 (최소 0)
        updated.friction = Math.max(0, updated.friction - 1);
      } else if (outcome === 'FAIL') {
        // 실패 시 friction 증가 (최대 3)
        updated.friction = Math.min(3, updated.friction + 1);
      }

      return updated;
    });

    return { ...inc, vectors };
  }

  private applyOutcomeEffect(
    inc: IncidentRuntime,
    outcome: ResolveOutcome,
    routingResult: IncidentRoutingResult,
  ): IncidentRuntime {
    const suspicion = inc.suspicion ?? 0;
    const security = inc.security ?? 0;

    if (outcome === 'SUCCESS') {
      // DIRECT_MATCH 성공 → suspicion 약간 감소 (사건 해결에 기여)
      if (routingResult.routeMode === 'DIRECT_MATCH') {
        return {
          ...inc,
          suspicion: Math.max(0, suspicion - 2),
        };
      }
    } else if (outcome === 'FAIL') {
      // 실패 시 suspicion 증가, STEALTH vector 사용 실패 시 security도 증가
      let newSuspicion = Math.min(100, suspicion + 5);
      let newSecurity = security;

      if (routingResult.matchedVector === 'STEALTH') {
        newSecurity = Math.min(100, security + 3);
        newSuspicion = Math.min(100, newSuspicion + 3); // 추가 의심
      }

      return {
        ...inc,
        suspicion: newSuspicion,
        security: newSecurity,
      };
    } else if (outcome === 'PARTIAL') {
      // 부분 성공 → 약한 suspicion 증가
      return {
        ...inc,
        suspicion: Math.min(100, suspicion + 2),
      };
    }

    return inc;
  }
}
