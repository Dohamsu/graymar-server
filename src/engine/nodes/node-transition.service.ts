// NODE_ENDED → 다음 노드 진입 처리 (DAG 분기 지원)

import { Inject, Injectable } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { DB, type DrizzleDB } from '../../db/drizzle.module.js';
import {
  runSessions,
  nodeInstances,
  battleStates,
} from '../../db/schema/index.js';
import type {
  BattleStateV1,
  ServerResultV1,
  RunState,
} from '../../db/types/index.js';
import type { NodeType, ToneHint } from '../../db/types/index.js';
import type { RouteContext } from '../../db/types/index.js';
import { ContentLoaderService } from '../../content/content-loader.service.js';
import { EventContentProvider } from '../../content/event-content.provider.js';
import { RunPlannerService } from '../planner/run-planner.service.js';
import { InternalError } from '../../common/errors/game-errors.js';
import { toDisplayText } from '../../common/text-utils.js';

export interface NodeTransitionResult {
  nextNodeIndex: number;
  nextNodeType: NodeType;
  enterResult: ServerResultV1;
  battleState?: BattleStateV1;
  routeTag?: string;
}

@Injectable()
export class NodeTransitionService {
  constructor(
    @Inject(DB) private readonly db: DrizzleDB,
    private readonly content: ContentLoaderService,
    private readonly eventContent: EventContentProvider,
    private readonly planner: RunPlannerService,
  ) {}

  /**
   * DAG 기반 다음 노드 전환.
   * currentGraphNodeId가 null이면 legacy fallback (currentNodeIndex + 1).
   */
  async advanceToNextNode(
    runId: string,
    currentNodeIndex: number,
    turnNo: number,
    seed: string,
    playerHp: number,
    playerStamina: number,
    currentGraphNodeId?: string | null,
    context?: RouteContext,
    runState?: RunState,
  ): Promise<NodeTransitionResult | null> {
    // Legacy fallback: graphNodeId가 없으면 기존 선형 전환
    if (!currentGraphNodeId) {
      return this.advanceLegacy(
        runId,
        currentNodeIndex,
        turnNo,
        seed,
        playerHp,
        playerStamina,
      );
    }

    // DAG 기반 전환
    const routeContext = context ?? {};
    // RANDOM 엣지 평가용: seed + nodeIndex로 결정론적 난수 생성
    if (routeContext.randomSeed === undefined) {
      routeContext.randomSeed = this.deterministicRandom(seed, currentNodeIndex);
    }
    const nextGraphNodeId = this.planner.resolveNextNodeId(
      currentGraphNodeId,
      routeContext,
    );
    if (!nextGraphNodeId) return null; // EXIT 이후

    const nodeDef = this.planner.findNode(nextGraphNodeId);
    if (!nodeDef) {
      throw new InternalError(`Node definition not found: ${nextGraphNodeId}`);
    }

    const nextIndex = currentNodeIndex + 1;

    // 분기점(common_s2)에서 routeTag 결정
    let routeTag = routeContext.routeTag;
    if (currentGraphNodeId === 'common_s2') {
      routeTag =
        this.planner.resolveRouteTag(routeContext.lastChoiceId) ?? routeTag;
    }

    // merge_s5 진입 시 eventId를 루트별로 동적 설정
    const nodeMeta = { ...nodeDef.nodeMeta };
    if (nextGraphNodeId === 'merge_s5' && routeTag) {
      nodeMeta.eventId = `S5_RESOLVE_${routeTag}`;
    }

    // SHOP 노드 → lazy 카탈로그 생성
    let nodeState: Record<string, unknown> | null = null;
    if (nodeDef.nodeType === 'SHOP') {
      const shopId = (nodeMeta.shopId as string) ?? 'HARBOR_SHOP';
      const catalog = this.content.getShopCatalog(shopId).map((it) => ({
        itemId: it.itemId,
        name: it.name,
        price: it.buyPrice ?? 0,
        stock: it.maxStack ?? 1,
        description: it.description ?? '',
      }));
      nodeState = {
        shopId,
        catalog,
        playerGold: runState?.gold ?? 0,
      };
    }

    // EVENT 노드 → 초기 nodeState 설정
    if (nodeDef.nodeType === 'EVENT') {
      const eventId = (nodeMeta.eventId as string) ?? 'default';
      nodeState = {
        eventId,
        stage: 0,
        maxStage: this.eventContent.getMaxStage(eventId),
        choicesMade: [],
      };
    }

    // node_instances INSERT (lazy 생성)
    await this.db.insert(nodeInstances).values({
      runId,
      nodeIndex: nextIndex,
      graphNodeId: nextGraphNodeId,
      nodeType: nodeDef.nodeType,
      nodeMeta,
      environmentTags: nodeDef.environmentTags,
      edges: nodeDef.edges,
      status: 'NODE_ACTIVE',
      nodeState,
    });

    // run_sessions UPDATE
    await this.db
      .update(runSessions)
      .set({
        currentNodeIndex: nextIndex,
        currentGraphNodeId: nextGraphNodeId,
        routeTag: routeTag ?? null,
        updatedAt: new Date(),
      })
      .where(eq(runSessions.id, runId));

    const nodeType = nodeDef.nodeType;

    // 새로 INSERT한 노드의 ID를 조회
    const newNode = await this.db.query.nodeInstances.findFirst({
      where: and(
        eq(nodeInstances.runId, runId),
        eq(nodeInstances.nodeIndex, nextIndex),
      ),
    });
    if (!newNode) throw new InternalError('Failed to find newly created node');

    // COMBAT 노드 → BattleState 초기화
    let battleState: BattleStateV1 | undefined;
    if (nodeType === 'COMBAT') {
      battleState = await this.initBattleState(
        runId,
        newNode.id,
        nodeMeta,
        nodeDef.environmentTags,
        seed,
        turnNo,
        playerHp,
        playerStamina,
      );
    }

    // 노드 진입 결과 생성
    const enterResult = this.buildEnterResult(
      turnNo,
      newNode.id,
      nextIndex,
      nodeType,
      nodeMeta,
      nodeDef.environmentTags,
      battleState,
      nodeState,
    );

    return {
      nextNodeIndex: nextIndex,
      nextNodeType: nodeType,
      enterResult,
      battleState,
      routeTag: routeTag ?? undefined,
    };
  }

  /** seed + index → 결정론적 0~1 난수 (simple hash) */
  private deterministicRandom(seed: string, index: number): number {
    let hash = 0;
    const str = `${seed}_node_${index}`;
    for (let i = 0; i < str.length; i++) {
      hash = ((hash << 5) - hash + str.charCodeAt(i)) | 0;
    }
    return Math.abs(hash % 10000) / 10000;
  }

  /**
   * Legacy: 기존 선형 전환 (currentNodeIndex + 1)
   */
  private async advanceLegacy(
    runId: string,
    currentNodeIndex: number,
    turnNo: number,
    seed: string,
    playerHp: number,
    playerStamina: number,
  ): Promise<NodeTransitionResult | null> {
    const nextIndex = currentNodeIndex + 1;

    const nextNode = await this.db.query.nodeInstances.findFirst({
      where: and(
        eq(nodeInstances.runId, runId),
        eq(nodeInstances.nodeIndex, nextIndex),
      ),
    });
    if (!nextNode) return null;

    await this.db
      .update(runSessions)
      .set({ currentNodeIndex: nextIndex, updatedAt: new Date() })
      .where(eq(runSessions.id, runId));

    const nodeType = nextNode.nodeType;

    let battleState: BattleStateV1 | undefined;
    if (nodeType === 'COMBAT') {
      battleState = await this.initBattleState(
        runId,
        nextNode.id,
        nextNode.nodeMeta as Record<string, unknown> | null,
        nextNode.environmentTags ?? [],
        seed,
        turnNo,
        playerHp,
        playerStamina,
      );
    }

    const enterResult = this.buildEnterResult(
      turnNo,
      nextNode.id,
      nextIndex,
      nodeType,
      nextNode.nodeMeta as Record<string, unknown> | null,
      nextNode.environmentTags ?? [],
      battleState,
      nextNode.nodeState,
    );

    return {
      nextNodeIndex: nextIndex,
      nextNodeType: nodeType,
      enterResult,
      battleState,
    };
  }

  private async initBattleState(
    runId: string,
    nodeInstanceId: string,
    nodeMeta: Record<string, unknown> | null,
    envTags: string[],
    seed: string,
    turnNo: number,
    playerHp: number,
    playerStamina: number,
  ): Promise<BattleStateV1> {
    const encounterId = (nodeMeta?.eventId as string) ?? '';
    const encounter = this.content.getEncounter(encounterId);

    if (!encounter) {
      throw new InternalError(`Encounter not found: ${encounterId}`);
    }

    // 적 인스턴스 생성 (overrides 지원)
    const enemies: BattleStateV1['enemies'] = [];
    for (const enemyEntry of encounter.enemies) {
      const enemyDef = this.content.getEnemy(enemyEntry.ref);
      if (!enemyDef)
        throw new InternalError(`Enemy not found: ${enemyEntry.ref}`);

      for (let i = 0; i < enemyEntry.count; i++) {
        // 해당 인스턴스의 포지셔닝 찾기
        const pos = encounter.initialPositioning.find(
          (p) => p.enemyRef === enemyEntry.ref && p.instance === i,
        );

        // overrides 적용 (첫 번째 인스턴스에만 적용, count가 1일 때)
        const overrides = enemyEntry.overrides;
        const hp = i === 0 && overrides?.hp ? overrides.hp : enemyDef.hp;
        const personality =
          i === 0 && overrides?.personality
            ? overrides.personality
            : enemyDef.personality;

        const suffix = enemyEntry.count > 1 ? ` ${String.fromCharCode(65 + i)}` : '';
        enemies.push({
          id: `${enemyEntry.ref}_${i}`,
          name: `${enemyDef.name}${suffix}`,
          hp,
          maxHp: hp,
          status: [],
          personality,
          distance: pos?.distance ?? enemyDef.defaultDistance,
          angle: pos?.angle ?? enemyDef.defaultAngle,
        });
      }
    }

    const battleState: BattleStateV1 = {
      version: 'battle_state_v1',
      phase: 'START',
      lastResolvedTurnNo: turnNo,
      rng: { seed, cursor: 0 },
      env: envTags,
      player: {
        hp: playerHp,
        stamina: playerStamina,
        status: [],
      },
      enemies,
    };

    await this.db.insert(battleStates).values({
      runId,
      nodeInstanceId,
      state: battleState,
    });

    return battleState;
  }

  private buildEnterResult(
    turnNo: number,
    nodeId: string,
    nodeIndex: number,
    nodeType: NodeType,
    nodeMeta: Record<string, unknown> | null,
    envTags: string[],
    battleState?: BattleStateV1,
    nodeState?: Record<string, unknown> | null,
  ): ServerResultV1 {
    const summaryMap: Record<string, string> = {
      COMBAT: '[상황] 전투 노드 진입. 적과 조우.',
      EVENT: '[상황] 이벤트 노드 진입. 새로운 상황 발생.',
      REST: '[상황] 휴식 노드 진입. 체력 회복 가능.',
      SHOP: '[상황] 상점 노드 진입. 물품 거래 가능.',
      EXIT: '[상황] 출구 노드 진입. 여정 종료 선택 가능.',
    };

    // EVENT 노드 — EventContentProvider에서 초기 내러티브/선택지 가져오기
    let eventNarrative: string | undefined;
    let eventChoices: ServerResultV1['choices'] | undefined;
    let eventTone: ToneHint | undefined;
    if (nodeType === 'EVENT' && nodeMeta?.eventId) {
      const ec = this.eventContent.getContent(nodeMeta.eventId as string, 0);
      if (ec) {
        eventNarrative = ec.narrative;
        eventChoices = ec.choices;
        eventTone = ec.toneHint as ToneHint;
      }
    }

    // SHOP 노드 — nodeState의 catalog에서 선택지 생성
    let shopChoices: ServerResultV1['choices'] | undefined;
    if (nodeType === 'SHOP' && nodeState) {
      const catalog = (
        nodeState as {
          catalog?: Array<{
            itemId: string;
            name: string;
            price: number;
            stock: number;
            description?: string;
          }>;
        }
      ).catalog;
      if (catalog) {
        shopChoices = [
          ...catalog
            .filter((c) => c.stock > 0)
            .map((c) => ({
              id: `buy_${c.itemId}`,
              label: `${c.name} (${c.price} 골드)`,
              hint: c.description,
              action: {
                type: 'CHOICE' as const,
                payload: { choiceId: `buy_${c.itemId}` },
              },
            })),
          {
            id: 'leave',
            label: '상점을 떠난다',
            action: { type: 'CHOICE' as const, payload: { choiceId: 'leave' } },
          },
        ];
      }
    }

    let choices: ServerResultV1['choices'] =
      eventChoices && eventChoices.length > 0
        ? eventChoices
        : shopChoices && shopChoices.length > 0
          ? shopChoices
          : nodeType === 'EXIT'
            ? [
                {
                  id: 'return',
                  label: '허브로 귀환한다 (런 종료)',
                  action: {
                    type: 'CHOICE' as const,
                    payload: { choiceId: 'return' },
                  },
                },
              ]
            : nodeType === 'REST'
              ? [
                  {
                    id: 'long_rest',
                    label: '충분히 쉰다 (HP +25%, 스태미나 +2)',
                    action: {
                      type: 'CHOICE' as const,
                      payload: { choiceId: 'long_rest' },
                    },
                  },
                  {
                    id: 'short_rest',
                    label: '간단히 쉰다 (HP +10%, 스태미나 +1)',
                    action: {
                      type: 'CHOICE' as const,
                      payload: { choiceId: 'short_rest' },
                    },
                  },
                ]
              : [];

    // COMBAT 노드 초기 선택지 생성
    if (nodeType === 'COMBAT' && battleState) {
      const aliveEnemies = battleState.enemies.filter((e) => e.hp > 0);
      const combatChoices: ServerResultV1['choices'] = [];

      for (const e of aliveEnemies) {
        if (e.distance === 'ENGAGED' || e.distance === 'CLOSE') {
          const name = e.name ?? e.id;
          combatChoices.push({
            id: `attack_melee_${e.id}`,
            label: `${name}에게 근접 공격`,
            action: {
              type: 'CHOICE',
              payload: { choiceId: `attack_melee_${e.id}` },
            },
          });
        }
      }
      combatChoices.push(
        {
          id: 'defend',
          label: '방어 태세',
          action: { type: 'CHOICE', payload: { choiceId: 'defend' } },
        },
        {
          id: 'evade',
          label: '회피',
          action: { type: 'CHOICE', payload: { choiceId: 'evade' } },
        },
      );

      // 콤보 선택지 (스태미나 >= 2)
      if (battleState.player.stamina >= 2) {
        for (const e of aliveEnemies) {
          if (e.distance === 'ENGAGED' || e.distance === 'CLOSE') {
            const name = e.name ?? e.id;
            combatChoices.push({
              id: `combo_double_attack_${e.id}`,
              label: `${name}에게 연속 공격`,
              hint: '2회 연속 공격 (기력 2)',
              action: { type: 'CHOICE', payload: { choiceId: `combo_double_attack_${e.id}` } },
            });
            combatChoices.push({
              id: `combo_attack_defend_${e.id}`,
              label: `${name} 공격 후 방어`,
              hint: '공격 + 방어 태세 (기력 2)',
              action: { type: 'CHOICE', payload: { choiceId: `combo_attack_defend_${e.id}` } },
            });
          }
        }
      }

      // 환경 활용
      const envLabel = envTags.includes('COVER_CRATE') ? '화물 상자를 적에게 던진다'
        : envTags.includes('COVER_WALL') ? '벽의 잔해를 무너뜨린다'
        : envTags.includes('NARROW') ? '좁은 통로를 이용해 가둔다'
        : envTags.includes('INDOOR') ? '실내 구조물을 활용한다'
        : '주변 환경을 활용한다';
      combatChoices.push({
        id: 'env_action',
        label: envLabel,
        hint: '확률 기반 광역 공격',
        action: { type: 'CHOICE', payload: { choiceId: 'env_action' } },
      });

      // 전투 회피
      combatChoices.push({
        id: 'combat_avoid',
        label: '전투 회피 시도',
        hint: '기민함으로 전투를 피한다',
        action: { type: 'CHOICE', payload: { choiceId: 'combat_avoid' } },
      });

      // 도주
      combatChoices.push({
        id: 'flee',
        label: '도주 시도',
        action: { type: 'CHOICE', payload: { choiceId: 'flee' } },
      });

      choices = combatChoices;
    }

    // COMBAT 노드일 경우 적 정보 요약
    let combatSummary = '';
    if (battleState && nodeType === 'COMBAT') {
      const enemyDescs = battleState.enemies.map((e) => {
        const def = this.content.getEnemy(e.id.replace(/_\d+$/, ''));
        const name = def?.name ?? e.id;
        return `${name}(거리:${e.distance}, 각도:${e.angle})`;
      });
      combatSummary = ` [적] ${enemyDescs.join(', ')}.`;
    }

    return {
      version: 'server_result_v1',
      turnNo,
      node: {
        id: nodeId,
        type: nodeType,
        index: nodeIndex,
        state: 'NODE_ACTIVE',
      },
      summary: {
        short:
          eventNarrative ??
          (summaryMap[nodeType] ?? '[상황] 다음 구간으로 이동.') +
            combatSummary,
        display: toDisplayText(
          eventNarrative ??
            (summaryMap[nodeType] ?? '[상황] 다음 구간으로 이동.') +
              combatSummary,
        ),
      },
      events: [],
      diff: {
        player: {
          hp: { from: 0, to: 0, delta: 0 },
          stamina: { from: 0, to: 0, delta: 0 },
          status: [],
        },
        enemies: [],
        inventory: { itemsAdded: [], itemsRemoved: [], goldDelta: 0 },
        meta: {
          battle: { phase: nodeType === 'COMBAT' ? 'START' : 'NONE' },
          position: { env: envTags },
        },
      },
      ui: {
        availableActions:
          nodeType === 'COMBAT'
            ? ['ATTACK_MELEE', 'DEFEND', 'EVADE', 'FLEE']
            : ['CHOICE'],
        targetLabels: battleState
          ? battleState.enemies.map((e) => {
              const def = this.content.getEnemy(e.id.replace(/_\d+$/, ''));
              return {
                id: e.id,
                name: def?.name ?? e.id,
                hint: `HP:${e.hp} ${e.distance}/${e.angle}`,
              };
            })
          : [],
        actionSlots: { base: 2, bonusAvailable: false, max: 3 },
        toneHint: eventTone ?? (nodeType === 'COMBAT' ? 'tense' : 'neutral'),
      },
      choices,
      flags: { bonusSlot: false, downed: false, battleEnded: false },
    };
  }
}
