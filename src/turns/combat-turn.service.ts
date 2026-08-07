/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-call */
// [arch/77 §5 후속 — turns.service 파일 분할 5단계, 2026-08-07]
//   전투 턴 전체 트랙(입력 파싱 → 정책 → 노드 리졸버 → 커밋 → 전리품/패배 엔딩).
//   그룹 내부에서만 호출되는 헬퍼 9개를 함께 가져와 전투 관심사를 한 파일에 가둔다.
//   서비스 의존이 18개로 가장 무겁지만 전부 기존 주입을 옮긴 것이다.
import { computeTacticEffects } from '../engine/combat/combat-tactic.core.js';
import { mergeInventoryItem } from './run-state-apply.core.js';
import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { DB, type DrizzleDB } from '../db/drizzle.module.js';
import {
  runSessions,
  nodeInstances,
  battleStates,
  turns,
} from '../db/schema/index.js';
import type {
  BattleStateV1,
  ServerResultV1,
  ActionPlan,
  ParsedIntent,
  PermanentStats,
  RunState,
  WorldState,
} from '../db/types/index.js';
import type { NodeType, LlmStatus } from '../db/types/index.js';
import { InternalError } from '../common/errors/game-errors.js';
import { RuleParserService } from '../engine/input/rule-parser.service.js';
import { PolicyService } from '../engine/input/policy.service.js';
import { ActionPlanService } from '../engine/input/action-plan.service.js';
import { PropMatcherService } from '../engine/combat/prop-matcher.service.js';
import { NodeResolverService } from '../engine/nodes/node-resolver.service.js';
import { NodeTransitionService } from '../engine/nodes/node-transition.service.js';
import { ContentLoaderService } from '../content/content-loader.service.js';
import { InventoryService } from '../engine/rewards/inventory.service.js';
import { RewardsService } from '../engine/rewards/rewards.service.js';
import { RngService } from '../engine/rng/rng.service.js';
import { WorldStateService } from '../engine/hub/world-state.service.js';
import { HeatService } from '../engine/hub/heat.service.js';
import { ArcService } from '../engine/hub/arc.service.js';
import { ChallengeClassifierService } from '../llm/challenge-classifier.service.js';
import { EndingGeneratorService } from '../engine/hub/ending-generator.service.js';
import { SummaryBuilderService } from '../engine/hub/summary-builder.service.js';
import { MemoryIntegrationService } from '../engine/hub/memory-integration.service.js';
import type { SubmitTurnBody } from './dto/submit-turn.dto.js';
import { TurnSharedService } from './turn-shared.service.js';

@Injectable()
export class CombatTurnService {
  private readonly logger = new Logger(CombatTurnService.name);

  constructor(
    @Inject(DB) private readonly db: DrizzleDB,
    private readonly ruleParser: RuleParserService,
    private readonly policyService: PolicyService,
    private readonly actionPlanService: ActionPlanService,
    private readonly propMatcher: PropMatcherService,
    private readonly nodeResolver: NodeResolverService,
    private readonly nodeTransition: NodeTransitionService,
    private readonly content: ContentLoaderService,
    private readonly rngService: RngService,
    private readonly worldStateService: WorldStateService,
    private readonly heatService: HeatService,
    private readonly arcService: ArcService,
    private readonly rewardsService: RewardsService,
    private readonly endingGenerator: EndingGeneratorService,
    private readonly summaryBuilder: SummaryBuilderService,
    private readonly memoryIntegration: MemoryIntegrationService,
    private readonly turnShared: TurnSharedService,
    @Optional()
    private readonly challengeClassifier?: ChallengeClassifierService,
  ) {}

  // --- COMBAT 턴 (기존 전투 엔진 재사용) ---
  // [arch/77 C2] 전투 입력 파이프라인 — RuleParser→Policy(DENY 조기 커밋)→
  // ActionPlan→PropMatch Tier(arch/41)→기만 전술 nano(arch/76 D3-b\u2032-combat).
  // battleState.usedTactics 제자리 변조, DENY면 커밋된 응답을 denyResponse로 반환.
  async buildCombatActionPlan(params: {
    run: any;
    currentNode: any;
    turnNo: number;
    body: SubmitTurnBody;
    rawInput: string;
    battleState: BattleStateV1;
    playerStats: PermanentStats;
  }) {
    const {
      run,
      currentNode,
      turnNo,
      body,
      rawInput,
      battleState,
      playerStats,
    } = params;
    let parsedIntent: ParsedIntent | undefined;
    let actionPlan: ActionPlan | undefined;
    let policyResult: 'ALLOW' | 'TRANSFORM' | 'PARTIAL' | 'DENY' = 'ALLOW';
    let transformedIntent: ParsedIntent | undefined;
    // [arch/76 후속] 기만 전술 의미 단서 — resolve 후 serverResult.ui에 부착
    let combatAppraisalNote: string | null = null;

    if (body.input.type === 'ACTION') {
      parsedIntent = this.ruleParser.parse(rawInput);
      const policyCheck = this.policyService.check(
        parsedIntent,
        currentNode.nodeType,
        currentNode.status as 'NODE_ACTIVE' | 'NODE_ENDED',
        battleState.player?.stamina ?? playerStats.maxStamina,
      );
      policyResult = policyCheck.result;
      if (policyCheck.transformedIntents)
        transformedIntent = policyCheck.transformedIntents;

      if (policyResult === 'DENY') {
        const denyResult = this.buildDenyResult(
          turnNo,
          currentNode,
          policyCheck.reason ?? 'Policy denied',
        );
        const denyResponse = await this.commitCombatTurn(
          run,
          currentNode,
          turnNo,
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
        return { denyResponse } as const;
      }

      const effectiveIntent = transformedIntent ?? parsedIntent;
      actionPlan = this.actionPlanService.buildPlan(
        effectiveIntent,
        policyResult,
        battleState.player?.stamina ?? playerStats.maxStamina,
      );

      // 창의 전투 Tier 1~5 분류 (architecture/41)
      const propMatch = this.propMatcher.classify(
        rawInput,
        battleState.environmentProps ?? [],
      );
      actionPlan.tier = propMatch.tier;
      if (propMatch.prop) actionPlan.prop = propMatch.prop;
      if (propMatch.improvised) actionPlan.improvised = propMatch.improvised;
      if (propMatch.flags) actionPlan.flags = propMatch.flags;
      // Tier 4/5 — 성향 추적 제외
      if (propMatch.tier >= 4) {
        actionPlan.excludeFromArcRoute = true;
        actionPlan.excludeFromCommitment = true;
      }

      // [arch/76 D3-b′-combat] 기만·전술 감정 — 창의 입력(Tier 3/4)만 nano 1콜.
      // Tier 1/2(프롭·카테고리 매칭)는 이미 기계 효과 보유, CHOICE 버튼 전투는
      // 이 분기에 오지 않음 — 평타 템포 보호. 효과 수치는 서버 매핑(불변식 1).
      if (
        (propMatch.tier === 3 || propMatch.tier === 4) &&
        rawInput.trim().length >= 10 &&
        this.challengeClassifier
      ) {
        const aliveEnemies = battleState.enemies.filter((e) => e.hp > 0);
        const appraisal = await this.challengeClassifier.appraiseCombatTactic({
          rawInput,
          enemySummary:
            aliveEnemies
              .map((e) => `${e.name ?? e.id}(${e.personality})`)
              .join(', ') || '없음',
        });
        if (appraisal) {
          const effects = computeTacticEffects(
            appraisal.tactic,
            battleState.enemies,
            battleState.usedTactics ?? [],
          );
          actionPlan.tactical = effects;
          if (!effects.reused) {
            battleState.usedTactics = [
              ...(battleState.usedTactics ?? []),
              appraisal.tactic,
            ];
          }
          this.logger.log(
            `[CombatTactic] ${appraisal.tactic} flee+${effects.fleeBonus} debuff=${Object.keys(effects.accDebuff).length}적 hit+${effects.playerHitBonus}${effects.reused ? ' (재사용 — 효과 0)' : ''}`,
          );
          // [arch/76 후속] 의미 단서 — prompt-builder 답변 가이드가 소비하는
          // appraisalNote(LOCATION nano reason과 동일 채널)에 기만 성격 전달.
          combatAppraisalNote = `상대를 속이기 위한 ${appraisal.reason || '기만 행동'} — 발화·동작의 내용은 실제가 아니다`;
        }
      }
    }

    if (body.input.type === 'CHOICE' && body.input.choiceId) {
      actionPlan = this.mapCombatChoiceToActionPlan(body.input.choiceId);
    }

    return {
      denyResponse: null,
      parsedIntent,
      actionPlan,
      policyResult,
      transformedIntent,
      combatAppraisalNote,
    };
  }

  // [arch/77 C3] 적 정의(콘텐츠)에서 전투용 PermanentStats·표시명 로드.
  loadEnemyStatsForBattle(battleState: BattleStateV1): {
    enemyStats: Record<string, PermanentStats>;
    enemyNames: Record<string, string>;
  } {
    const enemyStats: Record<string, PermanentStats> = {};
    const enemyNames: Record<string, string> = {};
    for (const e of battleState.enemies) {
      const enemyRef = e.id.replace(/_\d+$/, '');
      const def = this.content.getEnemy(enemyRef);
      if (def) {
        const es = def.stats as Record<string, number>;
        enemyStats[e.id] = {
          maxHP: def.hp,
          maxStamina: 5,
          str: es.str ?? es.ATK ?? 10,
          dex: es.dex ?? es.EVA ?? 8,
          wit: es.wit ?? es.ACC ?? 6,
          con: es.con ?? es.DEF ?? 10,
          per: es.per ?? 6,
          cha: es.cha ?? es.SPEED ?? 5,
        };
        enemyNames[e.id] = def.name;
      }
    }
    return { enemyStats, enemyNames };
  }

  // [arch/77 C4] Phase 4a: 전투 승리 시 장비 드랍 — 시드 결정론(run.seed+_eqdrop)
  // 유지, updatedRunState.equipmentBag·serverResult events/diff 제자리 변조.
  applyCombatVictoryDrops(
    run: any,
    currentNode: any,
    turnNo: number,
    resolveResult: ReturnType<NodeResolverService['resolve']>,
    updatedRunState: RunState,
  ): void {
    // Phase 4a: 전투 승리 시 장비 드랍
    if (resolveResult.combatOutcome === 'VICTORY') {
      const locationId =
        updatedRunState.worldState?.currentLocationId ??
        this.content.getHubMeta().defaultLocationId;
      const encounterEnc = currentNode.nodeMeta?.encounterId as
        | string
        | undefined;
      const isBoss = !!currentNode.nodeMeta?.isBoss;
      const enemyIds = Object.keys(
        resolveResult.nextBattleState?.enemies ?? {},
      );
      const combatDropRng = this.rngService.create(
        run.seed + '_eqdrop',
        turnNo,
      );
      const equipDrop = this.rewardsService.rollCombatEquipmentDrops(
        enemyIds,
        encounterEnc,
        isBoss,
        locationId,
        combatDropRng,
      );
      if (equipDrop.droppedInstances.length > 0) {
        if (!updatedRunState.equipmentBag) updatedRunState.equipmentBag = [];
        const combatEquipAdded: import('../db/types/equipment.js').ItemInstance[] =
          [];
        const acquiredFrom = isBoss ? '보스전 드랍' : '전투 보상';
        for (const inst of equipDrop.droppedInstances) {
          updatedRunState.equipmentBag.push(inst);
          combatEquipAdded.push(inst);
          // Phase 3: ItemMemory — 전투 장비 드랍 기록
          this.turnShared.recordItemMemory(
            updatedRunState,
            inst,
            turnNo,
            acquiredFrom,
            locationId,
          );
          resolveResult.serverResult.events.push({
            id: `eq_drop_${inst.instanceId.slice(0, 8)}`,
            kind: 'LOOT',
            text: `[장비] ${inst.displayName} 획득`,
            tags: ['LOOT', 'EQUIPMENT_DROP'],
            data: {
              baseItemId: inst.baseItemId,
              instanceId: inst.instanceId,
              displayName: inst.displayName,
            },
          });
        }
        resolveResult.serverResult.diff.equipmentAdded = combatEquipAdded;
      }
    }
  }

  // [arch/77 C5] 전투 패배 → RUN_ENDED: 메모리 통합 + 엔딩 생성 + Journey
  // summary + 캠페인 결과 저장. response(serverResult ui/events/meta) 제자리 변조.
  async handleCombatDefeatEnding(
    run: any,
    currentNode: any,
    turnNo: number,
    updatedRunState: RunState,
    ws: WorldState,
    response: unknown,
  ): Promise<void> {
    // structuredMemory 통합
    try {
      const locMemDefeat = await this.memoryIntegration.finalizeVisit(
        run.id,
        currentNode.id,
        updatedRunState,
        turnNo,
      );
      if (locMemDefeat) updatedRunState.locationMemories = locMemDefeat;
    } catch {
      /* 메모리 통합 실패는 엔딩 생성에 영향 없음 */
    }

    // 패배 엔딩 생성
    let endingSummaryCombat: ReturnType<
      SummaryBuilderService['buildEndingSummary']
    > | null = null;
    try {
      const endingThreads = (ws.playerThreads ?? []).map((t) => ({
        approachVector: t.approachVector,
        goalCategory: t.goalCategory,
        actionCount: t.actionCount,
        successCount: t.successCount,
        status: t.status,
      }));
      const endingInput = this.endingGenerator.gatherEndingInputs(
        ws.activeIncidents ?? [],
        updatedRunState.npcStates ?? {},
        ws.narrativeMarks ?? [],
        ws as unknown as Record<string, unknown>,
        updatedRunState.arcState ?? null,
        updatedRunState.actionHistory ?? [],
        endingThreads,
      );
      const endingResult = this.endingGenerator.generateEnding(
        endingInput,
        'DEFEAT',
        turnNo,
      );
      const sr = (response as any).serverResult;
      sr.ui = sr.ui ?? {};
      sr.ui.endingResult = endingResult;
      sr.events.push({
        id: `ending_${turnNo}`,
        kind: 'SYSTEM',
        text: `[엔딩] ${endingResult.closingLine}`,
        tags: ['RUN_ENDED'],
        data: { endingResult },
      });
      // Journey Archive: summary 조립
      try {
        endingSummaryCombat = this.summaryBuilder.buildEndingSummary(
          {
            id: run.id,
            presetId: run.presetId ?? null,
            gender: (run.gender as 'male' | 'female' | null) ?? null,
            updatedAt: new Date(),
            currentTurnNo: turnNo,
          },
          updatedRunState,
          endingResult,
        );
      } catch (se) {
        this.logger.warn(
          `EndingSummary build failed (COMBAT DEFEAT) runId=${run.id}: ${String(se)}`,
        );
      }
    } catch (e) {
      this.logger.warn(`DEFEAT ending generation failed: ${e}`);
    }

    await this.db
      .update(runSessions)
      .set({
        status: 'RUN_ENDED',
        updatedAt: new Date(),
        ...(endingSummaryCombat ? { endingSummary: endingSummaryCombat } : {}),
      })
      .where(eq(runSessions.id, run.id));

    // Campaign: 시나리오 결과 저장
    await this.turnShared.saveCampaignResultIfNeeded(run.id);

    (response as any).meta.nodeOutcome = 'RUN_ENDED';
  }

  async handleCombatTurn(
    run: any,
    currentNode: any,
    turnNo: number,
    body: SubmitTurnBody,
    runState: RunState,
    playerStats: PermanentStats,
  ) {
    // BattleState 조회
    const bs = await this.db.query.battleStates.findFirst({
      where: and(
        eq(battleStates.runId, run.id),
        eq(battleStates.nodeInstanceId, currentNode.id),
      ),
    });
    const battleState = bs?.state ?? null;
    if (!battleState)
      throw new InternalError('BattleState not found for COMBAT node');

    // 입력 파이프라인 (기존 로직 재사용)
    let rawInput = body.input.text ?? body.input.choiceId ?? '';
    if (body.input.type === 'CHOICE' && body.input.choiceId) {
      const prevTurn = await this.db.query.turns.findFirst({
        where: and(
          eq(turns.runId, run.id),
          eq(turns.turnNo, run.currentTurnNo),
        ),
        columns: { serverResult: true },
      });
      const prevChoices = (prevTurn?.serverResult as ServerResultV1 | null)
        ?.choices;
      const matched = prevChoices?.find((c) => c.id === body.input.choiceId);
      if (matched) rawInput = matched.label;
    }

    // [arch/77 C2] 전투 입력 파이프라인 — buildCombatActionPlan으로 추출.
    // 파싱→정책(DENY 조기 커밋 포함)→플랜→PropMatch Tier→기만 전술 nano.
    // battleState.usedTactics는 제자리 변조 유지.
    const inputOutcome = await this.buildCombatActionPlan({
      run,
      currentNode,
      turnNo,
      body,
      rawInput,
      battleState,
      playerStats,
    });
    if (inputOutcome.denyResponse) return inputOutcome.denyResponse;
    const {
      parsedIntent,
      policyResult,
      transformedIntent,
      combatAppraisalNote,
    } = inputOutcome;
    const actionPlan = inputOutcome.actionPlan;

    // [arch/77 C3] 적 스탯 로드 — loadEnemyStatsForBattle로 추출.
    const { enemyStats, enemyNames } =
      this.loadEnemyStatsForBattle(battleState);

    // ⚠️ [COMBAT 경로] — 위 DAG 노드 경로(handleDagNodeTurn)에 유사 블록이
    // 하나 더 있다. 편집 전 어느 경로인지 확인할 것 (arch/77 P3.X 오배치 방지).
    const resolveResult = this.nodeResolver.resolve({
      turnNo,
      nodeId: currentNode.id,
      nodeIndex: currentNode.nodeIndex,
      nodeType: 'COMBAT',
      nodeMeta: currentNode.nodeMeta ?? undefined,
      envTags: currentNode.environmentTags ?? [],
      inputType: body.input.type,
      rawInput,
      choiceId: body.input.choiceId,
      actionPlan,
      battleState,
      playerStats,
      enemyStats: Object.keys(enemyStats).length > 0 ? enemyStats : undefined,
      enemyNames: Object.keys(enemyNames).length > 0 ? enemyNames : undefined,
      rewardSeed: `${run.seed}_t${turnNo}`,
      playerHp: battleState.player?.hp ?? runState.hp,
      playerMaxHp: runState.maxHp,
      playerStamina: battleState.player?.stamina ?? runState.stamina,
      playerMaxStamina: runState.maxStamina,
      playerGold: runState.gold,
      inventory: runState.inventory,
      inventoryCount: runState.inventory.length,
      inventoryMax: InventoryService.DEFAULT_MAX_SLOTS,
      nodeState: currentNode.nodeState ?? undefined,
      traitEffects: runState.traitEffects,
    });

    // [arch/76 후속] 기만 전술 의미 단서 → prompt-builder 답변 가이드 채널
    // (LOCATION nano appraisalNote와 동일 소비처 — ui.actionContext)
    if (combatAppraisalNote) {
      const srUi = resolveResult.serverResult as unknown as {
        ui?: Record<string, unknown>;
      };
      srUi.ui = srUi.ui ?? {};
      srUi.ui.actionContext = {
        ...((srUi.ui.actionContext as Record<string, unknown>) ?? {}),
        appraisalNote: combatAppraisalNote,
      };
    }

    // runState 업데이트
    const updatedRunState: RunState = { ...runState };
    const goldDelta =
      resolveResult.goldDelta ??
      resolveResult.serverResult.diff.inventory.goldDelta ??
      0;
    updatedRunState.gold = Math.max(0, updatedRunState.gold + goldDelta);
    if (resolveResult.nextBattleState?.player) {
      updatedRunState.hp = resolveResult.nextBattleState.player.hp;
      updatedRunState.stamina = resolveResult.nextBattleState.player.stamina;
    }
    for (const added of resolveResult.serverResult.diff.inventory.itemsAdded ??
      []) {
      mergeInventoryItem(updatedRunState.inventory, added.itemId, added.qty);
    }

    // [arch/77 C4] 전투 승리 장비 드랍 — applyCombatVictoryDrops로 추출.
    // updatedRunState(equipmentBag)·resolveResult.serverResult(events/diff) 제자리 변조.
    this.applyCombatVictoryDrops(
      run,
      currentNode,
      turnNo,
      resolveResult,
      updatedRunState,
    );

    const response = await this.commitCombatTurn(
      run,
      currentNode,
      turnNo,
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

    // 전투 종료 처리 (VICTORY/DEFEAT/FLEE)
    if (resolveResult.nodeOutcome === 'NODE_ENDED') {
      const ws =
        updatedRunState.worldState ?? this.worldStateService.initWorldState();
      const _arcState =
        updatedRunState.arcState ?? this.arcService.initArcState();

      // [arch/77 C5] 패배 → RUN_ENDED + 엔딩 생성 — handleCombatDefeatEnding.
      // response(serverResult ui/events/meta) 제자리 변조 + DB 커밋 포함.
      if (resolveResult.combatOutcome === 'DEFEAT') {
        await this.handleCombatDefeatEnding(
          run,
          currentNode,
          turnNo,
          updatedRunState,
          ws,
          response,
        );
        return response;
      }

      // DAG 모드: 승리/도주 → 다음 그래프 노드로 전환
      if (run.currentGraphNodeId) {
        const dagRouteContext: import('../db/types/index.js').RouteContext = {
          combatOutcome: resolveResult.combatOutcome,
          routeTag: run.routeTag ?? undefined,
          randomSeed: this.rngService.create(run.seed, turnNo + 1).next(),
        };

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
          try {
            const locMemDag = await this.memoryIntegration.finalizeVisit(
              run.id,
              currentNode.id,
              updatedRunState,
              turnNo,
            );
            if (locMemDag) updatedRunState.locationMemories = locMemDag;
          } catch {
            /* 메모리 통합 실패는 엔딩 생성에 영향 없음 */
          }
          await this.db
            .update(runSessions)
            .set({ status: 'RUN_ENDED', updatedAt: new Date() })
            .where(eq(runSessions.id, run.id));
          await this.turnShared.saveCampaignResultIfNeeded(run.id);
          (response as any).meta.nodeOutcome = 'RUN_ENDED';
          if (dagTransition) {
            (response as any).transition = {
              nextNodeIndex: dagTransition.nextNodeIndex,
              nextNodeType: dagTransition.nextNodeType,
              enterResult: dagTransition.enterResult,
              battleState: null,
              enterTurnNo: turnNo + 1,
            };
          }
          return response;
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

        (response as any).transition = {
          nextNodeIndex: dagTransition.nextNodeIndex,
          nextNodeType: dagTransition.nextNodeType,
          enterResult: dagTransition.enterResult,
          battleState: dagTransition.battleState ?? null,
          enterTurnNo: turnNo + 1,
        };
      } else {
        // HUB 모드: 승리/도주 → 부모 LOCATION 복귀
        const parentNodeId =
          currentNode.parentNodeInstanceId ??
          currentNode.nodeState?.parentNodeId;
        if (parentNodeId) {
          // 부모 노드의 index 찾기
          const parentNode = await this.db.query.nodeInstances.findFirst({
            where: eq(nodeInstances.id, parentNodeId),
          });
          const parentNodeIndex =
            parentNode?.nodeIndex ?? currentNode.nodeIndex - 1;
          const locationId =
            ws.currentLocationId ?? this.content.getHubMeta().defaultLocationId;

          // Heat 반영 (combatWindowCount는 전투 시작 시 이미 증가됨 — 중복 증가 방지)
          const newWs = this.heatService.applyHeatDelta(ws, 3);
          updatedRunState.worldState =
            this.worldStateService.updateHubSafety(newWs);

          const transition = await this.nodeTransition.returnFromCombat(
            run.id,
            parentNodeIndex,
            turnNo + 1,
            locationId,
            updatedRunState.worldState,
          );
          transition.enterResult.turnNo = turnNo + 1;
          await this.db.insert(turns).values({
            runId: run.id,
            turnNo: turnNo + 1,
            nodeInstanceId: transition.enterResult.node.id,
            nodeType: 'LOCATION',
            inputType: 'SYSTEM',
            rawInput: '',
            idempotencyKey: `${run.id}_return_${turnNo + 1}`,
            chargeKey: body.idempotencyKey, // arch/85 — D5 환불 키
            parsedBy: null,
            confidence: null,
            parsedIntent: null,
            policyResult: 'ALLOW',
            transformedIntent: null,
            actionPlan: null,
            serverResult: transition.enterResult,
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

          (response as any).transition = {
            nextNodeIndex: transition.nextNodeIndex,
            nextNodeType: 'LOCATION',
            enterResult: transition.enterResult,
            battleState: null,
            enterTurnNo: turnNo + 1,
          };
        }
      }
    }

    return response;
  }

  // --- Helper: 전투 턴 커밋 ---
  async commitCombatTurn(
    run: any,
    currentNode: any,
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

    await this.db.transaction(async (tx) => {
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
        policyResult: policyResult as any,
        transformedIntent: transformedIntent ?? null,
        actionPlan: actionPlan ?? null,
        serverResult,
        llmStatus,
      });

      await tx
        .update(runSessions)
        .set({
          currentTurnNo: turnNo,
          updatedAt: new Date(),
          ...(nodeOutcome === 'RUN_ENDED' ? { status: 'RUN_ENDED' } : {}),
          ...(runStateUpdate ? { runState: runStateUpdate } : {}),
        })
        .where(eq(runSessions.id, run.id));

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
          .set({ nodeState: nextNodeState, updatedAt: new Date() })
          .where(eq(nodeInstances.id, currentNode.id));
      }

      if (nextBattleState && currentNode.nodeType === 'COMBAT') {
        await tx
          .update(battleStates)
          .set({ state: nextBattleState, updatedAt: new Date() })
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
      meta: { nodeOutcome: nodeOutcome ?? 'ONGOING', policyResult },
    };
  }

  buildDenyResult(turnNo: number, node: any, reason: string): ServerResultV1 {
    return {
      ...this.turnShared.buildSystemResult(turnNo, node, reason),
      events: [
        {
          id: `deny_${turnNo}`,
          kind: 'SYSTEM',
          text: reason,
          tags: ['POLICY_DENY'],
        },
      ],
    };
  }

  // --- 전투 CHOICE 매핑 (기존 재사용) ---
  mapCombatChoiceToActionPlan(choiceId: string): ActionPlan {
    if (choiceId.startsWith('combo_'))
      return this.parseComboChoiceToActionPlan(choiceId);
    if (choiceId === 'env_action')
      return {
        units: [{ type: 'INTERACT', meta: { envAction: true } }],
        consumedSlots: { base: 2, used: 1, bonusUsed: false },
        staminaCost: 1,
        policyResult: 'ALLOW',
        parsedBy: 'RULE',
      };
    if (choiceId === 'combat_avoid')
      return {
        units: [{ type: 'FLEE', meta: { isAvoid: true } }],
        consumedSlots: { base: 2, used: 1, bonusUsed: false },
        staminaCost: 1,
        policyResult: 'ALLOW',
        parsedBy: 'RULE',
      };
    const unit = this.parseCombatChoiceId(choiceId);
    return {
      units: [unit],
      consumedSlots: { base: 2, used: 1, bonusUsed: false },
      staminaCost: 1,
      policyResult: 'ALLOW',
      parsedBy: 'RULE',
    };
  }

  parseComboChoiceToActionPlan(choiceId: string): ActionPlan {
    if (choiceId.startsWith('combo_double_attack_')) {
      const targetId = choiceId.replace('combo_double_attack_', '');
      return {
        units: [
          { type: 'ATTACK_MELEE', targetId },
          { type: 'ATTACK_MELEE', targetId },
        ],
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
    return {
      units: [{ type: 'DEFEND' }],
      consumedSlots: { base: 2, used: 1, bonusUsed: false },
      staminaCost: 1,
      policyResult: 'ALLOW',
      parsedBy: 'RULE',
    };
  }

  parseCombatChoiceId(
    choiceId: string,
  ): import('../db/types/index.js').ActionUnit {
    if (choiceId.startsWith('attack_melee_'))
      return {
        type: 'ATTACK_MELEE',
        targetId: choiceId.replace('attack_melee_', ''),
      };
    if (choiceId === 'defend') return { type: 'DEFEND' };
    if (choiceId === 'evade') return { type: 'EVADE' };
    if (choiceId === 'flee') return { type: 'FLEE' };
    if (choiceId === 'move_forward')
      return { type: 'MOVE', direction: 'FORWARD' };
    if (choiceId === 'move_back') return { type: 'MOVE', direction: 'BACK' };
    if (choiceId.startsWith('use_item_'))
      return {
        type: 'USE_ITEM',
        meta: { itemHint: choiceId.replace('use_item_', '') },
      };
    return { type: 'DEFEND' };
  }
}
