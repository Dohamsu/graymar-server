// 정본: design/node_routing_v2.md — DAG 그래프 타입 정의

import type { NodeType, EdgeConditionType } from './enums.js';

export interface EdgeCondition {
  type: EdgeConditionType;
  choiceId?: string;
  combatOutcome?: string;
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
}
