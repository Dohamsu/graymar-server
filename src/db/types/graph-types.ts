// 정본: design/node_routing_v2.md — DAG 그래프 타입 정의

import type { NodeType, EdgeConditionType } from './enums.js';

export interface EdgeCondition {
  type: EdgeConditionType;
  choiceId?: string;
  combatOutcome?: string;
  /** RANDOM 조건에서 사용. 가중치 비율 (예: weight=60 → 60%) */
  weight?: number;
}

export interface EdgeDefinition {
  targetNodeId: string;
  condition: EdgeCondition;
  priority: number;
}

export interface PlannedNodeV2 {
  nodeId: string;
  nodeType: NodeType;
  nodeMeta: Record<string, unknown>;
  environmentTags: string[];
  edges: EdgeDefinition[];
}

export interface RouteContext {
  lastChoiceId?: string;
  combatOutcome?: string;
  routeTag?: string;
  /** RANDOM 엣지 평가용 시드 (0~1 사이 값) */
  randomSeed?: number;
}
