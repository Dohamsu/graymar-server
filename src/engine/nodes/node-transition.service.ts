// HUB/LOCATION 노드 전환 서비스 (DAG 대체)

import { Inject, Injectable } from '@nestjs/common';
import { and, eq, max } from 'drizzle-orm';
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
  WorldState,
  ArcState,
} from '../../db/types/index.js';
import type {
  NodeType,
  ToneHint,
  RouteContext,
  RouteTag,
} from '../../db/types/index.js';
import { ContentLoaderService } from '../../content/content-loader.service.js';
import { SceneShellService } from '../hub/scene-shell.service.js';
import { RunPlannerService } from '../planner/run-planner.service.js';
import { InternalError } from '../../common/errors/game-errors.js';

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
    private readonly sceneShell: SceneShellService,
    private readonly planner: RunPlannerService,
  ) {}

  /**
   * run 내 최대 nodeIndex 조회 → +1 반환
   */
  private async getNextNodeIndex(runId: string): Promise<number> {
    const result = await this.db
      .select({ maxIndex: max(nodeInstances.nodeIndex) })
      .from(nodeInstances)
      .where(eq(nodeInstances.runId, runId));
    return (result[0]?.maxIndex ?? -1) + 1;
  }

  /**
   * LOCATION 노드로 전환
   */
  async transitionToLocation(
    runId: string,
    currentNodeIndex: number,
    turnNo: number,
    locationId: string,
    ws: WorldState,
    runState?: RunState,
  ): Promise<NodeTransitionResult> {
    const nextIndex = await this.getNextNodeIndex(runId);
    const location = this.content.getLocation(locationId);
    const locationName = location?.name ?? locationId;
    const envTags = location?.tags ?? [];

    // Scene Shell 생성
    const sceneText = this.sceneShell.generateSceneShell(
      locationId,
      ws.timePhase,
      ws.hubSafety,
    );

    // LOCATION 노드 생성
    await this.db.insert(nodeInstances).values({
      runId,
      nodeIndex: nextIndex,
      graphNodeId: null,
      nodeType: 'LOCATION',
      nodeMeta: { locationId, locationName },
      environmentTags: envTags,
      edges: null,
      status: 'NODE_ACTIVE',
      nodeState: { locationId, sceneText },
    });

    // run_sessions UPDATE
    await this.db
      .update(runSessions)
      .set({
        currentNodeIndex: nextIndex,
        currentLocationId: locationId,
        updatedAt: new Date(),
      })
      .where(eq(runSessions.id, runId));

    const newNode = await this.db.query.nodeInstances.findFirst({
      where: and(
        eq(nodeInstances.runId, runId),
        eq(nodeInstances.nodeIndex, nextIndex),
      ),
    });
    if (!newNode) throw new InternalError('Failed to create LOCATION node');

    // 선택지 생성
    const choices = this.sceneShell.buildLocationChoices(locationId);

    const enterResult: ServerResultV1 = {
      version: 'server_result_v1',
      turnNo,
      node: {
        id: newNode.id,
        type: 'LOCATION',
        index: nextIndex,
        state: 'NODE_ACTIVE',
      },
      summary: {
        short: `[장소] ${locationName} — ${sceneText}`,
        display: `${locationName}에 도착했다.`,
      },
      events: [
        {
          id: `enter_loc_${nextIndex}`,
          kind: 'MOVE',
          text: `${locationName}(으)로 이동했다.`,
          tags: ['LOCATION_ENTER', locationId],
        },
      ],
      diff: {
        player: {
          hp: { from: 0, to: 0, delta: 0 },
          stamina: { from: 0, to: 0, delta: 0 },
          status: [],
        },
        enemies: [],
        inventory: { itemsAdded: [], itemsRemoved: [], goldDelta: 0 },
        meta: {
          battle: { phase: 'NONE' },
          position: { env: envTags },
        },
      },
      ui: {
        availableActions: ['ACTION', 'CHOICE'],
        targetLabels: [],
        actionSlots: { base: 2, bonusAvailable: false, max: 3 },
        toneHint: ws.hubSafety === 'DANGER' ? 'danger' : 'neutral',
        worldState: {
          hubHeat: ws.hubHeat,
          hubSafety: ws.hubSafety,
          timePhase: ws.timePhase,
          currentLocationId: locationId,
          reputation: ws.reputation ?? {},
        },
      },
      choices,
      flags: { bonusSlot: false, downed: false, battleEnded: false },
    };

    return {
      nextNodeIndex: nextIndex,
      nextNodeType: 'LOCATION',
      enterResult,
    };
  }

  /**
   * HUB 노드로 복귀
   */
  async transitionToHub(
    runId: string,
    currentNodeIndex: number,
    turnNo: number,
    ws: WorldState,
    arcState: ArcState,
  ): Promise<NodeTransitionResult> {
    const nextIndex = await this.getNextNodeIndex(runId);

    // HUB 노드 생성
    await this.db.insert(nodeInstances).values({
      runId,
      nodeIndex: nextIndex,
      graphNodeId: null,
      nodeType: 'HUB',
      nodeMeta: { hubReturn: true },
      environmentTags: ['HUB', 'GRAYMAR'],
      edges: null,
      status: 'NODE_ACTIVE',
      nodeState: { phase: 'HUB' },
    });

    // run_sessions UPDATE
    await this.db
      .update(runSessions)
      .set({
        currentNodeIndex: nextIndex,
        currentLocationId: null,
        updatedAt: new Date(),
      })
      .where(eq(runSessions.id, runId));

    const newNode = await this.db.query.nodeInstances.findFirst({
      where: and(
        eq(nodeInstances.runId, runId),
        eq(nodeInstances.nodeIndex, nextIndex),
      ),
    });
    if (!newNode) throw new InternalError('Failed to create HUB node');

    const hubChoices = this.sceneShell.buildHubChoices(ws, arcState);

    const enterResult: ServerResultV1 = {
      version: 'server_result_v1',
      turnNo,
      node: {
        id: newNode.id,
        type: 'HUB',
        index: nextIndex,
        state: 'NODE_ACTIVE',
      },
      summary: {
        short: '[장소] 거점으로 돌아왔다. 도시의 소식을 정리한다.',
        display: '거점으로 돌아왔다.',
      },
      events: [
        {
          id: `hub_return_${nextIndex}`,
          kind: 'MOVE',
          text: '거점으로 돌아왔다.',
          tags: ['HUB_RETURN'],
        },
      ],
      diff: {
        player: {
          hp: { from: 0, to: 0, delta: 0 },
          stamina: { from: 0, to: 0, delta: 0 },
          status: [],
        },
        enemies: [],
        inventory: { itemsAdded: [], itemsRemoved: [], goldDelta: 0 },
        meta: {
          battle: { phase: 'NONE' },
          position: { env: ['HUB', 'GRAYMAR'] },
        },
      },
      ui: {
        availableActions: ['CHOICE'],
        targetLabels: [],
        actionSlots: { base: 2, bonusAvailable: false, max: 3 },
        toneHint: 'calm',
        worldState: {
          hubHeat: ws.hubHeat,
          hubSafety: ws.hubSafety,
          timePhase: ws.timePhase,
          currentLocationId: null,
          reputation: ws.reputation ?? {},
        },
      },
      choices: hubChoices,
      flags: { bonusSlot: false, downed: false, battleEnded: false },
    };

    return {
      nextNodeIndex: nextIndex,
      nextNodeType: 'HUB',
      enterResult,
    };
  }

  /**
   * COMBAT 서브노드 삽입 (LOCATION 내 전투)
   */
  async insertCombatSubNode(
    runId: string,
    parentNodeId: string,
    parentNodeIndex: number,
    turnNo: number,
    encounterId: string,
    envTags: string[],
    seed: string,
    playerHp: number,
    playerStamina: number,
  ): Promise<NodeTransitionResult> {
    const nextIndex = await this.getNextNodeIndex(runId);

    const encounter = this.content.getEncounter(encounterId);
    if (!encounter) {
      throw new InternalError(`Encounter not found: ${encounterId}`);
    }

    // COMBAT 서브노드 생성
    await this.db.insert(nodeInstances).values({
      runId,
      nodeIndex: nextIndex,
      graphNodeId: null,
      nodeType: 'COMBAT',
      nodeMeta: {
        eventId: encounterId,
        isBoss: encounter.nodeMeta?.isBoss ?? false,
      },
      environmentTags: encounter.envTags ?? envTags,
      edges: null,
      status: 'NODE_ACTIVE',
      parentNodeInstanceId: parentNodeId,
      nodeState: { parentNodeId },
    });

    // run_sessions UPDATE
    await this.db
      .update(runSessions)
      .set({
        currentNodeIndex: nextIndex,
        updatedAt: new Date(),
      })
      .where(eq(runSessions.id, runId));

    const newNode = await this.db.query.nodeInstances.findFirst({
      where: and(
        eq(nodeInstances.runId, runId),
        eq(nodeInstances.nodeIndex, nextIndex),
      ),
    });
    if (!newNode) throw new InternalError('Failed to create COMBAT sub-node');

    // BattleState 초기화
    const battleState = await this.initBattleState(
      runId,
      newNode.id,
      { eventId: encounterId },
      encounter.envTags ?? envTags,
      seed,
      turnNo,
      playerHp,
      playerStamina,
    );

    // 전투 진입 결과
    const enemyDescs = battleState.enemies.map((e) => {
      const def = this.content.getEnemy(e.id.replace(/_\d+$/, ''));
      const name = def?.name ?? e.id;
      return `${name}(거리:${e.distance}, 각도:${e.angle})`;
    });

    // 전투 선택지
    const combatChoices = this.buildCombatChoices(
      battleState,
      encounter.envTags ?? envTags,
    );

    const enterResult: ServerResultV1 = {
      version: 'server_result_v1',
      turnNo,
      node: {
        id: newNode.id,
        type: 'COMBAT',
        index: nextIndex,
        state: 'NODE_ACTIVE',
      },
      summary: {
        short: `[전투] 전투 발생! [적] ${enemyDescs.join(', ')}.`,
        display: '전투가 시작되었다!',
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
          battle: { phase: 'START' },
          position: { env: encounter.envTags ?? envTags },
        },
      },
      ui: {
        availableActions: ['ATTACK_MELEE', 'DEFEND', 'EVADE', 'FLEE'],
        targetLabels: battleState.enemies.map((e) => {
          const def = this.content.getEnemy(e.id.replace(/_\d+$/, ''));
          return {
            id: e.id,
            name: def?.name ?? e.id,
            hint: `HP:${e.hp} ${e.distance}/${e.angle}`,
          };
        }),
        actionSlots: { base: 2, bonusAvailable: false, max: 3 },
        toneHint: 'tense',
      },
      choices: combatChoices,
      flags: { bonusSlot: false, downed: false, battleEnded: false },
    };

    return {
      nextNodeIndex: nextIndex,
      nextNodeType: 'COMBAT',
      enterResult,
      battleState,
    };
  }

  /**
   * 전투 종료 후 부모 LOCATION으로 복귀
   */
  async returnFromCombat(
    runId: string,
    parentNodeIndex: number,
    turnNo: number,
    locationId: string,
    ws: WorldState,
  ): Promise<NodeTransitionResult> {
    // 부모 LOCATION 노드를 다시 활성화
    const parentNode = await this.db.query.nodeInstances.findFirst({
      where: and(
        eq(nodeInstances.runId, runId),
        eq(nodeInstances.nodeIndex, parentNodeIndex),
      ),
    });
    if (!parentNode) throw new InternalError('Parent LOCATION node not found');

    await this.db
      .update(nodeInstances)
      .set({ status: 'NODE_ACTIVE', updatedAt: new Date() })
      .where(eq(nodeInstances.id, parentNode.id));

    await this.db
      .update(runSessions)
      .set({ currentNodeIndex: parentNodeIndex, updatedAt: new Date() })
      .where(eq(runSessions.id, runId));

    const location = this.content.getLocation(locationId);
    const sceneText = this.sceneShell.generateSceneShell(
      locationId,
      ws.timePhase,
      ws.hubSafety,
    );

    const choices = this.sceneShell.buildLocationChoices(locationId);

    const enterResult: ServerResultV1 = {
      version: 'server_result_v1',
      turnNo,
      node: {
        id: parentNode.id,
        type: 'LOCATION',
        index: parentNodeIndex,
        state: 'NODE_ACTIVE',
      },
      summary: {
        short: `[장소] ${location?.name ?? locationId} — 전투가 끝나고 다시 주변을 살핀다. ${sceneText}`,
        display: '전투가 끝났다. 주변을 둘러본다.',
      },
      events: [
        {
          id: `combat_return_${turnNo}`,
          kind: 'MOVE',
          text: '전투가 종료되었다.',
          tags: ['COMBAT_END', 'LOCATION_RETURN'],
        },
      ],
      diff: {
        player: {
          hp: { from: 0, to: 0, delta: 0 },
          stamina: { from: 0, to: 0, delta: 0 },
          status: [],
        },
        enemies: [],
        inventory: { itemsAdded: [], itemsRemoved: [], goldDelta: 0 },
        meta: {
          battle: { phase: 'NONE' },
          position: { env: location?.tags ?? [] },
        },
      },
      ui: {
        availableActions: ['ACTION', 'CHOICE'],
        targetLabels: [],
        actionSlots: { base: 2, bonusAvailable: false, max: 3 },
        toneHint: 'neutral',
        worldState: {
          hubHeat: ws.hubHeat,
          hubSafety: ws.hubSafety,
          timePhase: ws.timePhase,
          currentLocationId: locationId,
          reputation: ws.reputation ?? {},
        },
      },
      choices,
      flags: { bonusSlot: false, downed: false, battleEnded: false },
    };

    return {
      nextNodeIndex: parentNodeIndex,
      nextNodeType: 'LOCATION',
      enterResult,
    };
  }

  /**
   * DAG 그래프 기반 노드 전환.
   * RunPlannerService.resolveNextNodeId()로 다음 그래프 노드를 결정하고,
   * node_instances에 INSERT + run_sessions 업데이트.
   *
   * @returns null if no next node (graph end → RUN_ENDED 처리 필요)
   */
  async transitionByGraphNode(
    runId: string,
    currentGraphNodeId: string,
    routeContext: RouteContext,
    turnNo: number,
    ws: WorldState,
    playerHp: number,
    playerStamina: number,
    seed: string,
  ): Promise<NodeTransitionResult | null> {
    // 1. 다음 그래프 노드 결정
    const nextGraphNodeId = this.planner.resolveNextNodeId(
      currentGraphNodeId,
      routeContext,
    );
    if (!nextGraphNodeId) return null; // 그래프 종료

    const plannedNode = this.planner.findNode(nextGraphNodeId);
    if (!plannedNode) {
      throw new InternalError(`Graph node not found: ${nextGraphNodeId}`);
    }

    // 2. routeTag 결정 (S2 분기점에서 결정됨)
    const newRouteTag = this.planner.resolveRouteTag(routeContext.lastChoiceId);
    const effectiveRouteTag =
      newRouteTag ??
      (routeContext.routeTag as RouteTag | undefined) ??
      undefined;

    // 3. nodeIndex 할당
    const nextIndex = await this.getNextNodeIndex(runId);

    // 4. node_instances INSERT
    await this.db.insert(nodeInstances).values({
      runId,
      nodeIndex: nextIndex,
      graphNodeId: nextGraphNodeId,
      nodeType: plannedNode.nodeType,
      nodeMeta: plannedNode.nodeMeta,
      environmentTags: plannedNode.environmentTags,
      edges: plannedNode.edges,
      status: 'NODE_ACTIVE',
      nodeState: {},
    });

    // 5. run_sessions UPDATE
    await this.db
      .update(runSessions)
      .set({
        currentNodeIndex: nextIndex,
        currentGraphNodeId: nextGraphNodeId,
        ...(effectiveRouteTag ? { routeTag: effectiveRouteTag } : {}),
        updatedAt: new Date(),
      })
      .where(eq(runSessions.id, runId));

    // 6. 생성된 노드 조회
    const newNode = await this.db.query.nodeInstances.findFirst({
      where: and(
        eq(nodeInstances.runId, runId),
        eq(nodeInstances.nodeIndex, nextIndex),
      ),
    });
    if (!newNode) {
      throw new InternalError('Failed to create DAG node');
    }

    // 7. 노드 타입별 enterResult + 부속 리소스 생성
    const nodeType = plannedNode.nodeType;

    if (nodeType === 'COMBAT') {
      // 전투 노드: BattleState 초기화 필요
      const encounterId = (plannedNode.nodeMeta?.eventId as string) ?? '';
      const battleState = await this.initBattleState(
        runId,
        newNode.id,
        plannedNode.nodeMeta,
        plannedNode.environmentTags,
        seed,
        turnNo,
        playerHp,
        playerStamina,
      );

      const enemyDescs = battleState.enemies.map((e) => {
        const def = this.content.getEnemy(e.id.replace(/_\d+$/, ''));
        return `${def?.name ?? e.id}(거리:${e.distance}, 각도:${e.angle})`;
      });
      const combatChoices = this.buildCombatChoices(
        battleState,
        plannedNode.environmentTags,
      );

      const enterResult: ServerResultV1 = {
        version: 'server_result_v1',
        turnNo,
        node: {
          id: newNode.id,
          type: 'COMBAT',
          index: nextIndex,
          state: 'NODE_ACTIVE',
        },
        summary: {
          short: `[전투] 전투 발생! [적] ${enemyDescs.join(', ')}.`,
          display: '전투가 시작되었다!',
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
            battle: { phase: 'START' },
            position: { env: plannedNode.environmentTags },
          },
        },
        ui: {
          availableActions: ['ATTACK_MELEE', 'DEFEND', 'EVADE', 'FLEE'],
          targetLabels: battleState.enemies.map((e) => {
            const def = this.content.getEnemy(e.id.replace(/_\d+$/, ''));
            return {
              id: e.id,
              name: def?.name ?? e.id,
              hint: `HP:${e.hp} ${e.distance}/${e.angle}`,
            };
          }),
          actionSlots: { base: 2, bonusAvailable: false, max: 3 },
          toneHint: 'tense',
        },
        choices: combatChoices,
        flags: { bonusSlot: false, downed: false, battleEnded: false },
      };

      return {
        nextNodeIndex: nextIndex,
        nextNodeType: 'COMBAT',
        enterResult,
        battleState,
        routeTag: effectiveRouteTag,
      };
    }

    if (nodeType === 'EXIT') {
      // EXIT 노드 → RUN 종료 시그널
      const enterResult: ServerResultV1 = {
        version: 'server_result_v1',
        turnNo,
        node: {
          id: newNode.id,
          type: 'EXIT',
          index: nextIndex,
          state: 'NODE_ACTIVE',
        },
        summary: {
          short: '[종료] 이야기가 막을 내린다.',
          display: '이야기가 막을 내린다.',
        },
        events: [
          {
            id: `exit_${nextIndex}`,
            kind: 'SYSTEM',
            text: '런이 종료되었다.',
            tags: ['RUN_ENDED', 'EXIT'],
          },
        ],
        diff: {
          player: {
            hp: { from: 0, to: 0, delta: 0 },
            stamina: { from: 0, to: 0, delta: 0 },
            status: [],
          },
          enemies: [],
          inventory: { itemsAdded: [], itemsRemoved: [], goldDelta: 0 },
          meta: {
            battle: { phase: 'NONE' },
            position: { env: plannedNode.environmentTags },
          },
        },
        ui: {
          availableActions: [],
          targetLabels: [],
          actionSlots: { base: 2, bonusAvailable: false, max: 3 },
          toneHint: 'calm',
        },
        choices: [],
        flags: { bonusSlot: false, downed: false, battleEnded: false },
      };

      return {
        nextNodeIndex: nextIndex,
        nextNodeType: 'EXIT',
        enterResult,
        routeTag: effectiveRouteTag,
      };
    }

    // EVENT / REST / SHOP — 일반 노드 진입
    const eventId = (plannedNode.nodeMeta?.eventId as string) ?? '';
    const toneHint: ToneHint = nodeType === 'REST' ? 'calm' : 'neutral';
    const displayMap: Record<string, string> = {
      EVENT: `이벤트 노드에 진입했다.`,
      REST: '쉬어갈 수 있는 장소에 도착했다.',
      SHOP: '상점에 도착했다.',
    };

    const enterResult: ServerResultV1 = {
      version: 'server_result_v1',
      turnNo,
      node: {
        id: newNode.id,
        type: nodeType,
        index: nextIndex,
        state: 'NODE_ACTIVE',
      },
      summary: {
        short: `[${nodeType}] ${eventId || nodeType} 노드 진입.`,
        display: displayMap[nodeType] ?? '다음 장소에 도착했다.',
      },
      events: [
        {
          id: `enter_${nextGraphNodeId}`,
          kind: 'SYSTEM',
          text: displayMap[nodeType] ?? '다음 장소에 도착했다.',
          tags: [nodeType, nextGraphNodeId],
        },
      ],
      diff: {
        player: {
          hp: { from: 0, to: 0, delta: 0 },
          stamina: { from: 0, to: 0, delta: 0 },
          status: [],
        },
        enemies: [],
        inventory: { itemsAdded: [], itemsRemoved: [], goldDelta: 0 },
        meta: {
          battle: { phase: 'NONE' },
          position: { env: plannedNode.environmentTags },
        },
      },
      ui: {
        availableActions: ['ACTION', 'CHOICE'],
        targetLabels: [],
        actionSlots: { base: 2, bonusAvailable: false, max: 3 },
        toneHint,
      },
      choices: [],
      flags: { bonusSlot: false, downed: false, battleEnded: false },
    };

    return {
      nextNodeIndex: nextIndex,
      nextNodeType: nodeType,
      enterResult,
      routeTag: effectiveRouteTag,
    };
  }

  // --- Private helpers ---

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

    const enemies: BattleStateV1['enemies'] = [];
    for (const enemyEntry of encounter.enemies) {
      const enemyDef = this.content.getEnemy(enemyEntry.ref);
      if (!enemyDef)
        throw new InternalError(`Enemy not found: ${enemyEntry.ref}`);

      for (let i = 0; i < enemyEntry.count; i++) {
        const pos = encounter.initialPositioning.find(
          (p) => p.enemyRef === enemyEntry.ref && p.instance === i,
        );

        const overrides = enemyEntry.overrides;
        const hp = i === 0 && overrides?.hp ? overrides.hp : enemyDef.hp;
        const personality =
          i === 0 && overrides?.personality
            ? overrides.personality
            : enemyDef.personality;

        const suffix =
          enemyEntry.count > 1 ? ` ${String.fromCharCode(65 + i)}` : '';
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

  private buildCombatChoices(
    battleState: BattleStateV1,
    envTags: string[],
  ): ServerResultV1['choices'] {
    const aliveEnemies = battleState.enemies.filter((e) => e.hp > 0);
    const choices: ServerResultV1['choices'] = [];

    for (const e of aliveEnemies) {
      if (e.distance === 'ENGAGED' || e.distance === 'CLOSE') {
        choices.push({
          id: `attack_melee_${e.id}`,
          label: `${e.name}에게 근접 공격`,
          action: {
            type: 'CHOICE',
            payload: { choiceId: `attack_melee_${e.id}` },
          },
        });
      }
    }

    choices.push(
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

    if (battleState.player.stamina >= 2) {
      for (const e of aliveEnemies) {
        if (e.distance === 'ENGAGED' || e.distance === 'CLOSE') {
          choices.push({
            id: `combo_double_attack_${e.id}`,
            label: `${e.name}에게 연속 공격`,
            hint: '2회 연속 공격 (기력 2)',
            action: {
              type: 'CHOICE',
              payload: { choiceId: `combo_double_attack_${e.id}` },
            },
          });
        }
      }
    }

    choices.push({
      id: 'flee',
      label: '도주 시도',
      action: { type: 'CHOICE', payload: { choiceId: 'flee' } },
    });

    return choices;
  }
}
