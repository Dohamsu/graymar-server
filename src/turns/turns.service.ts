// 정본: design/server_api_system.md §2 — POST /v1/runs/:runId/turns

import { Inject, Injectable } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
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
import { NodeTransitionService } from '../engine/nodes/node-transition.service.js';
import { ContentLoaderService } from '../content/content-loader.service.js';
import { InventoryService } from '../engine/rewards/inventory.service.js';
import type { SubmitTurnBody, GetTurnQuery } from './dto/submit-turn.dto.js';
import type {
  ActionPlan,
  ParsedIntent,
  PermanentStats,
  RunState,
  RouteContext,
} from '../db/types/index.js';
import type { NodeType, LlmStatus } from '../db/types/index.js';

@Injectable()
export class TurnsService {
  constructor(
    @Inject(DB) private readonly db: DrizzleDB,
    private readonly ruleParser: RuleParserService,
    private readonly policyService: PolicyService,
    private readonly actionPlanService: ActionPlanService,
    private readonly nodeResolver: NodeResolverService,
    private readonly nodeTransition: NodeTransitionService,
    private readonly content: ContentLoaderService,
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

    // RunState 로드 (골드/HP/스태미나/인벤토리)
    const runState = run.runState ?? {
      gold: 0,
      hp: playerStats.maxHP,
      maxHp: playerStats.maxHP,
      stamina: playerStats.maxStamina,
      maxStamina: playerStats.maxStamina,
      inventory: [],
    };

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
      if (!battleState)
        throw new InternalError('BattleState not found for COMBAT node');
    }

    // 7. 입력 파이프라인
    // CHOICE 타입: choiceId 대신 choice label을 rawInput으로 사용 (LLM이 의미 파악 가능)
    let rawInput = body.input.text ?? body.input.choiceId ?? '';
    if (body.input.type === 'CHOICE' && body.input.choiceId) {
      const prevTurn = await this.db.query.turns.findFirst({
        where: and(eq(turns.runId, runId), eq(turns.turnNo, run.currentTurnNo)),
        columns: { serverResult: true },
      });
      const prevChoices = (prevTurn?.serverResult as ServerResultV1 | null)
        ?.choices;
      const matched = prevChoices?.find((c) => c.id === body.input.choiceId);
      if (matched) rawInput = matched.label;
    }
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
        const denyResult = this.buildDenyResult(
          expectedTurnNo,
          currentNode,
          policyCheck.reason ?? 'Policy denied',
        );
        return this.commitTurn(
          run,
          currentNode,
          expectedTurnNo,
          body,
          rawInput,
          parsedIntent,
          policyResult,
          transformedIntent,
          undefined,
          denyResult,
          battleState,
          body.options?.skipLlm,
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

    // 전투 CHOICE → ActionPlan 직접 매핑
    if (
      body.input.type === 'CHOICE' &&
      currentNode.nodeType === 'COMBAT' &&
      body.input.choiceId
    ) {
      actionPlan = this.mapCombatChoiceToActionPlan(body.input.choiceId);
    }

    // 8. 노드 리졸브 — encounter 보상 + 컨텐츠 기반 적 스탯
    let encounterRewards:
      | { clueChance?: { itemId: string; probability: number } }
      | undefined;
    if (currentNode.nodeType === 'COMBAT' && currentNode.nodeMeta) {
      const encId = (currentNode.nodeMeta as Record<string, unknown>)
        .eventId as string | undefined;
      if (encId) {
        const enc = this.content.getEncounter(encId);
        if (enc?.rewards?.clueChance) {
          encounterRewards = { clueChance: enc.rewards.clueChance };
        }
      }
    }

    // encounter overrides 참조용
    let encounterEnemies:
      | Array<{
          ref: string;
          count: number;
          overrides?: {
            name?: string;
            hp?: number;
            stats?: Record<string, number>;
            personality?: string;
          };
        }>
      | undefined;
    if (currentNode.nodeType === 'COMBAT' && currentNode.nodeMeta) {
      const encId = (currentNode.nodeMeta as Record<string, unknown>)
        .eventId as string | undefined;
      if (encId) {
        const enc = this.content.getEncounter(encId);
        if (enc) encounterEnemies = enc.enemies as typeof encounterEnemies;
      }
    }

    const enemyStats: Record<string, PermanentStats> = {};
    if (battleState) {
      for (const e of battleState.enemies) {
        const enemyId = e.id.replace(/_\d+$/, ''); // ENEMY_DOCK_THUG_0 → ENEMY_DOCK_THUG
        const instanceIdx = parseInt(e.id.split('_').pop() ?? '0', 10);
        const def = this.content.getEnemy(enemyId);

        // encounter overrides 찾기 (해당 ref의 첫 번째 entry에서 overrides 적용)
        let overrides:
          | { hp?: number; stats?: Record<string, number> }
          | undefined;
        if (encounterEnemies) {
          let refIdx = 0;
          for (const entry of encounterEnemies) {
            if (entry.ref === enemyId) {
              if (refIdx === 0 && instanceIdx === 0 && entry.overrides) {
                overrides = entry.overrides;
              }
              refIdx++;
            }
          }
        }

        if (def) {
          const hp = overrides?.hp ?? def.hp;
          const stats = overrides?.stats;
          enemyStats[e.id] = {
            maxHP: hp,
            maxStamina: 5,
            atk: stats?.ATK ?? def.stats.ATK,
            def: stats?.DEF ?? def.stats.DEF,
            acc: stats?.ACC ?? def.stats.ACC,
            eva: stats?.EVA ?? def.stats.EVA,
            crit: stats?.CRIT ?? def.stats.CRIT,
            critDmg: Math.round((stats?.CRIT_DMG ?? def.stats.CRIT_DMG) * 100),
            resist: stats?.RESIST ?? def.stats.RESIST,
            speed: stats?.SPEED ?? def.stats.SPEED,
          };
        } else {
          // fallback
          enemyStats[e.id] = {
            maxHP: 80,
            maxStamina: 5,
            atk: 12,
            def: 8,
            acc: 5,
            eva: 3,
            crit: 5,
            critDmg: 150,
            resist: 5,
            speed: 5,
          };
        }
      }
    }

    // 적 ID → 이름 맵 구축 (이벤트 텍스트 + LLM 컨텍스트용)
    const enemyNames: Record<string, string> = {};
    if (battleState) {
      for (const e of battleState.enemies) {
        const enemyRef = e.id.replace(/_\d+$/, '');
        const def = this.content.getEnemy(enemyRef);
        if (def) {
          enemyNames[e.id] = def.name;
        }
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
      enemyNames: Object.keys(enemyNames).length > 0 ? enemyNames : undefined,
      rewardSeed: run.seed,
      encounterRewards,
      playerHp: battleState?.player?.hp ?? runState.hp,
      playerMaxHp: runState.maxHp,
      playerStamina: battleState?.player?.stamina ?? runState.stamina,
      playerMaxStamina: runState.maxStamina,
      playerGold: runState.gold,
      inventory: runState.inventory,
      inventoryCount: runState.inventory.length,
      inventoryMax: InventoryService.DEFAULT_MAX_SLOTS,
      nodeState: currentNode.nodeState ?? undefined,
    });

    // 9. runState 업데이트 계산
    const updatedRunState: RunState = { ...runState };
    // 골드 변경 (SHOP 구매, 전투 보상 등)
    const goldDelta =
      resolveResult.goldDelta ??
      resolveResult.serverResult.diff.inventory.goldDelta ??
      0;
    updatedRunState.gold = Math.max(0, updatedRunState.gold + goldDelta);
    // HP/스태미나 변경 (REST 등)
    if (resolveResult.hpDelta) {
      updatedRunState.hp = Math.min(
        updatedRunState.maxHp,
        Math.max(0, updatedRunState.hp + resolveResult.hpDelta),
      );
    }
    if (resolveResult.staminaDelta) {
      updatedRunState.stamina = Math.min(
        updatedRunState.maxStamina,
        Math.max(0, updatedRunState.stamina + resolveResult.staminaDelta),
      );
    }
    // 전투 후 HP/스태미나 동기화
    if (resolveResult.nextBattleState?.player) {
      updatedRunState.hp = resolveResult.nextBattleState.player.hp;
      updatedRunState.stamina = resolveResult.nextBattleState.player.stamina;
    }
    // 인벤토리: 아이템 추가
    for (const added of resolveResult.serverResult.diff.inventory.itemsAdded ??
      []) {
      const existing = updatedRunState.inventory.find(
        (i) => i.itemId === added.itemId,
      );
      if (existing) {
        existing.qty += added.qty;
      } else {
        updatedRunState.inventory.push({
          itemId: added.itemId,
          qty: added.qty,
        });
      }
    }
    // 인벤토리: 아이템 제거
    for (const removed of resolveResult.serverResult.diff.inventory
      .itemsRemoved ?? []) {
      const existing = updatedRunState.inventory.find(
        (i) => i.itemId === removed.itemId,
      );
      if (existing) {
        existing.qty -= removed.qty;
        if (existing.qty <= 0) {
          updatedRunState.inventory = updatedRunState.inventory.filter(
            (i) => i.itemId !== removed.itemId,
          );
        }
      }
    }

    // 10. 원자 커밋
    const response = await this.commitTurn(
      run,
      currentNode,
      expectedTurnNo,
      body,
      rawInput,
      parsedIntent,
      policyResult,
      transformedIntent,
      actionPlan ? [actionPlan] : undefined,
      resolveResult.serverResult,
      resolveResult.nextBattleState ?? battleState,
      body.options?.skipLlm,
      resolveResult.nodeOutcome,
      resolveResult.nextNodeState,
      updatedRunState,
    );

    // 11. NODE_ENDED 시 노드 전환 (DAG 분기 지원)
    if (resolveResult.nodeOutcome === 'NODE_ENDED') {
      // S2 분기용 choiceId 추출 (nodeState.choicesMade에서 의미론적 ID 검색)
      const branchIds = ['guild_ally', 'guard_ally', 'solo_path'];
      const choicesMade =
        (resolveResult.nextNodeState?.choicesMade as string[] | undefined) ??
        [];
      const branchChoice = choicesMade.find((c) => branchIds.includes(c));

      // branchChoiceId를 runState에 기록
      if (branchChoice) {
        updatedRunState.branchChoiceId = branchChoice;
        // runState 재저장 (commitTurn 트랜잭션 이후이므로 별도 UPDATE)
        await this.db
          .update(runSessions)
          .set({ runState: updatedRunState, updatedAt: new Date() })
          .where(eq(runSessions.id, runId));
      }

      // RouteContext 구성
      const context: RouteContext = {
        lastChoiceId: branchChoice ?? resolveResult.selectedChoiceId,
        combatOutcome: resolveResult.combatOutcome,
        routeTag: (run.routeTag as string | undefined) ?? undefined,
      };

      const transition = await this.nodeTransition.advanceToNextNode(
        runId,
        currentNode.nodeIndex,
        expectedTurnNo,
        run.seed,
        updatedRunState.hp,
        updatedRunState.stamina,
        run.currentGraphNodeId ?? undefined,
        context,
        updatedRunState,
      );

      if (transition) {
        // routeTag가 갱신되었으면 runState에도 반영
        if (
          transition.routeTag &&
          transition.routeTag !== updatedRunState.routeTag
        ) {
          updatedRunState.routeTag = transition.routeTag;
          await this.db
            .update(runSessions)
            .set({ runState: updatedRunState, updatedAt: new Date() })
            .where(eq(runSessions.id, runId));
        }

        // 노드 진입 턴 생성 → LLM이 내러티브 생성
        const enterTurnNo = expectedTurnNo + 1;
        // enterResult.turnNo를 enterTurnNo로 교정 (action 결과와 ID 충돌 방지)
        transition.enterResult.turnNo = enterTurnNo;
        await this.db.insert(turns).values({
          runId,
          turnNo: enterTurnNo,
          nodeInstanceId: transition.enterResult.node.id,
          nodeType: transition.nextNodeType,
          inputType: 'SYSTEM',
          rawInput: '',
          idempotencyKey: `${runId}_enter_${transition.nextNodeIndex}`,
          parsedBy: null,
          confidence: null,
          parsedIntent: null,
          policyResult: 'ALLOW',
          transformedIntent: null,
          actionPlan: null,
          serverResult: transition.enterResult,
          llmStatus: 'PENDING',
        });

        // currentTurnNo 갱신
        await this.db
          .update(runSessions)
          .set({ currentTurnNo: enterTurnNo, updatedAt: new Date() })
          .where(eq(runSessions.id, runId));

        (response as Record<string, unknown>).transition = {
          nextNodeIndex: transition.nextNodeIndex,
          nextNodeType: transition.nextNodeType,
          enterResult: transition.enterResult,
          battleState: transition.battleState ?? null,
          enterTurnNo,
        };
      } else {
        // 다음 노드가 없으면 RUN_ENDED
        response.meta.nodeOutcome = 'RUN_ENDED';
        await this.db
          .update(runSessions)
          .set({ status: 'RUN_ENDED', updatedAt: new Date() })
          .where(eq(runSessions.id, runId));
      }
    }

    return response;
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
    runStateUpdate?: RunState,
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
        inputType: body.input.type,
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

      // run.currentTurnNo + runState 갱신
      await tx
        .update(runSessions)
        .set({
          currentTurnNo: turnNo,
          updatedAt: new Date(),
          ...(nodeOutcome === 'RUN_ENDED' ? { status: 'RUN_ENDED' } : {}),
          ...(runStateUpdate ? { runState: runStateUpdate } : {}),
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

  async getTurnDetail(
    runId: string,
    turnNo: number,
    userId: string,
    query: GetTurnQuery,
  ) {
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

  private mapCombatChoiceToActionPlan(choiceId: string): ActionPlan {
    // 콤보
    if (choiceId.startsWith('combo_')) return this.parseComboChoiceToActionPlan(choiceId);
    // 환경 활용
    if (choiceId === 'env_action') {
      return {
        units: [{ type: 'INTERACT', meta: { envAction: true } }],
        consumedSlots: { base: 2, used: 1, bonusUsed: false },
        staminaCost: 1,
        policyResult: 'ALLOW',
        parsedBy: 'RULE',
      };
    }
    // 전투 회피
    if (choiceId === 'combat_avoid') {
      return {
        units: [{ type: 'FLEE', meta: { isAvoid: true } }],
        consumedSlots: { base: 2, used: 1, bonusUsed: false },
        staminaCost: 1,
        policyResult: 'ALLOW',
        parsedBy: 'RULE',
      };
    }
    // 기존 단일 액션
    const unit = this.parseCombatChoiceId(choiceId);
    return {
      units: [unit],
      consumedSlots: { base: 2, used: 1, bonusUsed: false },
      staminaCost: 1,
      policyResult: 'ALLOW',
      parsedBy: 'RULE',
    };
  }

  private parseComboChoiceToActionPlan(choiceId: string): ActionPlan {
    if (choiceId.startsWith('combo_double_attack_')) {
      const targetId = choiceId.replace('combo_double_attack_', '');
      return {
        units: [{ type: 'ATTACK_MELEE', targetId }, { type: 'ATTACK_MELEE', targetId }],
        consumedSlots: { base: 2, used: 2, bonusUsed: false },
        staminaCost: 2,
        policyResult: 'ALLOW',
        parsedBy: 'RULE',
      };
    }
    if (choiceId.startsWith('combo_attack_defend_')) {
      const targetId = choiceId.replace('combo_attack_defend_', '');
      return {
        units: [{ type: 'ATTACK_MELEE', targetId }, { type: 'DEFEND' }],
        consumedSlots: { base: 2, used: 2, bonusUsed: false },
        staminaCost: 2,
        policyResult: 'ALLOW',
        parsedBy: 'RULE',
      };
    }
    // fallback
    return {
      units: [{ type: 'DEFEND' }],
      consumedSlots: { base: 2, used: 1, bonusUsed: false },
      staminaCost: 1,
      policyResult: 'ALLOW',
      parsedBy: 'RULE',
    };
  }

  private parseCombatChoiceId(
    choiceId: string,
  ): import('../db/types/index.js').ActionUnit {
    if (choiceId.startsWith('attack_melee_')) {
      return {
        type: 'ATTACK_MELEE',
        targetId: choiceId.replace('attack_melee_', ''),
      };
    }
    if (choiceId === 'defend') return { type: 'DEFEND' };
    if (choiceId === 'evade') return { type: 'EVADE' };
    if (choiceId === 'flee') return { type: 'FLEE' };
    if (choiceId === 'move_forward')
      return { type: 'MOVE', direction: 'FORWARD' };
    if (choiceId === 'move_back') return { type: 'MOVE', direction: 'BACK' };
    if (choiceId.startsWith('use_item_')) {
      const itemId = choiceId.replace('use_item_', '');
      return { type: 'USE_ITEM', meta: { itemHint: itemId } };
    }
    // fallback
    return { type: 'DEFEND' };
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
      summary: { short: reason, display: reason },
      events: [
        {
          id: `deny_${turnNo}`,
          kind: 'SYSTEM',
          text: reason,
          tags: ['POLICY_DENY'],
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
