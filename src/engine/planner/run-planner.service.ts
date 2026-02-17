// 정본: design/node_routing_v2.md — 24노드 DAG 그래프 + 기존 12노드 선형 시퀀스

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

export interface PlannedNode {
  nodeIndex: number;
  nodeType: NodeType;
  nodeMeta: NodeMeta;
  environmentTags: string[];
}

@Injectable()
export class RunPlannerService {
  private graphMap: Map<string, PlannedNodeV2> | null = null;

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
    return 'common_s0';
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
      return this.pickRandomEdge(randomEdges, context.randomSeed ?? Math.random());
    }

    const sortedEdges = [...node.edges].sort((a, b) => a.priority - b.priority);

    for (const edge of sortedEdges) {
      if (this.evaluateCondition(edge.condition, context)) {
        return edge.targetNodeId;
      }
    }

    throw new InternalError(`No matching edge for node ${currentGraphNodeId}`);
  }

  private pickRandomEdge(
    edges: EdgeDefinition[],
    seed: number,
  ): string {
    const totalWeight = edges.reduce((sum, e) => sum + (e.condition.weight ?? 1), 0);
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
    const graph = this.getGraymarGraph();
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
    if (!this.graphMap) {
      this.graphMap = new Map<string, PlannedNodeV2>();
      for (const node of this.getGraymarGraph()) {
        this.graphMap.set(node.nodeId, node);
      }
    }
    return this.graphMap;
  }

  /**
   * 24노드 DAG (4 공통 + 6×3 루트 + 2 합류)
   * 정본: design/node_routing_v2.md §4 + 부록A
   */
  getGraymarGraph(): PlannedNodeV2[] {
    return [
      // ── 공통 구간 (4노드, 순서 랜덤 분기) ──
      //
      // 경로 A (50%): s0 → s1(이벤트) → combat → s2
      // 경로 B (50%): s0 → combat → s1(이벤트) → s2
      {
        nodeId: 'common_s0',
        nodeType: 'EVENT',
        nodeMeta: { isIntro: true, eventId: 'S0_ARRIVE' },
        environmentTags: ['HARBOR', 'NIGHT'],
        edges: [
          {
            targetNodeId: 'common_s1',
            condition: { type: 'RANDOM', weight: 50 },
            priority: 1,
          },
          {
            targetNodeId: 'common_combat_dock_early',
            condition: { type: 'RANDOM', weight: 50 },
            priority: 2,
          },
        ],
      },
      // 경로 A: 이벤트 먼저
      {
        nodeId: 'common_s1',
        nodeType: 'EVENT',
        nodeMeta: { eventId: 'S1_GET_ANGLE' },
        environmentTags: ['HARBOR', 'NIGHT'],
        edges: [
          {
            targetNodeId: 'common_combat_dock',
            condition: { type: 'DEFAULT' },
            priority: 1,
          },
        ],
      },
      {
        nodeId: 'common_combat_dock',
        nodeType: 'COMBAT',
        nodeMeta: { isBoss: false, eventId: 'ENC_DOCK_AMBUSH' },
        environmentTags: ['OPEN', 'COVER_CRATE'],
        edges: [
          {
            targetNodeId: 'common_s2',
            condition: { type: 'DEFAULT' },
            priority: 1,
          },
        ],
      },
      // 경로 B: 전투 먼저
      {
        nodeId: 'common_combat_dock_early',
        nodeType: 'COMBAT',
        nodeMeta: { isBoss: false, eventId: 'ENC_DOCK_AMBUSH' },
        environmentTags: ['OPEN', 'COVER_CRATE'],
        edges: [
          {
            targetNodeId: 'common_s1_late',
            condition: { type: 'DEFAULT' },
            priority: 1,
          },
        ],
      },
      {
        nodeId: 'common_s1_late',
        nodeType: 'EVENT',
        nodeMeta: { eventId: 'S1_GET_ANGLE' },
        environmentTags: ['HARBOR', 'NIGHT'],
        edges: [
          {
            targetNodeId: 'common_s2',
            condition: { type: 'DEFAULT' },
            priority: 1,
          },
        ],
      },
      {
        nodeId: 'common_s2',
        nodeType: 'EVENT',
        nodeMeta: { eventId: 'S2_PROVE_TAMPER' },
        environmentTags: ['HARBOR', 'NIGHT'],
        edges: [
          {
            targetNodeId: 'guild_rest',
            condition: { type: 'CHOICE', choiceId: 'guild_ally' },
            priority: 1,
          },
          {
            targetNodeId: 'guard_event_s3',
            condition: { type: 'CHOICE', choiceId: 'guard_ally' },
            priority: 2,
          },
          {
            targetNodeId: 'solo_event_s3',
            condition: { type: 'CHOICE', choiceId: 'solo_path' },
            priority: 3,
          },
        ],
      },

      // ── 길드 루트 (6노드) ──
      {
        nodeId: 'guild_rest',
        nodeType: 'REST',
        nodeMeta: {},
        environmentTags: ['INDOOR', 'SAFE'],
        edges: [
          {
            targetNodeId: 'guild_shop',
            condition: { type: 'DEFAULT' },
            priority: 1,
          },
        ],
      },
      {
        nodeId: 'guild_shop',
        nodeType: 'SHOP',
        nodeMeta: { shopId: 'SHOP_GUILD_ARMS' },
        environmentTags: ['INDOOR', 'MARKET'],
        edges: [
          {
            targetNodeId: 'guild_event_s3',
            condition: { type: 'DEFAULT' },
            priority: 1,
          },
        ],
      },
      {
        nodeId: 'guild_event_s3',
        nodeType: 'EVENT',
        nodeMeta: { eventId: 'S3_GUILD' },
        environmentTags: ['HARBOR', 'EAST_DOCK'],
        edges: [
          {
            targetNodeId: 'guild_combat',
            condition: { type: 'DEFAULT' },
            priority: 1,
          },
        ],
      },
      {
        nodeId: 'guild_combat',
        nodeType: 'COMBAT',
        nodeMeta: { isBoss: false, eventId: 'ENC_WHARF_RAID' },
        environmentTags: ['OPEN', 'COVER_CRATE', 'NIGHT'],
        edges: [
          {
            targetNodeId: 'guild_event_s4',
            condition: { type: 'DEFAULT' },
            priority: 1,
          },
        ],
      },
      {
        nodeId: 'guild_event_s4',
        nodeType: 'EVENT',
        nodeMeta: { eventId: 'S4_GUILD' },
        environmentTags: ['HARBOR', 'GUARD_POST'],
        edges: [
          {
            targetNodeId: 'guild_boss',
            condition: { type: 'DEFAULT' },
            priority: 1,
          },
        ],
      },
      {
        nodeId: 'guild_boss',
        nodeType: 'COMBAT',
        nodeMeta: { isBoss: true, eventId: 'ENC_GUILD_BOSS' },
        environmentTags: ['OPEN', 'COVER_WALL', 'NIGHT'],
        edges: [
          {
            targetNodeId: 'merge_s5',
            condition: { type: 'DEFAULT' },
            priority: 1,
          },
        ],
      },

      // ── 경비대 루트 (6노드) ──
      {
        nodeId: 'guard_event_s3',
        nodeType: 'EVENT',
        nodeMeta: { eventId: 'S3_GUARD' },
        environmentTags: ['INDOOR', 'GUARD_POST'],
        edges: [
          {
            targetNodeId: 'guard_shop',
            condition: { type: 'DEFAULT' },
            priority: 1,
          },
        ],
      },
      {
        nodeId: 'guard_shop',
        nodeType: 'SHOP',
        nodeMeta: { shopId: 'SHOP_GUARD_SUPPLY' },
        environmentTags: ['INDOOR', 'GUARD_POST'],
        edges: [
          {
            targetNodeId: 'guard_combat',
            condition: { type: 'DEFAULT' },
            priority: 1,
          },
        ],
      },
      {
        nodeId: 'guard_combat',
        nodeType: 'COMBAT',
        nodeMeta: { isBoss: false, eventId: 'ENC_BARRACKS' },
        environmentTags: ['INDOOR', 'NARROW'],
        edges: [
          {
            targetNodeId: 'guard_event_s4',
            condition: { type: 'DEFAULT' },
            priority: 1,
          },
        ],
      },
      {
        nodeId: 'guard_event_s4',
        nodeType: 'EVENT',
        nodeMeta: { eventId: 'S4_GUARD' },
        environmentTags: ['INDOOR', 'GUARD_POST'],
        edges: [
          {
            targetNodeId: 'guard_rest',
            condition: { type: 'DEFAULT' },
            priority: 1,
          },
        ],
      },
      {
        nodeId: 'guard_rest',
        nodeType: 'REST',
        nodeMeta: {},
        environmentTags: ['INDOOR', 'SAFE'],
        edges: [
          {
            targetNodeId: 'guard_boss',
            condition: { type: 'DEFAULT' },
            priority: 1,
          },
        ],
      },
      {
        nodeId: 'guard_boss',
        nodeType: 'COMBAT',
        nodeMeta: { isBoss: true, eventId: 'ENC_GUARD_BOSS' },
        environmentTags: ['OPEN', 'COVER_WALL', 'AFTERNOON'],
        edges: [
          {
            targetNodeId: 'merge_s5',
            condition: { type: 'DEFAULT' },
            priority: 1,
          },
        ],
      },

      // ── 독자 루트 (6노드) ──
      {
        nodeId: 'solo_event_s3',
        nodeType: 'EVENT',
        nodeMeta: { eventId: 'S3_SOLO' },
        environmentTags: ['NARROW', 'NIGHT'],
        edges: [
          {
            targetNodeId: 'solo_combat',
            condition: { type: 'DEFAULT' },
            priority: 1,
          },
        ],
      },
      {
        nodeId: 'solo_combat',
        nodeType: 'COMBAT',
        nodeMeta: { isBoss: false, eventId: 'ENC_ALLEY' },
        environmentTags: ['NARROW', 'COVER_WALL', 'NIGHT'],
        edges: [
          {
            targetNodeId: 'solo_rest',
            condition: { type: 'DEFAULT' },
            priority: 1,
          },
        ],
      },
      {
        nodeId: 'solo_rest',
        nodeType: 'REST',
        nodeMeta: {},
        environmentTags: ['INDOOR'],
        edges: [
          {
            targetNodeId: 'solo_shop',
            condition: { type: 'DEFAULT' },
            priority: 1,
          },
        ],
      },
      {
        nodeId: 'solo_shop',
        nodeType: 'SHOP',
        nodeMeta: { shopId: 'SHOP_BLACK_MARKET' },
        environmentTags: ['NARROW', 'NIGHT'],
        edges: [
          {
            targetNodeId: 'solo_event_s4',
            condition: { type: 'DEFAULT' },
            priority: 1,
          },
        ],
      },
      {
        nodeId: 'solo_event_s4',
        nodeType: 'EVENT',
        nodeMeta: { eventId: 'S4_SOLO' },
        environmentTags: ['INDOOR', 'NARROW', 'NIGHT'],
        edges: [
          {
            targetNodeId: 'solo_boss',
            condition: { type: 'DEFAULT' },
            priority: 1,
          },
        ],
      },
      {
        nodeId: 'solo_boss',
        nodeType: 'COMBAT',
        nodeMeta: { isBoss: true, eventId: 'ENC_SOLO_BOSS' },
        environmentTags: ['INDOOR', 'NARROW', 'NIGHT'],
        edges: [
          {
            targetNodeId: 'merge_s5',
            condition: { type: 'DEFAULT' },
            priority: 1,
          },
        ],
      },

      // ── 합류 구간 (2노드) ──
      {
        nodeId: 'merge_s5',
        nodeType: 'EVENT',
        nodeMeta: { eventId: 'S5_RESOLVE' }, // 실제 eventId는 전환 시 S5_RESOLVE_{routeTag}로 동적 설정
        environmentTags: ['HARBOR', 'TOWN_HALL'],
        edges: [
          {
            targetNodeId: 'merge_exit',
            condition: { type: 'DEFAULT' },
            priority: 1,
          },
        ],
      },
      {
        nodeId: 'merge_exit',
        nodeType: 'EXIT',
        nodeMeta: {},
        environmentTags: ['HARBOR'],
        edges: [],
      },
    ];
  }
}
