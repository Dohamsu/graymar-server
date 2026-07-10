// 정본: specs/node_routing_v2.md — 24노드 DAG 그래프 + 기존 12노드 선형 시퀀스

import { Injectable } from '@nestjs/common';
import type { NodeType } from '../../db/types/index.js';
import type { NodeMeta } from '../../db/types/index.js';
import type {
  PlannedNodeV2,
  RouteContext,
  EdgeCondition,
  EdgeDefinition,
} from '../../db/types/index.js';
import type { RouteTag } from '../../db/types/index.js';
import { InternalError } from '../../common/errors/game-errors.js';
import { ContentLoaderService } from '../../content/content-loader.service.js';

export interface PlannedNode {
  nodeIndex: number;
  nodeType: NodeType;
  nodeMeta: NodeMeta;
  environmentTags: string[];
}

@Injectable()
export class RunPlannerService {
  constructor(private readonly content: ContentLoaderService) {}

  private graphMap: Map<string, PlannedNodeV2> | null = null;
  /** graphMap 캐시가 어느 시나리오 기준인지 — loadScenario 후 무효화용 */
  private graphMapScenarioId: string | null = null;

  /**
   * architecture/63: DAG 그래프 — content/<pack>/graph.json 파생
   * (구 getGraymarGraph() 하드코딩). 규약: 첫 노드가 시작 노드.
   */
  private getGraph(): PlannedNodeV2[] {
    const graph = this.content.getGraph();
    if (graph.length === 0) {
      throw new InternalError(
        `graph.json 없음 — 시나리오 '${this.content.getCurrentScenarioId()}'는 dag 모드를 지원하지 않습니다`,
      );
    }
    return graph;
  }

  /**
   * 기존 12노드 선형 시퀀스 (legacy 호환)
   */
  planGraymarVerticalSlice(): PlannedNode[] {
    return [
      {
        nodeIndex: 0,
        nodeType: 'EVENT',
        nodeMeta: { isIntro: true, eventId: 'S0_ARRIVE' },
        environmentTags: ['HARBOR', 'NIGHT'],
      },
      {
        nodeIndex: 1,
        nodeType: 'EVENT',
        nodeMeta: { eventId: 'S1_GET_ANGLE' },
        environmentTags: ['HARBOR', 'NIGHT'],
      },
      {
        nodeIndex: 2,
        nodeType: 'COMBAT',
        nodeMeta: { isBoss: false, eventId: 'ENC_DOCK_AMBUSH' },
        environmentTags: ['OPEN', 'COVER_CRATE'],
      },
      {
        nodeIndex: 3,
        nodeType: 'EVENT',
        nodeMeta: { eventId: 'S2_PROVE_TAMPER' },
        environmentTags: ['HARBOR', 'NIGHT'],
      },
      {
        nodeIndex: 4,
        nodeType: 'REST',
        nodeMeta: {},
        environmentTags: ['HARBOR', 'INN'],
      },
      {
        nodeIndex: 5,
        nodeType: 'SHOP',
        nodeMeta: { shopId: 'HARBOR_SHOP' },
        environmentTags: ['HARBOR', 'MARKET'],
      },
      {
        nodeIndex: 6,
        nodeType: 'EVENT',
        nodeMeta: { eventId: 'S3_TRACE_ROUTE' },
        environmentTags: ['HARBOR', 'EAST_DOCK'],
      },
      {
        nodeIndex: 7,
        nodeType: 'COMBAT',
        nodeMeta: { isBoss: false, eventId: 'ENC_WAREHOUSE_INFILTRATION' },
        environmentTags: ['COVER_CRATE', 'NARROW'],
      },
      {
        nodeIndex: 8,
        nodeType: 'EVENT',
        nodeMeta: { eventId: 'S4_CONFRONT' },
        environmentTags: ['HARBOR', 'GUARD_POST'],
      },
      {
        nodeIndex: 9,
        nodeType: 'COMBAT',
        nodeMeta: { isBoss: true, eventId: 'ENC_GUARD_CONFRONTATION' },
        environmentTags: ['OPEN', 'COVER_WALL'],
      },
      {
        nodeIndex: 10,
        nodeType: 'EVENT',
        nodeMeta: { eventId: 'S5_RESOLVE' },
        environmentTags: ['HARBOR', 'TOWN_HALL'],
      },
      {
        nodeIndex: 11,
        nodeType: 'EXIT',
        nodeMeta: {},
        environmentTags: ['HARBOR'],
      },
    ];
  }

  // ── DAG 그래프 메서드 ──

  getStartNodeId(): string {
    // 규약: graph.json 첫 노드 = 시작 노드
    return this.getGraph()[0].nodeId;
  }

  findNode(nodeId: string): PlannedNodeV2 | undefined {
    return this.getGraphMap().get(nodeId);
  }

  /**
   * 현재 노드의 엣지를 priority순 평가하여 다음 노드 ID를 결정한다.
   */
  resolveNextNodeId(
    currentGraphNodeId: string,
    context: RouteContext,
  ): string | null {
    const node = this.findNode(currentGraphNodeId);
    if (!node || node.edges.length === 0) return null;

    // RANDOM 엣지가 있으면 가중치 기반 선택
    const randomEdges = node.edges.filter((e) => e.condition.type === 'RANDOM');
    if (randomEdges.length > 0) {
      return this.pickRandomEdge(
        randomEdges,
        context.randomSeed ?? Math.random(),
      );
    }

    const sortedEdges = [...node.edges].sort((a, b) => a.priority - b.priority);

    for (const edge of sortedEdges) {
      if (this.evaluateCondition(edge.condition, context)) {
        return edge.targetNodeId;
      }
    }

    throw new InternalError(`No matching edge for node ${currentGraphNodeId}`);
  }

  private pickRandomEdge(edges: EdgeDefinition[], seed: number): string {
    const totalWeight = edges.reduce(
      (sum, e) => sum + (e.condition.weight ?? 1),
      0,
    );
    let roll = seed * totalWeight;
    for (const edge of edges) {
      roll -= edge.condition.weight ?? 1;
      if (roll <= 0) return edge.targetNodeId;
    }
    return edges[edges.length - 1].targetNodeId;
  }

  /**
   * S2 분기 choiceId → RouteTag 매핑
   */
  resolveRouteTag(choiceId?: string): RouteTag | undefined {
    const mapping: Record<string, RouteTag> = {
      guild_ally: 'GUILD',
      guard_ally: 'GUARD',
      solo_path: 'SOLO',
    };
    return choiceId ? mapping[choiceId] : undefined;
  }

  /**
   * DAG 순환 검증 (DFS)
   */
  validateGraph(): void {
    const graph = this.getGraph();
    const visited = new Set<string>();
    const stack = new Set<string>();

    const dfs = (nodeId: string) => {
      if (stack.has(nodeId)) {
        throw new InternalError(`Cycle detected in graph at node: ${nodeId}`);
      }
      if (visited.has(nodeId)) return;

      visited.add(nodeId);
      stack.add(nodeId);

      const node = this.getGraphMap().get(nodeId);
      if (node) {
        for (const edge of node.edges) {
          dfs(edge.targetNodeId);
        }
      }

      stack.delete(nodeId);
    };

    for (const node of graph) {
      dfs(node.nodeId);
    }
  }

  // ── 내부 메서드 ──

  private evaluateCondition(
    condition: EdgeCondition,
    context: RouteContext,
  ): boolean {
    switch (condition.type) {
      case 'DEFAULT':
        return true;
      case 'CHOICE':
        return context.lastChoiceId === condition.choiceId;
      case 'COMBAT_OUTCOME':
        return context.combatOutcome === condition.combatOutcome;
      default:
        return false;
    }
  }

  private getGraphMap(): Map<string, PlannedNodeV2> {
    const scenarioId = this.content.getCurrentScenarioId();
    if (!this.graphMap || this.graphMapScenarioId !== scenarioId) {
      this.graphMap = new Map<string, PlannedNodeV2>();
      for (const node of this.getGraph()) {
        this.graphMap.set(node.nodeId, node);
      }
      this.graphMapScenarioId = scenarioId;
    }
    return this.graphMap;
  }
}
