// 정본: design/server_api_system.md §2 — POST /v1/runs/:runId/turns

import { Inject, Injectable } from '@nestjs/common';
import { and, eq, sql } from 'drizzle-orm';
import { DB, type DrizzleDB } from '../db/drizzle.module.js';
import {
  runSessions,
  nodeInstances,
  battleStates,
  turns,
  playerProfiles,
} from '../db/schema/index.js';
import { DEFAULT_PERMANENT_STATS } from '../db/types/index.js';
import type { BattleStateV1, ServerResultV1 } from '../db/types/index.js';
import {
  ForbiddenError,
  InternalError,
  InvalidInputError,
  NotFoundError,
  TurnConflictError,
} from '../common/errors/game-errors.js';
import { RuleParserService } from '../engine/input/rule-parser.service.js';
import { PolicyService } from '../engine/input/policy.service.js';
import { ActionPlanService } from '../engine/input/action-plan.service.js';
import { NodeResolverService } from '../engine/nodes/node-resolver.service.js';
import { InventoryService } from '../engine/rewards/inventory.service.js';
import type { SubmitTurnBody, GetTurnQuery } from './dto/submit-turn.dto.js';
import type { ActionPlan, ParsedIntent } from '../db/types/index.js';
import type { NodeType, InputType, LlmStatus } from '../db/types/index.js';

@Injectable()
export class TurnsService {
  constructor(
    @Inject(DB) private readonly db: DrizzleDB,
    private readonly ruleParser: RuleParserService,
    private readonly policyService: PolicyService,
    private readonly actionPlanService: ActionPlanService,
    private readonly nodeResolver: NodeResolverService,
  ) {}

  async submitTurn(runId: string, userId: string, body: SubmitTurnBody) {
    // 1. 멱등성 체크
    const existingTurn = await this.db.query.turns.findFirst({
      where: and(
        eq(turns.runId, runId),
        eq(turns.idempotencyKey, body.idempotencyKey),
      ),
    });
    if (existingTurn) {
      return {
        accepted: true,
        turnNo: existingTurn.turnNo,
        serverResult: existingTurn.serverResult,
        llm: {
          status: existingTurn.llmStatus,
          narrative: existingTurn.llmOutput,
        },
      };
    }

    // 2. RUN 조회 + 소유권 검증
    const run = await this.db.query.runSessions.findFirst({
      where: eq(runSessions.id, runId),
    });
    if (!run) throw new NotFoundError('Run not found');
    if (run.userId !== userId) throw new ForbiddenError('Not your run');
    if (run.status !== 'RUN_ACTIVE') {
      throw new InvalidInputError('Run is not active');
    }

    // 3. expectedNextTurnNo 검증
    const expectedTurnNo = run.currentTurnNo + 1;
    if (body.expectedNextTurnNo !== expectedTurnNo) {
      throw new TurnConflictError('TURN_NO_MISMATCH', 'Turn number mismatch', {
        expected: expectedTurnNo,
        received: body.expectedNextTurnNo,
      });
    }

    // 4. 현재 노드 조회
    const currentNode = await this.db.query.nodeInstances.findFirst({
      where: and(
        eq(nodeInstances.runId, runId),
        eq(nodeInstances.nodeIndex, run.currentNodeIndex),
      ),
    });
    if (!currentNode) throw new InternalError('Current node not found');
    if (currentNode.status !== 'NODE_ACTIVE') {
      throw new InvalidInputError('Current node is not active');
    }

    // 5. 플레이어 프로필 조회
    const profile = await this.db.query.playerProfiles.findFirst({
      where: eq(playerProfiles.userId, userId),
    });
    const playerStats = profile?.permanentStats ?? DEFAULT_PERMANENT_STATS;

    // 6. BattleState 조회 (COMBAT 노드)
    let battleState: BattleStateV1 | null = null;
    if (currentNode.nodeType === 'COMBAT') {
      const bs = await this.db.query.battleStates.findFirst({
        where: and(
          eq(battleStates.runId, runId),
          eq(battleStates.nodeInstanceId, currentNode.id),
        ),
      });
      battleState = bs?.state ?? null;
      if (!battleState) throw new InternalError('BattleState not found for COMBAT node');
    }

    // 7. 입력 파이프라인
    const rawInput = body.input.text ?? body.input.choiceId ?? '';
    let parsedIntent: ParsedIntent | undefined;
    let actionPlan: ActionPlan | undefined;
    let policyResult: 'ALLOW' | 'TRANSFORM' | 'PARTIAL' | 'DENY' = 'ALLOW';
    let transformedIntent: ParsedIntent | undefined;

    if (body.input.type === 'ACTION') {
      // Rule Parser
      parsedIntent = this.ruleParser.parse(rawInput);

      // Policy Check
      const policyCheck = this.policyService.check(
        parsedIntent,
        currentNode.nodeType,
        currentNode.status as 'NODE_ACTIVE' | 'NODE_ENDED',
        battleState?.player?.stamina ?? playerStats.maxStamina,
      );
      policyResult = policyCheck.result;
      if (policyCheck.transformedIntents) {
        transformedIntent = policyCheck.transformedIntents;
      }

      if (policyResult === 'DENY') {
        // DENY 시에도 턴은 기록하되 결과는 SYSTEM 이벤트
        const denyResult = this.buildDenyResult(
          expectedTurnNo,
          currentNode,
          policyCheck.reason ?? 'Policy denied',
        );
        return this.commitTurn(
          run, currentNode, expectedTurnNo, body, rawInput,
          parsedIntent, policyResult, transformedIntent, undefined,
          denyResult, battleState, body.options?.skipLlm,
        );
      }

      // Action Plan 생성
      const effectiveIntent = transformedIntent ?? parsedIntent;
      actionPlan = this.actionPlanService.buildPlan(
        effectiveIntent,
        policyResult,
        battleState?.player?.stamina ?? playerStats.maxStamina,
      );
    }

    // 8. 노드 리졸브
    const enemyStats: Record<string, typeof playerStats> = {};
    if (battleState) {
      for (const e of battleState.enemies) {
        enemyStats[e.id] = {
          maxHP: 80, maxStamina: 5, atk: 12, def: 8, acc: 5, eva: 3,
          crit: 5, critDmg: 150, resist: 5, speed: 5,
        };
      }
    }

    const resolveResult = this.nodeResolver.resolve({
      turnNo: expectedTurnNo,
      nodeId: currentNode.id,
      nodeIndex: currentNode.nodeIndex,
      nodeType: currentNode.nodeType,
      nodeMeta: currentNode.nodeMeta ?? undefined,
      envTags: currentNode.environmentTags ?? [],
      inputType: body.input.type,
      rawInput,
      choiceId: body.input.choiceId,
      actionPlan,
      battleState: battleState ?? undefined,
      playerStats,
      enemyStats: Object.keys(enemyStats).length > 0 ? enemyStats : undefined,
      rewardSeed: run.seed,
      playerHp: battleState?.player?.hp ?? playerStats.maxHP,
      playerMaxHp: playerStats.maxHP,
      playerStamina: battleState?.player?.stamina ?? playerStats.maxStamina,
      playerMaxStamina: playerStats.maxStamina,
      playerGold: 0,
      inventoryCount: 0,
      inventoryMax: InventoryService.DEFAULT_MAX_SLOTS,
      nodeState: currentNode.nodeState ?? undefined,
    });

    // 9. 원자 커밋
    return this.commitTurn(
      run, currentNode, expectedTurnNo, body, rawInput,
      parsedIntent, policyResult, transformedIntent, actionPlan ? [actionPlan] : undefined,
      resolveResult.serverResult, resolveResult.nextBattleState ?? battleState,
      body.options?.skipLlm,
      resolveResult.nodeOutcome, resolveResult.nextNodeState,
    );
  }

  private async commitTurn(
    run: { id: string; currentTurnNo: number },
    currentNode: { id: string; nodeType: string; nodeIndex: number },
    turnNo: number,
    body: SubmitTurnBody,
    rawInput: string,
    parsedIntent: ParsedIntent | undefined,
    policyResult: string,
    transformedIntent: ParsedIntent | undefined,
    actionPlan: ActionPlan[] | undefined,
    serverResult: ServerResultV1,
    nextBattleState: BattleStateV1 | null | undefined,
    skipLlm: boolean | undefined,
    nodeOutcome?: string,
    nextNodeState?: Record<string, unknown>,
  ) {
    const llmStatus: LlmStatus = skipLlm ? 'SKIPPED' : 'PENDING';

    // DB 트랜잭션
    await this.db.transaction(async (tx) => {
      // turn 생성
      await tx.insert(turns).values({
        runId: run.id,
        turnNo,
        nodeInstanceId: currentNode.id,
        nodeType: currentNode.nodeType as NodeType,
        inputType: body.input.type as InputType,
        rawInput,
        idempotencyKey: body.idempotencyKey,
        parsedBy: parsedIntent?.source ?? null,
        confidence: parsedIntent?.confidence ?? null,
        parsedIntent: parsedIntent ?? null,
        policyResult: policyResult as typeof turns.$inferInsert.policyResult,
        transformedIntent: transformedIntent ?? null,
        actionPlan: actionPlan ?? null,
        serverResult,
        llmStatus,
      });

      // run.currentTurnNo 갱신
      await tx
        .update(runSessions)
        .set({
          currentTurnNo: turnNo,
          updatedAt: new Date(),
          ...(nodeOutcome === 'RUN_ENDED' ? { status: 'RUN_ENDED' } : {}),
        })
        .where(eq(runSessions.id, run.id));

      // 노드 상태 갱신
      if (nodeOutcome === 'NODE_ENDED' || nodeOutcome === 'RUN_ENDED') {
        await tx
          .update(nodeInstances)
          .set({
            status: 'NODE_ENDED',
            nodeState: nextNodeState ?? null,
            updatedAt: new Date(),
          })
          .where(eq(nodeInstances.id, currentNode.id));
      } else if (nextNodeState) {
        await tx
          .update(nodeInstances)
          .set({
            nodeState: nextNodeState,
            updatedAt: new Date(),
          })
          .where(eq(nodeInstances.id, currentNode.id));
      }

      // BattleState 갱신 (COMBAT)
      if (nextBattleState && currentNode.nodeType === 'COMBAT') {
        await tx
          .update(battleStates)
          .set({
            state: nextBattleState,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(battleStates.runId, run.id),
              eq(battleStates.nodeInstanceId, currentNode.id),
            ),
          );
      }
    });

    return {
      accepted: true,
      turnNo,
      serverResult,
      llm: { status: llmStatus, narrative: null },
      meta: {
        nodeOutcome: nodeOutcome ?? 'ONGOING',
        policyResult,
      },
    };
  }

  async getTurnDetail(runId: string, turnNo: number, userId: string, query: GetTurnQuery) {
    const run = await this.db.query.runSessions.findFirst({
      where: eq(runSessions.id, runId),
    });
    if (!run) throw new NotFoundError('Run not found');
    if (run.userId !== userId) throw new ForbiddenError('Not your run');

    const turn = await this.db.query.turns.findFirst({
      where: and(eq(turns.runId, runId), eq(turns.turnNo, turnNo)),
    });
    if (!turn) throw new NotFoundError('Turn not found');

    const response: Record<string, unknown> = {
      run: {
        id: run.id,
        status: run.status,
        actLevel: run.actLevel,
        currentTurnNo: run.currentTurnNo,
      },
      turn: {
        turnNo: turn.turnNo,
        nodeInstanceId: turn.nodeInstanceId,
        nodeType: turn.nodeType,
        inputType: turn.inputType,
        rawInput: turn.rawInput,
        createdAt: turn.createdAt,
      },
      serverResult: turn.serverResult,
      llm: {
        status: turn.llmStatus,
        output: turn.llmOutput,
        modelUsed: turn.llmModelUsed,
        completedAt: turn.llmCompletedAt,
        error: turn.llmError,
      },
    };

    if (query.includeDebug) {
      response.debug = {
        parsedBy: turn.parsedBy,
        parseConfidence: turn.confidence,
        parsedIntent: turn.parsedIntent,
        policyResult: turn.policyResult,
        actionPlan: turn.actionPlan,
        idempotencyKey: turn.idempotencyKey,
      };
    }

    return response;
  }

  private buildDenyResult(
    turnNo: number,
    node: { id: string; nodeType: string; nodeIndex: number },
    reason: string,
  ): ServerResultV1 {
    return {
      version: 'server_result_v1',
      turnNo,
      node: {
        id: node.id,
        type: node.nodeType as ServerResultV1['node']['type'],
        index: node.nodeIndex,
        state: 'NODE_ACTIVE',
      },
      summary: { short: reason },
      events: [{
        id: `deny_${turnNo}`,
        kind: 'SYSTEM',
        text: reason,
        tags: ['POLICY_DENY'],
      }],
      diff: {
        player: { hp: { from: 0, to: 0, delta: 0 }, stamina: { from: 0, to: 0, delta: 0 }, status: [] },
        enemies: [],
        inventory: { itemsAdded: [], itemsRemoved: [], goldDelta: 0 },
        meta: { battle: { phase: 'NONE' }, position: { env: [] } },
      },
      ui: {
        availableActions: [],
        targetLabels: [],
        actionSlots: { base: 2, bonusAvailable: false, max: 3 },
        toneHint: 'neutral',
      },
      choices: [],
      flags: { bonusSlot: false, downed: false, battleEnded: false },
    };
  }
}
