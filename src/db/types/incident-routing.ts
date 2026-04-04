// PR5: IncidentRouter 라우팅 결과 타입

import type { IncidentRuntime, IncidentDef } from './incident.js';

export type IncidentRouteMode =
  | 'DIRECT_MATCH' // approachVector가 incident vector와 직접 일치
  | 'GOAL_AFFINITY' // goalCategory와 incident kind가 연관
  | 'FALLBACK_SCENE'; // incident 매칭 없음 → 기존 이벤트 매칭으로 폴백

export type IncidentRoutingResult = {
  routeMode: IncidentRouteMode;
  incident: IncidentRuntime | null;
  def: IncidentDef | null;
  matchScore: number; // 0~100, 매칭 품질
  matchedVector: string | null; // 매칭된 IncidentVectorState.vector
  tags: string[]; // 이벤트 매칭에 전달할 부스트 태그
};
