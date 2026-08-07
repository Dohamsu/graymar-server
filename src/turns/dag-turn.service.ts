/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return */
// [arch/77 §5 후속 — turns.service 파일 분할 3단계, 2026-08-07]
//   DAG 노드 턴(node_routing_v2 24노드 라우팅). 내부 메서드 호출이 없고 진입점이
//   submitTurn 하나뿐이라 독립 조각이다.
import { mergeInventoryItem } from './run-state-apply.core.js';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { DB, type DrizzleDB } from '../db/drizzle.module.js';
import { runSessions, nodeInstances, turns } from '../db/schema/index.js';
import type { PermanentStats, RunState } from '../db/types/index.js';
import type { NodeType, LlmStatus } from '../db/types/index.js';
import { NodeResolverService } from '../engine/nodes/node-resolver.service.js';
import { NodeTransitionService } from '../engine/nodes/node-transition.service.js';
import { RngService } from '../engine/rng/rng.service.js';
import { WorldStateService } from '../engine/hub/world-state.service.js';
import type { SubmitTurnBody } from './dto/submit-turn.dto.js';
import { TurnSharedService } from './turn-shared.service.js';

@Injectable()
export class DagTurnService {
  private readonly logger = new Logger(DagTurnService.name);

  constructor(
    @Inject(DB) private readonly db: DrizzleDB,
    private readonly nodeResolver: NodeResolverService,
    private readonly nodeTransition: NodeTransitionService,
    private readonly rngService: RngService,
    private readonly worldStateService: WorldStateService,
    private readonly turnShared: TurnSharedService,
  ) {}

  // --- DAG 노드 턴 (EVENT/REST/SHOP/EXIT in DAG mode) ---
  async handleDagNodeTurn(
    run: any,
    currentNode: any,
    turnNo: number,
    body: SubmitTurnBody,
    runState: RunState,
    playerStats: PermanentStats,
  ) {
    const nodeType = currentNode.nodeType as NodeType;
    const rawInput = body.input.text ?? body.input.choiceId ?? '';
    const updatedRunState: RunState = { ...runState };

    // NodeResolver로 노드 처리
    // ⚠️ [DAG 노드 경로] — 아래 COMBAT 경로(handleCombatTurn)에 유사 블록이
    // 하나 더 있다. 편집 전 어느 경로인지 확인할 것 (arch/77 P3.X 오배치 방지).
    const resolveResult = this.nodeResolver.resolve({
      turnNo,
      nodeId: currentNode.id,
      nodeIndex: currentNode.nodeIndex,
      nodeType,
      nodeMeta: currentNode.nodeMeta as import('../db/types/index.js').NodeMeta,
      envTags: currentNode.environmentTags ?? [],
      inputType: body.input.type,
      rawInput,
      choiceId: body.input.choiceId,
      playerStats,
      playerHp: runState.hp,
      playerMaxHp: runState.maxHp,
      playerStamina: runState.stamina,
      playerMaxStamina: runState.maxStamina,
      playerGold: runState.gold,
      inventoryCount: runState.inventory.length,
      inventoryMax: 20,
      nodeState: (currentNode.nodeState ?? {}) as Record<string, unknown>,
      traitEffects: runState.traitEffects,
    });

    // RunState 반영 (gold, hp, stamina 변동)
    // [arch/77 P3.X 기록 결함 수정] 골드 0-바닥 — LOCATION/COMBAT 경로는 모두
    // Math.max(0,…)인데 DAG만 무바닥 += 라 이론상 음수 골드 가능했다 (SHOP
    // 리졸버의 잔액 검증은 있으나 타 노드 goldDelta 방어선 부재). 경로 통일.
    if (resolveResult.goldDelta)
      updatedRunState.gold = Math.max(
        0,
        updatedRunState.gold + resolveResult.goldDelta,
      );
    if (resolveResult.hpDelta) {
      updatedRunState.hp = Math.max(
        0,
        Math.min(
          updatedRunState.maxHp,
          updatedRunState.hp + resolveResult.hpDelta,
        ),
      );
    }
    if (resolveResult.staminaDelta) {
      updatedRunState.stamina = Math.max(
        0,
        Math.min(
          updatedRunState.maxStamina,
          updatedRunState.stamina + resolveResult.staminaDelta,
        ),
      );
    }
    if (resolveResult.itemsBought) {
      for (const item of resolveResult.itemsBought) {
        mergeInventoryItem(updatedRunState.inventory, item.itemId, item.qty);
      }
    }

    // 턴 커밋
    const llmStatus: LlmStatus = body.options?.skipLlm ? 'SKIPPED' : 'PENDING';
    await this.db.insert(turns).values({
      runId: run.id,
      turnNo,
      nodeInstanceId: currentNode.id,
      nodeType,
      inputType: body.input.type,
      rawInput,
      idempotencyKey: body.idempotencyKey,
      parsedBy: null,
      confidence: null,
      parsedIntent: null,
      policyResult: 'ALLOW',
      transformedIntent: null,
      actionPlan: null,
      serverResult: resolveResult.serverResult,
      llmStatus,
    });

    // NODE_ENDED → DAG 다음 노드 전환
    if (
      resolveResult.nodeOutcome === 'NODE_ENDED' ||
      resolveResult.nodeOutcome === 'RUN_ENDED'
    ) {
      // 현재 노드 종료
      await this.db
        .update(nodeInstances)
        .set({
          status: 'NODE_ENDED',
          nodeState: resolveResult.nextNodeState ?? null,
          updatedAt: new Date(),
        })
        .where(eq(nodeInstances.id, currentNode.id));

      if (resolveResult.nodeOutcome === 'RUN_ENDED' || nodeType === 'EXIT') {
        await this.db
          .update(runSessions)
          .set({
            status: 'RUN_ENDED',
            currentTurnNo: turnNo,
            runState: updatedRunState,
            updatedAt: new Date(),
          })
          .where(eq(runSessions.id, run.id));
        await this.turnShared.saveCampaignResultIfNeeded(run.id);
        return {
          accepted: true,
          turnNo,
          serverResult: resolveResult.serverResult,
          llm: { status: llmStatus, narrative: null },
          meta: { nodeOutcome: 'RUN_ENDED', policyResult: 'ALLOW' },
        };
      }

      // RouteContext 구성
      const dagRouteContext: import('../db/types/index.js').RouteContext = {
        lastChoiceId: resolveResult.selectedChoiceId ?? body.input.choiceId,
        routeTag: run.routeTag ?? undefined,
        randomSeed: this.rngService.create(run.seed, turnNo + 1).next(),
      };

      const ws =
        updatedRunState.worldState ?? this.worldStateService.initWorldState();
      const dagTransition = await this.nodeTransition.transitionByGraphNode(
        run.id,
        run.currentGraphNodeId,
        dagRouteContext,
        turnNo + 1,
        ws,
        updatedRunState.hp,
        updatedRunState.stamina,
        run.seed,
      );

      if (!dagTransition || dagTransition.nextNodeType === 'EXIT') {
        // 그래프 종료 → RUN_ENDED
        await this.db
          .update(runSessions)
          .set({
            status: 'RUN_ENDED',
            currentTurnNo: turnNo,
            runState: updatedRunState,
            updatedAt: new Date(),
          })
          .where(eq(runSessions.id, run.id));
        await this.turnShared.saveCampaignResultIfNeeded(run.id);

        const response: any = {
          accepted: true,
          turnNo,
          serverResult: resolveResult.serverResult,
          llm: { status: llmStatus, narrative: null },
          meta: { nodeOutcome: 'RUN_ENDED', policyResult: 'ALLOW' },
        };
        if (dagTransition) {
          response.transition = {
            nextNodeIndex: dagTransition.nextNodeIndex,
            nextNodeType: dagTransition.nextNodeType,
            enterResult: dagTransition.enterResult,
            battleState: null,
            enterTurnNo: turnNo + 1,
          };
        }
        return response;
      }

      // routeTag가 결정된 경우 runState에도 반영
      if (dagTransition.routeTag) {
        updatedRunState.worldState = {
          ...(updatedRunState.worldState ??
            this.worldStateService.initWorldState()),
        };
      }

      dagTransition.enterResult.turnNo = turnNo + 1;
      await this.db.insert(turns).values({
        runId: run.id,
        turnNo: turnNo + 1,
        nodeInstanceId: dagTransition.enterResult.node.id,
        nodeType: dagTransition.nextNodeType,
        inputType: 'SYSTEM',
        rawInput: '',
        idempotencyKey: `${run.id}_dag_${dagTransition.nextNodeIndex}`,
        chargeKey: body.idempotencyKey, // arch/85 — D5 환불 키
        parsedBy: null,
        confidence: null,
        parsedIntent: null,
        policyResult: 'ALLOW',
        transformedIntent: null,
        actionPlan: null,
        serverResult: dagTransition.enterResult,
        llmStatus: 'PENDING',
      });
      await this.db
        .update(runSessions)
        .set({
          currentTurnNo: turnNo + 1,
          runState: updatedRunState,
          updatedAt: new Date(),
        })
        .where(eq(runSessions.id, run.id));

      return {
        accepted: true,
        turnNo,
        serverResult: resolveResult.serverResult,
        llm: { status: llmStatus, narrative: null },
        meta: { nodeOutcome: 'NODE_ENDED', policyResult: 'ALLOW' },
        transition: {
          nextNodeIndex: dagTransition.nextNodeIndex,
          nextNodeType: dagTransition.nextNodeType,
          enterResult: dagTransition.enterResult,
          battleState: dagTransition.battleState ?? null,
          enterTurnNo: turnNo + 1,
        },
      };
    }

    // ONGOING — 노드 상태 업데이트
    if (resolveResult.nextNodeState) {
      await this.db
        .update(nodeInstances)
        .set({
          nodeState: resolveResult.nextNodeState,
          updatedAt: new Date(),
        })
        .where(eq(nodeInstances.id, currentNode.id));
    }
    await this.db
      .update(runSessions)
      .set({
        currentTurnNo: turnNo,
        runState: updatedRunState,
        updatedAt: new Date(),
      })
      .where(eq(runSessions.id, run.id));

    return {
      accepted: true,
      turnNo,
      serverResult: resolveResult.serverResult,
      llm: { status: llmStatus, narrative: null },
      meta: { nodeOutcome: 'ONGOING', policyResult: 'ALLOW' },
    };
  }
}
