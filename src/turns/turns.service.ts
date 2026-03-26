// 정본: specs/HUB_system.md — Action-First 턴 파이프라인

import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { and, asc, eq, ne } from 'drizzle-orm';
import { DB, type DrizzleDB } from '../db/drizzle.module.js';
import {
  runSessions,
  nodeInstances,
  battleStates,
  turns,
  playerProfiles,
  runMemories,
} from '../db/schema/index.js';
import { DEFAULT_PERMANENT_STATS, deriveCombatStats } from '../db/types/index.js';
import type {
  BattleStateV1,
  ServerResultV1,
  ActionPlan,
  ParsedIntent,
  PermanentStats,
  RunState,
  WorldState,
  ArcState,
  PlayerAgenda,
  ChoiceItem,
} from '../db/types/index.js';
import { computePBP } from '../db/types/player-behavior.js';
import type { NodeType, LlmStatus } from '../db/types/index.js';
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
import { RewardsService } from '../engine/rewards/rewards.service.js';
import { EquipmentService } from '../engine/rewards/equipment.service.js';
import { RngService } from '../engine/rng/rng.service.js';
// HUB 엔진 서비스
import { WorldStateService } from '../engine/hub/world-state.service.js';
import { HeatService } from '../engine/hub/heat.service.js';
import { EventMatcherService } from '../engine/hub/event-matcher.service.js';
import { ResolveService } from '../engine/hub/resolve.service.js';
import { AgendaService } from '../engine/hub/agenda.service.js';
import { ArcService } from '../engine/hub/arc.service.js';
import { SceneShellService } from '../engine/hub/scene-shell.service.js';
import { IntentParserV2Service } from '../engine/hub/intent-parser-v2.service.js';
import { LlmIntentParserService } from '../engine/hub/llm-intent-parser.service.js';
import { TurnOrchestrationService, NPC_LOCATION_AFFINITY } from '../engine/hub/turn-orchestration.service.js';
// User-Driven System v3
import { IntentV3BuilderService } from '../engine/hub/intent-v3-builder.service.js';
import { IncidentRouterService } from '../engine/hub/incident-router.service.js';
import { WorldDeltaService } from '../engine/hub/world-delta.service.js';
import { PlayerThreadService } from '../engine/hub/player-thread.service.js';
import { IncidentResolutionBridgeService } from '../engine/hub/incident-resolution-bridge.service.js';
// Notification System
import { NotificationAssemblerService } from '../engine/hub/notification-assembler.service.js';
// Signal Feed
import { SignalFeedService } from '../engine/hub/signal-feed.service.js';
// Narrative Engine v1
import { WorldTickService } from '../engine/hub/world-tick.service.js';
import { IncidentManagementService } from '../engine/hub/incident-management.service.js';
import { NpcEmotionalService } from '../engine/hub/npc-emotional.service.js';
import { NarrativeMarkService } from '../engine/hub/narrative-mark.service.js';
import { EndingGeneratorService } from '../engine/hub/ending-generator.service.js';
import { MemoryCollectorService, TAG_TO_NPC } from '../engine/hub/memory-collector.service.js';
import { MemoryIntegrationService } from '../engine/hub/memory-integration.service.js';
// Event Director + Procedural Event (설계문서 19, 20)
import { EventDirectorService } from '../engine/hub/event-director.service.js';
import { ProceduralEventService } from '../engine/hub/procedural-event.service.js';
import { SituationGeneratorService } from '../engine/hub/situation-generator.service.js';
import { ConsequenceProcessorService } from '../engine/hub/consequence-processor.service.js';
import { PlayerGoalService } from '../engine/hub/player-goal.service.js';
import { QuestProgressionService } from '../engine/hub/quest-progression.service.js';
import { ShopService } from '../engine/hub/shop.service.js';
import { LegendaryRewardService } from '../engine/rewards/legendary-reward.service.js';
import type { RegionEconomy } from '../db/types/region-state.js';
import { CampaignsService } from '../campaigns/campaigns.service.js';
import type { ProceduralHistoryEntry } from '../db/types/procedural-event.js';
import { initNPCState, getNpcDisplayName, shouldIntroduce, computeEffectivePosture as computePosture, resolveNpcPlaceholders, recordNpcEncounter, addNpcKnownFact } from '../db/types/npc-state.js';
import type { IncidentDef, IncidentRuntime, IncidentRoutingResult, NarrativeMarkCondition, NPCState, NpcEmotionalState } from '../db/types/index.js';
import type { IncidentSummaryUI, SignalFeedItemUI, NpcEmotionalUI } from '../db/types/server-result.js';
import type { SubmitTurnBody, GetTurnQuery } from './dto/submit-turn.dto.js';

/** 한국어 조사 자동 판별 — 받침 유무에 따라 을/를, 이/가 등 선택 */
function korParticle(word: string, withBatchim: string, withoutBatchim: string): string {
  if (!word) return withBatchim;
  const last = word.charCodeAt(word.length - 1);
  if (last < 0xAC00 || last > 0xD7A3) return withBatchim;
  return (last - 0xAC00) % 28 !== 0 ? withBatchim : withoutBatchim;
}

@Injectable()
export class TurnsService {
  private readonly logger = new Logger(TurnsService.name);

  constructor(
    @Inject(DB) private readonly db: DrizzleDB,
    private readonly ruleParser: RuleParserService,
    private readonly policyService: PolicyService,
    private readonly actionPlanService: ActionPlanService,
    private readonly nodeResolver: NodeResolverService,
    private readonly nodeTransition: NodeTransitionService,
    private readonly content: ContentLoaderService,
    private readonly rngService: RngService,
    // HUB 엔진
    private readonly worldStateService: WorldStateService,
    private readonly heatService: HeatService,
    private readonly eventMatcher: EventMatcherService,
    private readonly resolveService: ResolveService,
    private readonly agendaService: AgendaService,
    private readonly arcService: ArcService,
    private readonly sceneShellService: SceneShellService,
    private readonly intentParser: IntentParserV2Service,
    private readonly llmIntentParser: LlmIntentParserService,
    private readonly orchestration: TurnOrchestrationService,
    private readonly rewardsService: RewardsService,
    private readonly equipmentService: EquipmentService,
    // User-Driven System v3
    private readonly intentV3Builder: IntentV3BuilderService,
    private readonly incidentRouter: IncidentRouterService,
    private readonly worldDeltaService: WorldDeltaService,
    private readonly playerThreadService: PlayerThreadService,
    private readonly incidentBridge: IncidentResolutionBridgeService,
    // Notification System
    private readonly notificationAssembler: NotificationAssemblerService,
    // Signal Feed (행동 결과 시그널)
    private readonly signalFeed: SignalFeedService,
    // Narrative Engine v1
    private readonly worldTick: WorldTickService,
    private readonly incidentMgmt: IncidentManagementService,
    private readonly npcEmotional: NpcEmotionalService,
    private readonly narrativeMarkService: NarrativeMarkService,
    private readonly endingGenerator: EndingGeneratorService,
    // Structured Memory v2
    private readonly memoryCollector: MemoryCollectorService,
    private readonly memoryIntegration: MemoryIntegrationService,
    // Event Director + Procedural Event (설계문서 19, 20)
    private readonly eventDirector: EventDirectorService,
    private readonly proceduralEvent: ProceduralEventService,
    // Campaign system
    private readonly campaignsService: CampaignsService,
    // Living World v2
    private readonly shopService: ShopService,
    // Phase 4d: Legendary Quest Rewards
    private readonly legendaryRewardService: LegendaryRewardService,
    @Optional() private readonly situationGenerator?: SituationGeneratorService,
    @Optional() private readonly consequenceProcessor?: ConsequenceProcessorService,
    @Optional() private readonly playerGoalService?: PlayerGoalService,
    @Optional() private readonly questProgression?: QuestProgressionService,
  ) {}

  /** RUN_ENDED 시 캠페인 시나리오 결과 저장 (캠페인 모드일 때만) */
  private async saveCampaignResultIfNeeded(runId: string): Promise<void> {
    try {
      const run = await this.db.query.runSessions.findFirst({
        where: eq(runSessions.id, runId),
        columns: { campaignId: true },
      });
      if (run?.campaignId) {
        await this.campaignsService.saveScenarioResult(run.campaignId, runId);
        this.logger.log(`Campaign scenario result saved: campaign=${run.campaignId}, run=${runId}`);
      }
    } catch (err) {
      // 캠페인 결과 저장 실패는 게임 종료에 영향 없음
      this.logger.warn(`Failed to save campaign scenario result for run ${runId}: ${(err as Error).message}`);
    }
  }

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
        llm: { status: existingTurn.llmStatus, narrative: existingTurn.llmOutput },
      };
    }

    // 2. RUN 조회 + 소유권 검증
    const run = await this.db.query.runSessions.findFirst({
      where: eq(runSessions.id, runId),
    });
    if (!run) throw new NotFoundError('Run not found');
    if (run.userId !== userId) throw new ForbiddenError('Not your run');
    if (run.status !== 'RUN_ACTIVE') throw new InvalidInputError('Run is not active');

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

    // 5. 플레이어 프로필
    const profile = await this.db.query.playerProfiles.findFirst({
      where: eq(playerProfiles.userId, userId),
    });
    const playerStats = deriveCombatStats(profile?.permanentStats ?? DEFAULT_PERMANENT_STATS);

    const runState = run.runState ?? {
      gold: 0,
      hp: playerStats.maxHP,
      maxHp: playerStats.maxHP,
      stamina: playerStats.maxStamina,
      maxStamina: playerStats.maxStamina,
      inventory: [],
    };

    // 노드 타입에 따라 분기
    const nodeType = currentNode.nodeType as NodeType;

    if (nodeType === 'HUB') {
      return this.handleHubTurn(run, currentNode, expectedTurnNo, body, runState, playerStats);
    } else if (nodeType === 'LOCATION') {
      return this.handleLocationTurn(run, currentNode, expectedTurnNo, body, runState, playerStats);
    } else if (nodeType === 'COMBAT') {
      return this.handleCombatTurn(run, currentNode, expectedTurnNo, body, runState, playerStats);
    } else if (run.currentGraphNodeId && (nodeType === 'EVENT' || nodeType === 'REST' || nodeType === 'SHOP' || nodeType === 'EXIT')) {
      return this.handleDagNodeTurn(run, currentNode, expectedTurnNo, body, runState, playerStats);
    }

    throw new InvalidInputError(`Unsupported node type: ${nodeType}`);
  }

  // --- HUB 턴 ---
  private async handleHubTurn(
    run: any,
    currentNode: any,
    turnNo: number,
    body: SubmitTurnBody,
    runState: RunState,
    playerStats: PermanentStats,
  ) {
    if (body.input.type !== 'CHOICE' || !body.input.choiceId) {
      throw new InvalidInputError('HUB requires CHOICE input');
    }

    const ws = runState.worldState ?? this.worldStateService.initWorldState();
    const arcState = runState.arcState ?? this.arcService.initArcState();
    const agenda = runState.agenda ?? this.agendaService.initAgenda();
    const updatedRunState: RunState = { ...runState };

    const choiceId = body.input.choiceId;

    // LOCATION 이동
    const locationMap: Record<string, string> = {
      go_market: 'LOC_MARKET',
      go_guard: 'LOC_GUARD',
      go_harbor: 'LOC_HARBOR',
      go_slums: 'LOC_SLUMS',
    };
    const locationNameMap: Record<string, string> = {
      go_market: '시장 거리',
      go_guard: '경비대 지구',
      go_harbor: '항만 부두',
      go_slums: '빈민가',
    };

    if (locationMap[choiceId]) {
      const locationId = locationMap[choiceId];
      const locName = locationNameMap[choiceId] ?? locationId;
      const newWs = this.worldStateService.moveToLocation(ws, locationId);
      updatedRunState.worldState = newWs;
      updatedRunState.actionHistory = []; // LOCATION 이동 시 고집 이력 초기화

      // Arc unlock 체크
      const newUnlocks = this.arcService.checkUnlockConditions(newWs);
      if (newUnlocks.length > 0) {
        updatedRunState.worldState = {
          ...newWs,
          mainArc: {
            ...newWs.mainArc,
            unlockedArcIds: [...newWs.mainArc.unlockedArcIds, ...newUnlocks],
          },
        };
      }

      // 현재 HUB 노드를 NODE_ENDED로
      await this.db
        .update(nodeInstances)
        .set({ status: 'NODE_ENDED', updatedAt: new Date() })
        .where(eq(nodeInstances.id, currentNode.id));

      // HUB 선택 턴 커밋
      const hubResult = this.buildSystemResult(turnNo, currentNode, `${locName}(으)로 향한다.`);
      await this.commitTurnRecord(run, currentNode, turnNo, body, choiceId, hubResult, updatedRunState, body.options?.skipLlm);

      // LOCATION 전환
      const transition = await this.nodeTransition.transitionToLocation(
        run.id, currentNode.nodeIndex, turnNo + 1, locationId,
        updatedRunState.worldState!, updatedRunState,
      );

      // 전환 턴 생성
      transition.enterResult.turnNo = turnNo + 1;
      await this.db.insert(turns).values({
        runId: run.id,
        turnNo: turnNo + 1,
        nodeInstanceId: transition.enterResult.node.id,
        nodeType: transition.nextNodeType,
        inputType: 'SYSTEM',
        rawInput: '',
        idempotencyKey: `${run.id}_enter_${transition.nextNodeIndex}`,
        parsedBy: null, confidence: null, parsedIntent: null,
        policyResult: 'ALLOW', transformedIntent: null, actionPlan: null,
        serverResult: transition.enterResult,
        llmStatus: 'PENDING',
      });

      await this.db.update(runSessions).set({
        currentTurnNo: turnNo + 1,
        runState: updatedRunState,
        updatedAt: new Date(),
      }).where(eq(runSessions.id, run.id));

      return {
        accepted: true, turnNo, serverResult: hubResult,
        llm: { status: 'PENDING' as LlmStatus, narrative: null },
        meta: { nodeOutcome: 'NODE_ENDED', policyResult: 'ALLOW' },
        transition: {
          nextNodeIndex: transition.nextNodeIndex,
          nextNodeType: transition.nextNodeType,
          enterResult: transition.enterResult,
          battleState: null,
          enterTurnNo: turnNo + 1,
        },
      };
    }

    // Heat 해결: CONTACT_ALLY
    if (choiceId === 'contact_ally') {
      const relations = runState.npcRelations ?? {};
      // 최고 관계 NPC 자동 선택
      const bestNpc = Object.entries(relations).sort(([,a], [,b]) => b - a)[0];
      if (bestNpc) {
        const { ws: newWs, reduction } = this.heatService.resolveByAlly(ws, bestNpc[0], relations);
        updatedRunState.worldState = this.worldStateService.updateHubSafety(newWs);
      }
      const hubChoices = this.sceneShellService.buildHubChoices(updatedRunState.worldState!, arcState);
      const result = this.buildHubActionResult(turnNo, currentNode, '협력자에게 연락하여 열기를 식혔다.', hubChoices, updatedRunState.worldState!);

      await this.commitTurnRecord(run, currentNode, turnNo, body, choiceId, result, updatedRunState, body.options?.skipLlm);
      return { accepted: true, turnNo, serverResult: result, llm: { status: 'PENDING' as LlmStatus, narrative: null }, meta: { nodeOutcome: 'ONGOING', policyResult: 'ALLOW' } };
    }

    // Heat 해결: PAY_COST
    if (choiceId === 'pay_cost') {
      const usageCount = 0; // TODO: track usage
      const { cost, ws: newWs } = this.heatService.resolveByCost(ws, usageCount);
      if (runState.gold >= cost) {
        updatedRunState.gold -= cost;
        updatedRunState.worldState = this.worldStateService.updateHubSafety(newWs);
      }
      const hubChoices = this.sceneShellService.buildHubChoices(updatedRunState.worldState!, arcState);
      const result = this.buildHubActionResult(turnNo, currentNode, `금화 ${cost}으로 열기를 해소했다.`, hubChoices, updatedRunState.worldState!);

      await this.commitTurnRecord(run, currentNode, turnNo, body, choiceId, result, updatedRunState, body.options?.skipLlm);
      return { accepted: true, turnNo, serverResult: result, llm: { status: 'PENDING' as LlmStatus, narrative: null }, meta: { nodeOutcome: 'ONGOING', policyResult: 'ALLOW' } };
    }

    // 프롤로그 의뢰 수락
    if (choiceId === 'accept_quest') {
      const hubChoices = this.sceneShellService.buildHubChoices(ws, arcState);
      const result: ServerResultV1 = {
        ...this.buildSystemResult(turnNo, currentNode, '의뢰를 수락했다.'),
        summary: {
          short: [
            '[상황] 당신은 로넨의 의뢰를 수락했다. 사라진 공물 장부를 찾기로 했다.',
            '[NPC] 서기관 로넨 — 항만 노동 길드 말단 서기관. ⚠️ 말투: "~하오", "~이오", "~소"체. 예: "고맙소", "잊지 않겠소". 현대 존댓말("~합니다", "~입니다", "~세요") 절대 금지.',
            '[서술 지시] 150~300자. 의뢰 수락 장면을 서술하세요.',
            '- 당신이 수락의 의사를 행동(고개 끄덕임, 잔을 내려놓음, 몸을 일으킴 등)으로 표현하는 장면을 묘사하세요.',
            '- 로넨이 안도하며 짧게 감사를 표한다. 반드시 "~소"체로 말한다. 예: "고맙소", "은혜를 잊지 않겠소".',
            '- 선술집을 나서며 밤의 그레이마르 거리를 바라보는 것으로 마무리하세요. 어디로 갈지는 언급하지 마세요.',
            '- 당신의 내면("결심한다", "다짐한다")을 쓰지 마세요. 행동만 묘사하세요.',
          ].join('\n'),
          display: '당신은 고개를 끄덕이며 의뢰를 수락했다. 서기관 로넨이 안도의 한숨을 내쉬었다. "고맙소… 은혜를 잊지 않겠소." 당신은 선술집을 나서 밤의 그레이마르 거리를 바라보았다.',
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
            locationDynamicStates: ws.locationDynamicStates ?? {},
            playerGoals: (ws.playerGoals ?? []).filter((g) => !g.completed),
            reputation: ws.reputation ?? {},
          },
        },
        choices: hubChoices,
      };

      await this.commitTurnRecord(run, currentNode, turnNo, body, choiceId, result, updatedRunState);
      return { accepted: true, turnNo, serverResult: result, llm: { status: 'PENDING' as LlmStatus, narrative: null }, meta: { nodeOutcome: 'ONGOING', policyResult: 'ALLOW' } };
    }

    throw new InvalidInputError(`Unknown HUB choice: ${choiceId}`);
  }

  // --- LOCATION 턴 ---
  private async handleLocationTurn(
    run: any,
    currentNode: any,
    turnNo: number,
    body: SubmitTurnBody,
    runState: RunState,
    playerStats: PermanentStats,
  ) {
    // HP≤0 방어: 전투 패배 등으로 HP가 0 이하인 상태에서 행동 방지
    if (runState.hp <= 0) {
      // 패배 엔딩 생성
      const result = this.buildSystemResult(turnNo, currentNode, '더 이상 버틸 수 없다...');
      try {
        const ws = runState.worldState ?? this.worldStateService.initWorldState();
        const endingThreads = (ws.playerThreads ?? []).map((t) => ({
          approachVector: t.approachVector,
          goalCategory: t.goalCategory,
          actionCount: t.actionCount,
          successCount: t.successCount,
          status: t.status,
        }));
        const endingInput = this.endingGenerator.gatherEndingInputs(
          ws.activeIncidents ?? [],
          (runState.npcStates ?? {}) as Record<string, NPCState>,
          ws.narrativeMarks ?? [],
          ws as unknown as Record<string, unknown>,
          runState.arcState ?? null,
          runState.actionHistory ?? [],
          endingThreads,
        );
        const endingResult = this.endingGenerator.generateEnding(endingInput, 'DEFEAT', turnNo);
        result.events.push({
          id: `ending_${turnNo}`,
          kind: 'SYSTEM',
          text: `[엔딩] ${endingResult.closingLine}`,
          tags: ['RUN_ENDED'],
          data: { endingResult },
        });
      } catch (e) {
        this.logger.warn(`HP≤0 DEFEAT ending generation failed: ${e}`);
      }

      await this.db.update(runSessions)
        .set({ status: 'RUN_ENDED', updatedAt: new Date() })
        .where(eq(runSessions.id, run.id));

      // Campaign: 시나리오 결과 저장
      await this.saveCampaignResultIfNeeded(run.id);

      await this.commitTurnRecord(run, currentNode, turnNo, body, '', result, runState);

      return {
        turnNo,
        result,
        meta: { nodeOutcome: 'RUN_ENDED' },
      };
    }

    let ws = runState.worldState ?? this.worldStateService.initWorldState();
    const arcState = runState.arcState ?? this.arcService.initArcState();
    let agenda = runState.agenda ?? this.agendaService.initAgenda();
    const cooldowns = runState.eventCooldowns ?? {};
    const locationId = ws.currentLocationId ?? (currentNode.nodeMeta as any)?.locationId ?? 'LOC_MARKET';
    const updatedRunState: RunState = { ...runState };

    // go_hub 선택 시 → HUB 복귀
    if (body.input.type === 'CHOICE' && body.input.choiceId === 'go_hub') {
      // Structured Memory v2: 방문 종료 통합 (기존 saveLocationVisitSummary 역할 포함)
      const locMemUpdate = await this.memoryIntegration.finalizeVisit(run.id, currentNode.id, runState, turnNo);
      if (locMemUpdate) updatedRunState.locationMemories = locMemUpdate;

      ws = this.worldStateService.returnToHub(ws);
      updatedRunState.worldState = ws;
      updatedRunState.actionHistory = []; // HUB 복귀 시 고집 이력 초기화

      await this.db.update(nodeInstances)
        .set({ status: 'NODE_ENDED', updatedAt: new Date() })
        .where(eq(nodeInstances.id, currentNode.id));

      const result = this.buildSystemResult(turnNo, currentNode, '잠긴 닻 선술집으로 발걸음을 돌린다.');
      await this.commitTurnRecord(run, currentNode, turnNo, body, body.input.choiceId!, result, updatedRunState, body.options?.skipLlm);

      const transition = await this.nodeTransition.transitionToHub(
        run.id, currentNode.nodeIndex, turnNo + 1, ws, arcState,
      );
      transition.enterResult.turnNo = turnNo + 1;
      await this.db.insert(turns).values({
        runId: run.id, turnNo: turnNo + 1, nodeInstanceId: transition.enterResult.node.id,
        nodeType: 'HUB', inputType: 'SYSTEM', rawInput: '',
        idempotencyKey: `${run.id}_hub_${turnNo + 1}`,
        parsedBy: null, confidence: null, parsedIntent: null,
        policyResult: 'ALLOW', transformedIntent: null, actionPlan: null,
        serverResult: transition.enterResult, llmStatus: 'PENDING',
      });
      await this.db.update(runSessions).set({ currentTurnNo: turnNo + 1, runState: updatedRunState, updatedAt: new Date() }).where(eq(runSessions.id, run.id));

      return {
        accepted: true, turnNo, serverResult: result,
        llm: { status: 'PENDING' as LlmStatus, narrative: null },
        meta: { nodeOutcome: 'NODE_ENDED', policyResult: 'ALLOW' },
        transition: { nextNodeIndex: transition.nextNodeIndex, nextNodeType: 'HUB', enterResult: transition.enterResult, battleState: null, enterTurnNo: turnNo + 1 },
      };
    }

    // ACTION/CHOICE → IntentParserV2 파싱
    let rawInput = body.input.text ?? body.input.choiceId ?? '';
    const source = body.input.type === 'CHOICE' ? 'CHOICE' as const : 'RULE' as const;
    let choicePayload: Record<string, unknown> | undefined;

    if (body.input.type === 'CHOICE' && body.input.choiceId) {
      const prevTurn = await this.db.query.turns.findFirst({
        where: and(eq(turns.runId, run.id), eq(turns.turnNo, run.currentTurnNo)),
        columns: { serverResult: true, llmChoices: true },
      });
      // 서버 생성 선택지에서 먼저 탐색
      const prevChoices = (prevTurn?.serverResult as ServerResultV1 | null)?.choices;
      let matched = prevChoices?.find((c) => c.id === body.input.choiceId);
      // 못 찾으면 LLM 생성 선택지에서 탐색
      if (!matched && prevTurn?.llmChoices) {
        const llmChoices = prevTurn.llmChoices as import('../db/types/index.js').ChoiceItem[];
        matched = llmChoices.find((c) => c.id === body.input.choiceId);
      }
      if (matched) {
        rawInput = matched.label;
        choicePayload = matched.action.payload;
      }
    }

    // 고집(insistence) 카운트 계산: 같은 actionType 연속 반복 횟수
    const actionHistory = runState.actionHistory ?? [];
    const { count: insistenceCount, repeatedType } = this.calculateInsistenceCount(actionHistory);
    const intent = await this.llmIntentParser.parseWithInsistence(rawInput, source, choicePayload, insistenceCount, repeatedType, locationId);
    const _sec = intent.secondaryActionType ? `+${intent.secondaryActionType}` : '';
    this.logger.log(
      `[Intent] "${rawInput.slice(0, 30)}" → ${intent.actionType}${_sec} (source=${intent.source}, tone=${intent.tone}, conf=${intent.confidence})`,
    );

    // V3 Intent 확장 (유저 주도형 시스템)
    const intentV3 = this.intentV3Builder.build(intent, rawInput, locationId, choicePayload);
    this.logger.debug(
      `[IntentV3] goal=${intentV3.goalCategory}, vector=${intentV3.approachVector}, goalText="${intentV3.goalText}"`,
    );

    // Phase 4a: EQUIP/UNEQUIP — 장비 착용/해제 (주사위 판정 없음, 즉시 처리)
    if ((intent.actionType === 'EQUIP' || intent.actionType === 'UNEQUIP') && (body.input.type === 'ACTION' || body.input.type === 'CHOICE')) {
      return this.handleEquipAction(run, currentNode, turnNo, body, rawInput, updatedRunState, intent);
    }

    // MOVE_LOCATION: 자유 텍스트로 다른 LOCATION 이동 요청 시 실제 전환
    if (intent.actionType === 'MOVE_LOCATION' && (body.input.type === 'ACTION' || body.input.type === 'CHOICE')) {
      const targetLocationId = this.extractTargetLocation(rawInput, locationId);
      if (targetLocationId && targetLocationId !== locationId) {
        return this.performLocationTransition(
          run, currentNode, turnNo, body, rawInput, runState, ws, arcState, locationId, targetLocationId,
        );
      }
      // Fixplan3-P4: 목표 장소 불명확 시 HUB 복귀 (go_hub와 동일 처리)
      const locMemFallback = await this.memoryIntegration.finalizeVisit(run.id, currentNode.id, runState, turnNo);
      const hubWs = this.worldStateService.returnToHub(ws);
      const hubRunState: RunState = { ...runState, worldState: hubWs, actionHistory: [], ...(locMemFallback ? { locationMemories: locMemFallback } : {}) };

      await this.db.update(nodeInstances)
        .set({ status: 'NODE_ENDED', updatedAt: new Date() })
        .where(eq(nodeInstances.id, currentNode.id));

      const moveResult = this.buildSystemResult(turnNo, currentNode, '잠긴 닻 선술집으로 돌아가기로 한다.');
      await this.commitTurnRecord(run, currentNode, turnNo, body, rawInput, moveResult, hubRunState, body.options?.skipLlm);

      const transition = await this.nodeTransition.transitionToHub(
        run.id, currentNode.nodeIndex, turnNo + 1, hubWs, arcState,
      );
      transition.enterResult.turnNo = turnNo + 1;
      await this.db.insert(turns).values({
        runId: run.id, turnNo: turnNo + 1, nodeInstanceId: transition.enterResult.node.id,
        nodeType: 'HUB', inputType: 'SYSTEM', rawInput: '',
        idempotencyKey: `${run.id}_hub_${turnNo + 1}`,
        parsedBy: null, confidence: null, parsedIntent: null,
        policyResult: 'ALLOW', transformedIntent: null, actionPlan: null,
        serverResult: transition.enterResult, llmStatus: 'PENDING',
      });
      await this.db.update(runSessions).set({ currentTurnNo: turnNo + 1, runState: hubRunState, updatedAt: new Date() }).where(eq(runSessions.id, run.id));

      return {
        accepted: true, turnNo, serverResult: moveResult,
        llm: { status: 'PENDING' as LlmStatus, narrative: null },
        meta: { nodeOutcome: 'NODE_ENDED', policyResult: 'ALLOW' },
        transition: { nextNodeIndex: transition.nextNodeIndex, nextNodeType: 'HUB', enterResult: transition.enterResult, battleState: null, enterTurnNo: turnNo + 1 },
      };
    }

    // 이벤트 연속성: 의도 기반 씬 연속성 판단 (3단계)
    const sourceEventId = choicePayload?.sourceEventId as string | undefined;
    const rng = this.rngService.create(run.seed, turnNo);
    let matchedEvent: import('../db/types/event-def.js').EventDefV2 | null = null;

    // Step 1: CHOICE의 sourceEventId → 명시적 씬 유지 (플레이어의 선택)
    //   제한: 같은 이벤트가 CHOICE로 연속되면 전환 (기본 2턴, 대화 계열 4턴까지 허용)
    if (sourceEventId) {
      let choiceConsecutive = 0;
      for (let i = actionHistory.length - 1; i >= 0; i--) {
        if (actionHistory[i].eventId === sourceEventId) {
          choiceConsecutive++;
        } else {
          break;
        }
      }
      // 대화 계열 선택지(TALK, PERSUADE 등)는 최대 4턴 연속 허용
      const choiceMaxConsecutive = 4;
      if (choiceConsecutive < choiceMaxConsecutive) {
        matchedEvent = this.content.getEventById(sourceEventId) ?? null;
      }
    }

    // Step 2: ACTION(자유 텍스트) → 현재 씬 유지 (대화 잠금 + 기본 연속성)
    //   예외: MOVE_LOCATION 의도, FALLBACK 이벤트(placeholder라 유지 의미 없음)
    //   대화 계열 행동(TALK, PERSUADE, BRIBE, THREATEN, HELP): 최대 4턴 연속 허용 (깊은 대화)
    //   비대화 행동: 기존대로 1턴만 연속 허용
    const SOCIAL_ACTIONS = new Set(['TALK', 'PERSUADE', 'BRIBE', 'THREATEN', 'HELP']);
    const isSocialAction = SOCIAL_ACTIONS.has(intent.actionType);
    if (!matchedEvent && body.input.type === 'ACTION' && intent.actionType !== 'MOVE_LOCATION') {
      const lastEntry = actionHistory[actionHistory.length - 1];
      if (lastEntry?.eventId) {
        const lastEvent = this.content.getEventById(lastEntry.eventId);
        if (lastEvent && lastEvent.eventType !== 'FALLBACK') {
          // 같은 이벤트 연속 사용 횟수 계산
          let consecutiveCount = 0;
          for (let i = actionHistory.length - 1; i >= 0; i--) {
            if (actionHistory[i].eventId === lastEntry.eventId) {
              consecutiveCount++;
            } else {
              break;
            }
          }
          // 대화 잠금: 대화 계열 행동이면 최대 4턴 연속 유지 (NPC와 깊은 대화 가능)
          // 비대화 행동: 기존대로 1턴만 연속 (Fixplan3-P5)
          const maxConsecutive = isSocialAction ? 4 : 1;
          if (consecutiveCount <= maxConsecutive) {
            matchedEvent = lastEvent;
          }
        }
      }
    }

    // Step 3: 새 이벤트 매칭 (전환 CHOICE, 첫 턴, FALLBACK 탈출, MOVE_LOCATION)
    // IncidentRouter: intentV3 기반으로 관련 incident 라우팅
    const incidentDefsForRouting = this.content.getIncidentsData() as IncidentDef[];
    const routingResult = this.incidentRouter.route(ws, locationId, intentV3, incidentDefsForRouting);
    if (routingResult.routeMode !== 'FALLBACK_SCENE') {
      this.logger.debug(
        `[IncidentRouter] mode=${routingResult.routeMode}, incident=${routingResult.incident?.incidentId}, score=${routingResult.matchScore}, vector=${routingResult.matchedVector}`,
      );
    }

    if (!matchedEvent) {
      const allEvents = this.content.getAllEventsV2();
      const recentEventIds = actionHistory
        .filter((h) => h.eventId)
        .map((h) => h.eventId!);

      // Living World v2: SituationGenerator 우선 시도 (에러 시 기존 EventMatcher fallback)
      // 동적 이벤트 발동: 직전 이벤트가 동적이면 건너뜀 + 고정이어도 50% 확률로만 시도
      const lastEventId = recentEventIds[recentEventIds.length - 1] ?? '';
      const lastWasDynamic = lastEventId.startsWith('SIT_') || lastEventId.startsWith('PROC_');
      const dynamicRoll = rng.range(0, 100);
      if (this.situationGenerator && !lastWasDynamic && dynamicRoll < 50) {
        try {
          const incidentDefs = this.content.getIncidentsData() as IncidentDef[];
          const recentPrimaryNpcIds = actionHistory
            .filter((h) => (h as Record<string, unknown>).primaryNpcId)
            .map((h) => (h as Record<string, unknown>).primaryNpcId as string);
          const situation = this.situationGenerator.generate(ws, locationId, intent, allEvents, incidentDefs, recentPrimaryNpcIds);
          if (situation) {
            matchedEvent = situation.eventDef;
            this.logger.debug(`[SituationGenerator] trigger=${situation.trigger} event=${matchedEvent.eventId} npc=${situation.primaryNpcId ?? '-'} facts=${situation.relatedFacts.length}`);
            // CONSEQUENCE 반복 방지: 사용된 fact ID를 worldState에 기록
            if (situation.trigger === 'CONSEQUENCE' && situation.relatedFacts.length > 0) {
              const usedFacts = (ws as any)._consequenceUsedFacts ?? [];
              (ws as any)._consequenceUsedFacts = [...usedFacts, ...situation.relatedFacts];
            }
          }
        } catch (err) {
          this.logger.warn(`[SituationGenerator] error, falling back to EventMatcher: ${err}`);
        }
      }

      // Living World v2: SituationGenerator가 이벤트를 잡았으면 기존 매칭 건너뜀
      if (!matchedEvent) {
        // NPC 연속성 컨텍스트 구축 (Phase 1: Context Coherence)
        // 비대화 행동(SNEAK/STEAL/FIGHT)일 때는 이전 NPC 연속성을 끊어 자연스럽게 전환
        const NON_SOCIAL_BREAK = new Set(['SNEAK', 'STEAL', 'FIGHT']);
        const shouldBreakNpc = NON_SOCIAL_BREAK.has(intent.actionType);
        const lastEntry = actionHistory[actionHistory.length - 1] as Record<string, unknown> | undefined;
        const sessionNpcContext = {
          lastPrimaryNpcId: shouldBreakNpc ? null : ((lastEntry?.primaryNpcId as string) ?? null),
          sessionTurnCount: actionHistory.length,
          interactedNpcIds: [...new Set(
            (actionHistory as Array<Record<string, unknown>>)
              .filter(a => a.primaryNpcId)
              .map(a => a.primaryNpcId as string),
          )],
        };

        // PR5: EventDirector로 교체 (기존 EventMatcher를 내부적으로 위임)
        const directorResult = this.eventDirector.select(
          allEvents, locationId, intent, ws, arcState, agenda, cooldowns, turnNo, rng, recentEventIds, routingResult, sessionNpcContext, intentV3,
        );
        matchedEvent = directorResult.selectedEvent;

        if (directorResult.filterLog.length > 0) {
          this.logger.debug(`[EventDirector] ${directorResult.filterLog.join(', ')}`);
        }
      }

      // PR7: 고정 이벤트 실패 또는 FALLBACK → 절차적 이벤트 시도
      if (!matchedEvent || matchedEvent.eventType === 'FALLBACK') {
        const proceduralHistory = (ws.proceduralHistory ?? []) as ProceduralHistoryEntry[];
        const proceduralResult = this.proceduralEvent.generate(
          { locationId, timePhase: ws.phaseV2 ?? ws.timePhase, stage: ws.mainArc?.stage != null ? String(ws.mainArc.stage) : undefined },
          proceduralHistory,
          turnNo,
          rng,
        );
        if (proceduralResult) {
          matchedEvent = proceduralResult;
          this.logger.debug(`[ProceduralEvent] 생성: ${proceduralResult.eventId}`);
        }
      }

    }

    if (!matchedEvent) {
      // fallback 결과
      const selectedChoiceIds = actionHistory
        .filter((h) => h.choiceId)
        .map((h) => h.choiceId!);
      let choices = this.sceneShellService.buildLocationChoices(locationId, undefined, undefined, selectedChoiceIds);
      // 안전장치: 새 장소 등에서 선택지가 비어있으면 generic choices 생성
      if (!choices || choices.length === 0) {
        this.logger.warn(`[Fallback] buildLocationChoices returned empty for ${locationId}, using generic`);
        choices = [
          { id: 'generic_observe', label: '주변을 살펴본다', action: { type: 'CHOICE' as const, payload: {} } },
          { id: 'generic_talk', label: '주변 사람에게 말을 건다', action: { type: 'CHOICE' as const, payload: {} } },
          { id: 'go_hub', label: "'잠긴 닻' 선술집으로 돌아간다", action: { type: 'CHOICE' as const, payload: {} } },
        ];
      }
      const result = this.buildLocationResult(turnNo, currentNode, '특별한 일이 일어나지 않았다.', 'PARTIAL', choices, ws);
      await this.commitTurnRecord(run, currentNode, turnNo, body, rawInput, result, updatedRunState, body.options?.skipLlm);
      return { accepted: true, turnNo, serverResult: result, llm: { status: 'PENDING' as LlmStatus, narrative: null }, meta: { nodeOutcome: 'ONGOING', policyResult: 'ALLOW' } };
    }

    // Notification + WorldDelta: 변경 전 상태 스냅샷
    const prevHeat = ws.hubHeat;
    const prevSafety = ws.hubSafety;
    const prevIncidents = [...(ws.activeIncidents ?? [])];
    const priorWsSnapshot = { ...ws, activeIncidents: [...(ws.activeIncidents ?? [])] };

    // Phase 4c: 세트 specialEffect 수집
    const activeSpecialEffects = this.equipmentService.getActiveSpecialEffects(runState.equipped ?? {});

    // 프리셋별 판정 보너스 조회
    const presetDef = run.presetId ? this.content.getPreset(run.presetId) : undefined;
    const presetActionBonuses = presetDef?.actionBonuses;

    // NPC faction 조회 (평판 변동용)
    const primaryNpcIdForResolve = (matchedEvent.payload as Record<string, unknown>)?.primaryNpcId as string | undefined;
    const primaryNpcFaction = primaryNpcIdForResolve ? this.content.getNpc(primaryNpcIdForResolve)?.faction ?? null : null;

    // ResolveService 판정
    const resolveResult = this.resolveService.resolve(matchedEvent, intent, ws, playerStats, rng, activeSpecialEffects, presetActionBonuses, primaryNpcFaction);
    this.logger.log(
      `[Resolve] ${resolveResult.outcome} (score=${resolveResult.score}) event=${matchedEvent.eventId} heat=${resolveResult.heatDelta}${presetActionBonuses?.[intent.actionType] ? ` presetBonus=+${presetActionBonuses[intent.actionType]}` : ''}`,
    );

    // Living World v2: 판정 결과 → WorldFact 생성 + LocationState 변경 + NPC 목격
    if (this.consequenceProcessor) {
      try {
        const consequenceOutput = this.consequenceProcessor.process(ws, {
          resolveResult,
          intent,
          event: matchedEvent,
          locationId,
          turnNo,
          day: ws.day,
          primaryNpcId: matchedEvent.payload.primaryNpcId,
        });
        if (consequenceOutput.factsCreated.length > 0) {
          this.logger.debug(`[ConsequenceProcessor] facts=${consequenceOutput.factsCreated.length} locEffects=${consequenceOutput.locationEffects.length} witnesses=${consequenceOutput.npcWitnesses.length}`);
        }
      } catch (err) {
        this.logger.warn(`[ConsequenceProcessor] error (non-fatal): ${err}`);
      }
    }

    // Living World v2: PlayerGoal 진행도 체크 + 암시적 목표 감지
    if (this.playerGoalService) {
      try {
        const milestoneResults = this.playerGoalService.checkMilestones(ws);
        if (milestoneResults.length > 0) {
          this.logger.debug(`[PlayerGoal] milestones: ${milestoneResults.length} advanced`);
        }

        if (turnNo % 5 === 0 && actionHistory.length >= 3) {
          const actionCounts = new Map<string, number>();
          for (const h of actionHistory) {
            const at = (h as Record<string, unknown>).actionType as string;
            if (at) actionCounts.set(at, (actionCounts.get(at) ?? 0) + 1);
          }
          const patterns = [...actionCounts.entries()]
            .filter(([, count]) => count >= 3)
            .map(([action, count]) => ({
              pattern: action.toLowerCase(),
              count,
              relatedLocations: [locationId],
            }));
          if (patterns.length > 0) {
            this.playerGoalService.detectImplicitGoals(ws, patterns, turnNo, ws.day);
          }
        }
      } catch (err) {
        this.logger.warn(`[PlayerGoal] error (non-fatal): ${err}`);
      }
    }

    // 전투 트리거?
    if (resolveResult.triggerCombat && resolveResult.combatEncounterId) {
      // LOCATION 노드 유지, COMBAT 서브노드 삽입
      ws = this.heatService.applyHeatDelta(ws, resolveResult.heatDelta);
      ws = this.worldStateService.advanceTime(ws);
      ws = this.worldStateService.updateHubSafety(ws);
      ws = { ...ws, combatWindowCount: ws.combatWindowCount + 1 };
      updatedRunState.worldState = ws;

      const combatSceneFrame = resolveNpcPlaceholders(
        matchedEvent.payload.sceneFrame,
        runState.npcStates ?? {},
        (id) => this.content.getNpc(id),
      );
      const preResult = this.buildLocationResult(
        turnNo, currentNode,
        `${combatSceneFrame} — 전투가 시작된다!`,
        resolveResult.outcome, [], ws,
      );
      await this.commitTurnRecord(run, currentNode, turnNo, body, rawInput, preResult, updatedRunState, body.options?.skipLlm);

      const transition = await this.nodeTransition.insertCombatSubNode(
        run.id, currentNode.id, currentNode.nodeIndex, turnNo + 1,
        resolveResult.combatEncounterId, currentNode.environmentTags ?? [],
        run.seed, updatedRunState.hp, updatedRunState.stamina,
      );
      transition.enterResult.turnNo = turnNo + 1;

      // 전투 진입 summary에 트리거 행동 컨텍스트 추가 (LLM 내러티브 연속성)
      const triggerContext = `플레이어가 "${rawInput}"${korParticle(rawInput, '을', '를')} 시도했으나 실패하여 전투가 발생했다.`;
      transition.enterResult.summary = {
        short: `${triggerContext} ${transition.enterResult.summary.short}`,
        display: transition.enterResult.summary.display,
      };
      await this.db.insert(turns).values({
        runId: run.id, turnNo: turnNo + 1, nodeInstanceId: transition.enterResult.node.id,
        nodeType: 'COMBAT', inputType: 'SYSTEM', rawInput: '',
        idempotencyKey: `${run.id}_combat_${turnNo + 1}`,
        parsedBy: null, confidence: null, parsedIntent: null,
        policyResult: 'ALLOW', transformedIntent: null, actionPlan: null,
        serverResult: transition.enterResult, llmStatus: 'PENDING',
      });
      await this.db.update(runSessions).set({ currentTurnNo: turnNo + 1, runState: updatedRunState, updatedAt: new Date() }).where(eq(runSessions.id, run.id));

      return {
        accepted: true, turnNo, serverResult: preResult,
        llm: { status: 'PENDING' as LlmStatus, narrative: null },
        meta: { nodeOutcome: 'ONGOING', policyResult: 'ALLOW' },
        transition: { nextNodeIndex: transition.nextNodeIndex, nextNodeType: 'COMBAT', enterResult: transition.enterResult, battleState: transition.battleState ?? null, enterTurnNo: turnNo + 1 },
      };
    }

    // 비전투 → WorldState 업데이트
    ws = this.heatService.applyHeatDelta(ws, resolveResult.heatDelta);
    ws = { ...ws, tension: Math.max(0, Math.min(10, ws.tension + resolveResult.tensionDelta)) };
    // relation 변경
    const relations = { ...(runState.npcRelations ?? {}) };
    for (const [npcId, delta] of Object.entries(resolveResult.relationChanges)) {
      relations[npcId] = Math.max(0, Math.min(100, (relations[npcId] ?? 50) + delta));
    }
    // reputation 변동 반영
    for (const [factionId, delta] of Object.entries(resolveResult.reputationChanges)) {
      if (delta !== 0) {
        ws = {
          ...ws,
          reputation: {
            ...ws.reputation,
            [factionId]: (ws.reputation[factionId] ?? 0) + delta,
          },
        };
      }
    }
    // flags 설정
    for (const flag of resolveResult.flagsSet) {
      ws = { ...ws, flags: { ...ws.flags, [flag]: true } };
    }
    // deferred effects 추가
    for (const de of resolveResult.deferredEffects) {
      ws = {
        ...ws,
        deferredEffects: [...ws.deferredEffects, { ...de, sourceTurnNo: turnNo }],
      };
    }

    // === Narrative Engine v1: preStepTick (시간 사이클 + Incident tick + signal) ===
    const incidentDefs = this.content.getIncidentsData() as IncidentDef[];
    ws = this.worldStateService.migrateWorldState(ws);
    const { ws: wsAfterTick, resolvedPatches } = this.worldTick.preStepTick(ws, incidentDefs, rng, 1);
    ws = wsAfterTick;

    // === Narrative Engine v1: Incident impact 적용 ===
    const relevantIncident = this.incidentMgmt.findRelevantIncident(
      ws, locationId, intent.actionType, incidentDefs, intent.secondaryActionType,
    );
    if (relevantIncident) {
      const updatedIncident = this.incidentMgmt.applyImpact(
        relevantIncident.incident, relevantIncident.def, resolveResult.outcome, ws.globalClock,
      );
      ws = {
        ...ws,
        activeIncidents: ws.activeIncidents.map((i) =>
          i.incidentId === updatedIncident.incidentId ? updatedIncident : i,
        ),
      };
    }

    // === User-Driven System v3: IncidentResolutionBridge (확장 필드 세밀 조정) ===
    ws = this.incidentBridge.apply(ws, resolveResult.outcome, routingResult);

    // === Phase 2: IncidentMemory 축적 (사건별 개인 기록) ===
    if (routingResult.routeMode !== 'FALLBACK_SCENE' && routingResult.incident) {
      const incId = routingResult.incident.incidentId;
      const incidentMemories = { ...(updatedRunState.incidentMemories ?? {}) };
      const existing = incidentMemories[incId] ?? {
        discoveredTurn: turnNo,
        playerInvolvements: [],
        knownClues: [],
        relatedNpcIds: [],
        playerStance: '방관',
      };

      // control/pressure 변동 계산
      const prevInc = prevIncidents.find((i) => i.incidentId === incId);
      const currInc = (ws.activeIncidents ?? []).find((i) => i.incidentId === incId);
      const controlDelta = (currInc?.control ?? 0) - (prevInc?.control ?? 0);
      const pressureDelta = (currInc?.pressure ?? 0) - (prevInc?.pressure ?? 0);

      // 행동 요약
      const actionLabel = `${this.actionTypeToKorean(intent.actionType)} (${resolveResult.outcome})`;
      const impactParts: string[] = [];
      if (controlDelta !== 0) impactParts.push(`control${controlDelta > 0 ? '+' : ''}${controlDelta}`);
      if (pressureDelta !== 0) impactParts.push(`pressure${pressureDelta > 0 ? '+' : ''}${pressureDelta}`);
      const impactStr = impactParts.length > 0 ? impactParts.join(', ') : 'no change';

      // playerInvolvements 추가 (최대 8개, 오래된 것 trim)
      const involvements = [
        ...existing.playerInvolvements,
        { turnNo, locationId, action: actionLabel, impact: impactStr },
      ].slice(-8);

      // knownClues: 이벤트 sceneFrame 앞 40자를 단서로 추가 (중복 제거, 최대 5개)
      const sceneFrame = matchedEvent?.payload?.sceneFrame;
      const clueFromEvent = sceneFrame ? sceneFrame.slice(0, 40) : (matchedEvent?.eventId ?? null);
      const clues = [...existing.knownClues];
      if (clueFromEvent && !clues.includes(clueFromEvent)) {
        clues.push(clueFromEvent);
      }
      const trimmedClues = clues.slice(-5);

      // relatedNpcIds: 이벤트의 primaryNpcId + incident def의 relatedNpcIds
      const relatedNpcs = new Set(existing.relatedNpcIds);
      const eventNpc = matchedEvent?.payload?.primaryNpcId;
      if (eventNpc) relatedNpcs.add(eventNpc);
      if (routingResult.def?.relatedNpcIds) {
        for (const nid of routingResult.def.relatedNpcIds) relatedNpcs.add(nid);
      }

      // playerStance: control 변동 기반 자동 판정
      const totalControlDelta = involvements.reduce((sum, inv) => {
        const match = inv.impact.match(/control([+-]\d+)/);
        return sum + (match ? parseInt(match[1], 10) : 0);
      }, 0);
      const totalPressureDelta = involvements.reduce((sum, inv) => {
        const match = inv.impact.match(/pressure([+-]\d+)/);
        return sum + (match ? parseInt(match[1], 10) : 0);
      }, 0);
      let playerStance = '방관';
      if (totalControlDelta > 0) playerStance = '적극 개입';
      else if (totalPressureDelta > 0) playerStance = '상황 악화';

      incidentMemories[incId] = {
        discoveredTurn: existing.discoveredTurn,
        playerInvolvements: involvements,
        knownClues: trimmedClues,
        relatedNpcIds: [...relatedNpcs],
        playerStance,
      };
      updatedRunState.incidentMemories = incidentMemories;
    }

    // === Narrative Engine v1: postStepTick (impact patches, safety, signal expire) ===
    ws = this.worldTick.postStepTick(ws, resolvedPatches);

    // diff용 장비 추가 수집기 (클라이언트 즉시 반영)
    const allEquipmentAdded: import('../db/types/equipment.js').ItemInstance[] = [];

    // === Phase 4d: Legendary Quest Rewards (Incident CONTAINED + commitment 조건) ===
    const prevContainedSet = new Set(
      prevIncidents.filter((i) => i.resolved && i.outcome === 'CONTAINED').map((i) => i.incidentId),
    );
    const newlyContainedIds = (ws.activeIncidents ?? [])
      .filter((i) => i.resolved && i.outcome === 'CONTAINED' && !prevContainedSet.has(i.incidentId))
      .map((i) => i.incidentId);
    const legendaryResult = this.legendaryRewardService.check(
      updatedRunState, ws.activeIncidents ?? [], newlyContainedIds,
    );
    if (legendaryResult.awarded.length > 0) {
      if (!updatedRunState.equipmentBag) updatedRunState.equipmentBag = [];
      for (const inst of legendaryResult.awarded) {
        updatedRunState.equipmentBag.push(inst);
        allEquipmentAdded.push(inst);
        // Phase 3: ItemMemory — 전설 보상 기록
        this.recordItemMemory(updatedRunState, inst, turnNo, '전설 보상', locationId);
      }
      updatedRunState.legendaryRewards = [
        ...(updatedRunState.legendaryRewards ?? []),
        ...legendaryResult.awarded.map((i) => i.baseItemId),
      ];
    }

    // === Narrative Engine v1: NPC Emotional 업데이트 ===
    const npcStates = { ...(runState.npcStates ?? {}) } as Record<string, NPCState>;
    const newlyIntroducedNpcIds: string[] = [];
    const newlyEncounteredNpcIds: string[] = [];
    // effectiveNpcId: matchedEvent.payload.primaryNpcId 우선, 없으면 npcInjection은 orchestration 이후 보충
    const eventPrimaryNpc = matchedEvent.payload.primaryNpcId ?? null;
    // 현재 location의 관련 NPC에게 감정 영향 적용
    if (eventPrimaryNpc) {
      const npcId = eventPrimaryNpc;
      if (!npcStates[npcId]) {
        const npcDef = this.content.getNpc(npcId);
        npcStates[npcId] = initNPCState({
          npcId,
          basePosture: npcDef?.basePosture,
          initialTrust: npcDef?.initialTrust ?? relations[npcId] ?? 0,
          agenda: npcDef?.agenda,
        });
        newlyEncounteredNpcIds.push(npcId);
      }

      // encounterCount 증가 — 이번 방문 내 첫 만남인 경우에만 (방문 단위 1회)
      const alreadyMetThisVisit = actionHistory.some((h) => h.primaryNpcId === npcId);
      if (!alreadyMetThisVisit) {
        npcStates[npcId].encounterCount = (npcStates[npcId].encounterCount ?? 0) + 1;
      }

      // 성격 기반 소개 판정 — base posture 기준 (감정 변화로 effective posture가 바뀌어도 소개 임계값은 고정)
      const introPosture = npcStates[npcId].posture;
      if (shouldIntroduce(npcStates[npcId], introPosture)) {
        npcStates[npcId].introduced = true;
        newlyIntroducedNpcIds.push(npcId);
      }

      const npc = npcStates[npcId];
      // 감정 변화 delta 계산을 위해 before 저장
      const emoBefore = npc.emotional ? { ...npc.emotional } : undefined;
      npc.emotional = this.npcEmotional.applyActionImpact(
        npc.emotional, intent.actionType, resolveResult.outcome, true,
      );
      npcStates[npcId] = this.npcEmotional.syncLegacyFields(npc);
      // delta 계산 및 runState에 저장 (LLM 컨텍스트 전달용)
      if (emoBefore && npc.emotional) {
        const delta: Record<string, number> = {};
        for (const axis of ['trust', 'fear', 'respect', 'suspicion', 'attachment'] as const) {
          const d = Math.round(((npc.emotional as any)[axis] ?? 0) - ((emoBefore as any)[axis] ?? 0));
          if (d !== 0) delta[axis] = d;
        }
        if (Object.keys(delta).length > 0) {
          (runState as any).lastNpcDelta = { npcId, delta, actionType: intent.actionType, outcome: resolveResult.outcome };
        }
      }

      // === NPC 개인 기록 축적 ===
      const briefNote = (matchedEvent.payload.sceneFrame ?? rawInput).slice(0, 50);
      npcStates[npcId] = recordNpcEncounter(
        npcStates[npcId], turnNo, locationId,
        intent.actionType, resolveResult.outcome, briefNote,
      );
      // knownFacts: 이벤트 결과에서 중요 발견사항 추출 (SUCCESS 판정 + 정보성 행동)
      if (resolveResult.outcome === 'SUCCESS' && ['INVESTIGATE', 'PERSUADE', 'TALK', 'TRADE', 'OBSERVE'].includes(intent.actionType)) {
        const factNote = matchedEvent.payload.sceneFrame
          ? matchedEvent.payload.sceneFrame.slice(0, 60)
          : undefined;
        if (factNote) {
          npcStates[npcId] = addNpcKnownFact(npcStates[npcId], factNote);
        }
      }
    }

    // Fixplan3-P2: eventPrimaryNpc가 null일 때 이벤트 태그에서 NPC 상태 초기화
    // 태그는 간접 참조이므로 encounterCount는 증가하지 않음 (직접 대면=primaryNpcId만 카운트)
    if (!eventPrimaryNpc && matchedEvent.payload.tags) {
      for (const tag of matchedEvent.payload.tags) {
        const tagNpcId = TAG_TO_NPC[tag];
        if (!tagNpcId) continue;
        if (!npcStates[tagNpcId]) {
          const npcDef = this.content.getNpc(tagNpcId);
          if (!npcDef) continue;
          npcStates[tagNpcId] = initNPCState({
            npcId: tagNpcId,
            basePosture: npcDef.basePosture,
            initialTrust: npcDef.initialTrust ?? relations[tagNpcId] ?? 0,
            agenda: npcDef.agenda,
          });
          newlyEncounteredNpcIds.push(tagNpcId);
        }
        // encounterCount는 증가하지 않음 — 태그는 간접 참조, 이름 공개는 직접 대면(primaryNpcId)에서만
      }
    }

    // === NPC 플레이스홀더 치환 (introduced 상태 반영) ===
    const npcResolve = (text: string) =>
      resolveNpcPlaceholders(text, npcStates, (id) => this.content.getNpc(id));
    const resolvedSceneFrame = npcResolve(matchedEvent.payload.sceneFrame);
    const resolvedChoices = matchedEvent.payload.choices?.map((c: any) => ({
      ...c,
      label: c.label ? npcResolve(c.label) : c.label,
      hint: c.hint ? npcResolve(c.hint) : c.hint,
    }));

    // === Narrative Engine v1: Narrative Marks 체크 ===
    const markConditions = this.content.getNarrativeMarkConditions();
    const npcEmotionals: Record<string, NpcEmotionalState> = {};
    for (const [npcId, npc] of Object.entries(npcStates)) {
      npcEmotionals[npcId] = npc.emotional;
    }
    const npcNames: Record<string, string> = {};
    for (const [npcId] of Object.entries(npcStates)) {
      const npcDef = this.content.getNpc(npcId);
      npcNames[npcId] = getNpcDisplayName(npcStates[npcId], npcDef);
    }
    // resolve outcome 횟수 집계
    const resolveOutcomeCounts: Record<string, number> = {};
    for (const h of actionHistory) {
      if (h.resolveOutcome) {
        resolveOutcomeCounts[h.resolveOutcome] = (resolveOutcomeCounts[h.resolveOutcome] ?? 0) + 1;
      }
    }
    // 현재 턴의 결과도 추가
    resolveOutcomeCounts[resolveResult.outcome] = (resolveOutcomeCounts[resolveResult.outcome] ?? 0) + 1;

    const newMarks = this.narrativeMarkService.checkAndApply(
      ws.narrativeMarks ?? [],
      markConditions as NarrativeMarkCondition[],
      { ws, npcEmotionals, npcNames, resolveOutcomes: resolveOutcomeCounts, clock: ws.globalClock },
    );
    if (newMarks.length > 0) {
      ws = { ...ws, narrativeMarks: [...(ws.narrativeMarks ?? []), ...newMarks] };
    }

    ws = this.worldStateService.advanceTime(ws);
    ws = this.worldStateService.updateHubSafety(ws);

    // Deferred 체크
    const { ws: wsAfterDeferred, triggered } = this.worldStateService.processDeferredEffects(ws, turnNo);
    ws = wsAfterDeferred;

    // Agenda 업데이트
    agenda = this.agendaService.updateFromResolve(agenda, resolveResult, matchedEvent);

    // Arc commitment 업데이트
    let newArcState = arcState;
    if (resolveResult.commitmentDelta > 0 && newArcState.currentRoute) {
      newArcState = this.arcService.progressCommitment(newArcState, resolveResult.commitmentDelta);
    }
    // Arc route tag로 route 설정
    if (matchedEvent.arcRouteTag && !newArcState.currentRoute) {
      const route = matchedEvent.arcRouteTag as any;
      if (this.arcService.canSwitchRoute(newArcState)) {
        newArcState = this.arcService.switchRoute(newArcState, route);
      }
    }

    // cooldown 업데이트
    const newCooldowns = { ...cooldowns, [matchedEvent.eventId]: turnNo };

    // 행동 이력 업데이트 (고집 시스템 + FALLBACK 페널티 + 선택지 중복 방지)
    const eventPrimaryNpcId = (matchedEvent.payload as Record<string, unknown>)?.primaryNpcId as string | undefined;
    const newHistory = [...actionHistory, {
      turnNo,
      actionType: intent.actionType,
      secondaryActionType: intent.secondaryActionType,
      suppressedActionType: intent.suppressedActionType,
      inputText: rawInput,
      eventId: matchedEvent.eventId,
      choiceId: body.input.type === 'CHOICE' ? body.input.choiceId : undefined,
      primaryNpcId: eventPrimaryNpcId ?? undefined,
      resolveOutcome: resolveResult.outcome,
    }].slice(-10); // 최대 10개 유지

    // LOCATION 보상 계산 (resolve 주사위 이후 같은 RNG로 수행)
    const locationReward = this.rewardsService.calculateLocationRewards({
      outcome: resolveResult.outcome,
      eventType: matchedEvent.eventType,
      actionType: intent.actionType,
      rng,
    });

    // 골드: BRIBE/TRADE 비용(음수) + 보상(양수) 합산
    const totalGoldDelta = resolveResult.goldDelta + locationReward.gold;
    if (totalGoldDelta !== 0) {
      updatedRunState.gold = Math.max(0, updatedRunState.gold + totalGoldDelta);
    }

    // 아이템 보상 반영 (인벤토리에 추가)
    for (const added of locationReward.items) {
      const existing = updatedRunState.inventory.find((i) => i.itemId === added.itemId);
      if (existing) existing.qty += added.qty;
      else updatedRunState.inventory.push({ itemId: added.itemId, qty: added.qty });
    }

    // Phase 4a: LOCATION 장비 드랍 (GOLD_ACTIONS + SUCCESS/PARTIAL)
    const locationEquipDropEvents: Array<{ id: string; kind: 'LOOT'; text: string; tags: string[]; data?: Record<string, unknown> }> = [];
    if (resolveResult.outcome !== 'FAIL') {
      const equipDrop = this.rewardsService.rollLocationEquipmentDrop(locationId, rng);
      if (equipDrop.droppedInstances.length > 0) {
        if (!updatedRunState.equipmentBag) updatedRunState.equipmentBag = [];
        for (const inst of equipDrop.droppedInstances) {
          updatedRunState.equipmentBag.push(inst);
          allEquipmentAdded.push(inst);
          // Phase 3: ItemMemory — LOCATION 드랍 기록
          this.recordItemMemory(updatedRunState, inst, turnNo, `${locationId} 탐색 드랍`, locationId);
          locationEquipDropEvents.push({
            id: `eq_drop_${inst.instanceId.slice(0, 8)}`,
            kind: 'LOOT' as const,
            text: `[장비] ${inst.displayName} 획득`,
            tags: ['LOOT', 'EQUIPMENT_DROP'],
            data: { baseItemId: inst.baseItemId, instanceId: inst.instanceId, displayName: inst.displayName } as Record<string, unknown>,
          });
        }
      }
    }

    // === Phase 4b: RegionEconomy — SHOP 액션 + priceIndex + 재고 갱신 ===
    const shopActionEvents: Array<{ id: string; kind: 'GOLD' | 'LOOT' | 'SYSTEM'; text: string; tags: string[] }> = [];
    if (this.shopService) {
      let economy: RegionEconomy = updatedRunState.regionEconomy ?? {
        priceIndex: 1.0,
        shopStocks: {},
      };

      // priceIndex 재계산: heat 기반 (heat 50 기준, ±25% 변동)
      const locState = ws.locationStates?.[locationId];
      const avgCrime = locState?.crime ?? 30;
      economy = {
        ...economy,
        priceIndex: this.shopService.calculatePriceIndex(ws.tension, avgCrime),
      };

      // 재고 갱신: 각 상점별 refreshInterval 체크
      const allShopDefs = this.content.getShopsByLocation(locationId);
      for (const shopDef of allShopDefs) {
        const currentStock = economy.shopStocks[shopDef.shopId];
        const refreshed = this.shopService.refreshStock(
          shopDef, currentStock, turnNo, run.seed,
        );
        if (refreshed !== currentStock) {
          economy = {
            ...economy,
            shopStocks: { ...economy.shopStocks, [shopDef.shopId]: refreshed },
          };
        }
      }

      // SHOP 액션 시 구매/판매 처리
      if (intent.actionType === 'SHOP' && intent.target) {
        const targetItemId = intent.target.toUpperCase().replace(/\s+/g, '_');
        // 현재 장소의 상점에서 아이템 찾기
        const locationShops = this.content.getShopsByLocation(locationId);
        let purchased = false;

        for (const shopDef of locationShops) {
          const stock = economy.shopStocks[shopDef.shopId];
          if (!stock) continue;

          // 아이템 ID 직접 매칭 또는 부분 매칭
          const matchedItem = stock.items.find((si) =>
            si.itemId === targetItemId ||
            si.itemId.includes(targetItemId) ||
            (this.content.getItem(si.itemId)?.name ?? '').includes(intent.target!)
          );

          if (matchedItem && matchedItem.qty > 0) {
            const { result: purchaseResult, updatedStock } = this.shopService.purchase(
              stock, matchedItem.itemId, updatedRunState.gold, economy.priceIndex,
            );

            if (purchaseResult.success) {
              // 골드 감소
              updatedRunState.gold = Math.max(0, updatedRunState.gold - purchaseResult.goldSpent);

              // 아이템 추가 (장비 vs 소비)
              const itemDef = this.content.getItem(matchedItem.itemId);
              if (itemDef?.type === 'EQUIPMENT') {
                if (!updatedRunState.equipmentBag) updatedRunState.equipmentBag = [];
                const instance = {
                  instanceId: `${matchedItem.itemId}_${turnNo}`,
                  baseItemId: matchedItem.itemId,
                  displayName: itemDef.name,
                  affixes: [],
                };
                updatedRunState.equipmentBag.push(instance);
                allEquipmentAdded.push(instance);
                // Phase 3: ItemMemory — 상점 구매 기록
                this.recordItemMemory(updatedRunState, instance, turnNo, '상점 구매', locationId);
                shopActionEvents.push({
                  id: `shop_buy_eq_${turnNo}`,
                  kind: 'LOOT',
                  text: `[상점] ${itemDef.name}${korParticle(itemDef.name, '을', '를')} ${purchaseResult.goldSpent}G에 구매했다.`,
                  tags: ['SHOP', 'BUY', 'EQUIPMENT'],
                });
              } else {
                const existing = updatedRunState.inventory.find((i) => i.itemId === matchedItem.itemId);
                if (existing) existing.qty += 1;
                else updatedRunState.inventory.push({ itemId: matchedItem.itemId, qty: 1 });
                shopActionEvents.push({
                  id: `shop_buy_${turnNo}`,
                  kind: 'GOLD',
                  text: `[상점] ${itemDef?.name ?? matchedItem.itemId}${korParticle(itemDef?.name ?? '', '을', '를')} ${purchaseResult.goldSpent}G에 구매했다.`,
                  tags: ['SHOP', 'BUY'],
                });
              }

              // 재고 업데이트
              economy = {
                ...economy,
                shopStocks: { ...economy.shopStocks, [shopDef.shopId]: updatedStock },
              };
              purchased = true;
              break;
            }
          }
        }

        if (!purchased) {
          shopActionEvents.push({
            id: `shop_fail_${turnNo}`,
            kind: 'SYSTEM',
            text: `[상점] 해당 물건을 구매할 수 없다.`,
            tags: ['SHOP', 'FAIL'],
          });
        }
      }

      updatedRunState.regionEconomy = economy;
    }

    // === User-Driven System v3: WorldDelta (세계 변화 기록) ===
    const { ws: wsWithDelta } = this.worldDeltaService.build(turnNo, priorWsSnapshot, ws);
    ws = wsWithDelta;

    // === User-Driven System v3: PlayerThread (반복 행동 패턴 추적) ===
    ws = this.playerThreadService.update(
      ws, turnNo, locationId, intentV3.approachVector, intentV3.goalCategory,
      resolveResult.outcome, routingResult,
    );

    // === Signal Feed: 행동 결과 기반 시그널 생성 ===
    const actionSignal = this.signalFeed.generateFromActionResult(
      intent.actionType, resolveResult.outcome, locationId, ws.globalClock,
      (matchedEvent?.payload as any)?.primaryNpcId ?? intent.target,
    );
    if (actionSignal) {
      ws = { ...ws, signalFeed: [...(ws.signalFeed ?? []), actionSignal] };
    }

    // RunState 반영
    updatedRunState.worldState = ws;
    updatedRunState.agenda = agenda;
    updatedRunState.arcState = newArcState;
    updatedRunState.npcRelations = relations;
    updatedRunState.eventCooldowns = newCooldowns;
    updatedRunState.actionHistory = newHistory;
    updatedRunState.npcStates = npcStates; // Narrative Engine v1
    // PBP 집계 (최근 행동 이력 기반)
    updatedRunState.pbp = computePBP(newHistory);

    // === Quest Progression: NPC knownFacts 기반 퀘스트 팩트 발견 + 단계 전환 ===
    if (this.questProgression) {
      try {
        // SUCCESS/PARTIAL + 정보성 행동 시 NPC knownFacts에서 quest FACT 발견 기록
        const INFO_ACTIONS = new Set(['INVESTIGATE', 'PERSUADE', 'TALK', 'TRADE', 'OBSERVE', 'SEARCH']);
        if (
          (resolveResult.outcome === 'SUCCESS' || resolveResult.outcome === 'PARTIAL') &&
          INFO_ACTIONS.has(intent.actionType) &&
          eventPrimaryNpc
        ) {
          const revealedFactId = this.questProgression.getRevealableQuestFact(eventPrimaryNpc, updatedRunState);
          if (revealedFactId) {
            const existing = updatedRunState.discoveredQuestFacts ?? [];
            if (!existing.includes(revealedFactId)) {
              updatedRunState.discoveredQuestFacts = [...existing, revealedFactId];
              this.logger.log(`[Quest] Fact discovered: ${revealedFactId} (from ${eventPrimaryNpc})`);
            }
          }
        }

        // 전체 발견 팩트 수집 + 단계 전환 체크
        const discoveredFacts = this.questProgression.collectDiscoveredFacts(updatedRunState);
        const currentQuestState = updatedRunState.questState ?? 'S0_ARRIVE';
        const transition = this.questProgression.checkTransition(currentQuestState, discoveredFacts);
        if (transition.newState) {
          updatedRunState.questState = transition.newState;
          this.logger.log(`[Quest] ${currentQuestState} -> ${transition.newState}`);
        }
      } catch (err) {
        this.logger.warn(`[QuestProgression] error (non-fatal): ${err}`);
      }
    }

    // Step 5-7: Turn Orchestration (NPC 주입, 감정 피크, 대화 자세)
    const orchestrationResult = this.orchestration.orchestrate(
      updatedRunState,
      locationId,
      turnNo,
      resolveResult.outcome,
      matchedEvent.payload.tags ?? [],
    );
    updatedRunState.pressure = orchestrationResult.pressure;
    if (orchestrationResult.peakMode) {
      updatedRunState.lastPeakTurn = turnNo;
    }

    // PR-A: npcInjection의 NPC도 보충 처리 (eventPrimaryNpc가 null이었을 때)
    const injectedNpcId = orchestrationResult.npcInjection?.npcId ?? null;
    const effectiveNpcId = eventPrimaryNpc ?? injectedNpcId;
    if (injectedNpcId && !eventPrimaryNpc) {
      // orchestration에서 주입된 NPC도 emotional/encounter 처리
      if (!npcStates[injectedNpcId]) {
        const npcDef = this.content.getNpc(injectedNpcId);
        npcStates[injectedNpcId] = initNPCState({
          npcId: injectedNpcId,
          basePosture: npcDef?.basePosture,
          initialTrust: npcDef?.initialTrust ?? relations[injectedNpcId] ?? 0,
          agenda: npcDef?.agenda,
        });
        newlyEncounteredNpcIds.push(injectedNpcId);
      }
      // 방문 단위 encounterCount 증가
      const alreadyMetInjected = actionHistory.some((h) => h.primaryNpcId === injectedNpcId);
      if (!alreadyMetInjected) {
        npcStates[injectedNpcId].encounterCount = (npcStates[injectedNpcId].encounterCount ?? 0) + 1;
      }
      // 소개 판정 — base posture 기준 (감정 변화로 effective posture가 바뀌어도 소개 임계값은 고정)
      const introPosture = npcStates[injectedNpcId].posture;
      if (shouldIntroduce(npcStates[injectedNpcId], introPosture)) {
        npcStates[injectedNpcId].introduced = true;
        newlyIntroducedNpcIds.push(injectedNpcId);
      }
      updatedRunState.npcStates = npcStates;

      // === 주입된 NPC 개인 기록 축적 ===
      const injBriefNote = (matchedEvent.payload.sceneFrame ?? rawInput).slice(0, 50);
      npcStates[injectedNpcId] = recordNpcEncounter(
        npcStates[injectedNpcId], turnNo, locationId,
        intent.actionType, resolveResult.outcome, injBriefNote,
      );
    }

    // 비도전 행위 여부 (MOVE_LOCATION, REST, SHOP, TALK → 주사위 UI 숨김)
    const isNonChallenge = ['MOVE_LOCATION', 'REST', 'SHOP'].includes(intent.actionType);

    // 결과 조립 — 선택지 생성 전략:
    // 이벤트 첫 만남 → 이벤트 고유 선택지, 이미 상호작용한 이벤트 → resolve 후속 선택지
    const previousHistory = runState.actionHistory ?? [];
    const eventAlreadyInteracted = previousHistory.some((h) => h.eventId === matchedEvent.eventId);
    const selectedChoiceIds = newHistory
      .filter((h) => h.choiceId)
      .map((h) => h.choiceId!);

    let choices: ChoiceItem[];
    if (eventAlreadyInteracted) {
      // 이미 상호작용한 이벤트 → resolve 결과 기반 후속 선택지 (sourceEventId 부분 적용 + eventType별 풀)
      choices = this.sceneShellService.buildFollowUpChoices(locationId, resolveResult.outcome, selectedChoiceIds, matchedEvent.eventId, matchedEvent.eventType, turnNo, resolvedChoices);
    } else {
      // 첫 만남 이벤트 → 이벤트 고유 선택지
      choices = this.sceneShellService.buildLocationChoices(locationId, matchedEvent.eventType, resolvedChoices, selectedChoiceIds, matchedEvent.eventId);
    }
    // summary.short: "이번 턴의 핵심 한 문장" — 행동 + 판정결과만 (sceneFrame 분리하여 중복 전달 방지)
    const outcomeLabel = resolveResult.outcome === 'SUCCESS' ? '성공' : resolveResult.outcome === 'PARTIAL' ? '부분 성공' : '실패';
    const actionLabel = this.actionTypeToKorean(intent.actionType);
    const summaryText = isNonChallenge
      ? `플레이어가 ${actionLabel}${korParticle(actionLabel, '을', '를')} 했다.`
      : `플레이어가 "${rawInput}"${korParticle(rawInput, '을', '를')} 시도하여 ${outcomeLabel}했다.`;
    const result = this.buildLocationResult(turnNo, currentNode, summaryText, resolveResult.outcome, choices, ws, {
      parsedType: intent.actionType,
      originalInput: rawInput,
      tone: intent.tone,
      escalated: intent.escalated,
      insistenceCount: insistenceCount > 0 ? insistenceCount : undefined,
      eventSceneFrame: resolvedSceneFrame,
      eventMatchPolicy: matchedEvent.matchPolicy,
      eventId: matchedEvent.eventId,
      primaryNpcId: matchedEvent.payload.primaryNpcId ?? null,
      goalCategory: intentV3.goalCategory,
      approachVector: intentV3.approachVector,
      goalText: intentV3.goalText,
    }, isNonChallenge, totalGoldDelta, locationReward.items,
    isNonChallenge ? undefined : {
      diceRoll: resolveResult.diceRoll!,
      statKey: resolveResult.statKey ?? null,
      statValue: resolveResult.statValue ?? 0,
      statBonus: resolveResult.statBonus ?? 0,
      baseMod: resolveResult.baseMod ?? 0,
      totalScore: resolveResult.score,
    },
    allEquipmentAdded.length > 0 ? allEquipmentAdded : undefined);

    // 고집 2회째 경고 이벤트 — 다음 반복 시 에스컬레이션 예고
    if (intent.insistenceWarning) {
      const nextType = this.actionTypeToKorean(
        ({ THREATEN: 'FIGHT', PERSUADE: 'THREATEN', OBSERVE: 'INVESTIGATE', TALK: 'PERSUADE', BRIBE: 'THREATEN', SNEAK: 'STEAL' } as Record<string, string>)[intent.actionType] ?? intent.actionType,
      );
      result.events.push({
        id: `warn_insistence_${turnNo}`,
        kind: 'SYSTEM',
        text: `분위기가 험악해지고 있다. 같은 행동을 계속하면 ${nextType}(으)로 상황이 격화될 것이다.`,
        tags: ['warning', 'escalation'],
      });
    }

    // 골드 변동 이벤트 (순 변동 기준 — 비용+보상 합산)
    if (totalGoldDelta > 0) {
      result.events.push({
        id: `gold_${turnNo}`,
        kind: 'GOLD',
        text: `${totalGoldDelta}골드를 획득했다.`,
        tags: [],
      });
    } else if (totalGoldDelta < 0) {
      result.events.push({
        id: `gold_${turnNo}`,
        kind: 'GOLD',
        text: `${Math.abs(totalGoldDelta)}골드를 소비했다.`,
        tags: [],
      });
    }
    for (const item of locationReward.items) {
      const itemDef = this.content.getItem(item.itemId);
      const itemName = itemDef?.name ?? item.itemId;
      result.events.push({
        id: `loot_${turnNo}_${item.itemId}`,
        kind: 'LOOT',
        text: `${itemName}${korParticle(itemName, '을', '를')} 획득했다.`,
        tags: [],
      });
    }

    // Phase 4a: 장비 드랍 이벤트 추가
    for (const eqEvt of locationEquipDropEvents) {
      result.events.push(eqEvt);
    }

    // Phase 4d: Legendary 보상 이벤트 추가
    for (const legEvt of legendaryResult.events) {
      result.events.push(legEvt);
    }

    // Phase 4b: 상점 액션 이벤트 추가
    for (const shopEvt of shopActionEvents) {
      result.events.push(shopEvt);
    }

    // Orchestration 결과를 ui에 추가 (LLM context 전달용)
    if (orchestrationResult.npcInjection) {
      (result.ui as any).npcInjection = orchestrationResult.npcInjection;
    }
    if (orchestrationResult.peakMode) {
      (result.ui as any).peakMode = true;
    }
    if (Object.keys(orchestrationResult.npcPostures).length > 0) {
      (result.ui as any).npcPostures = orchestrationResult.npcPostures;
    }

    // NPC 소개 정보를 ui에 추가 (LLM context-builder로 전달)
    if (newlyIntroducedNpcIds.length > 0) {
      (result.ui as any).newlyIntroducedNpcIds = newlyIntroducedNpcIds;
    }
    if (newlyEncounteredNpcIds.length > 0) {
      (result.ui as any).newlyEncounteredNpcIds = newlyEncounteredNpcIds;
    }

    // === Narrative Engine v1: UI data 추가 ===
    const finalWs = updatedRunState.worldState!;
    // Signal Feed
    (result.ui as any).signalFeed = (finalWs.signalFeed ?? []).map((s: any) => ({
      id: s.id,
      channel: s.channel,
      severity: s.severity,
      locationId: s.locationId,
      text: s.text,
    })) as SignalFeedItemUI[];

    // Active Incidents
    const incidentDefMap = new Map(incidentDefs.map((d) => [d.incidentId, d]));
    (result.ui as any).activeIncidents = (finalWs.activeIncidents ?? []).map((i: IncidentRuntime) => ({
      incidentId: i.incidentId,
      title: incidentDefMap.get(i.incidentId)?.title ?? i.incidentId,
      kind: i.kind,
      stage: i.stage,
      control: i.control,
      pressure: i.pressure,
      deadlineClock: i.deadlineClock,
      resolved: i.resolved,
      outcome: i.outcome,
    })) as IncidentSummaryUI[];

    // NPC Emotional
    const npcEmotionalUIs: NpcEmotionalUI[] = Object.entries(npcStates).map(([npcId, npc]) => ({
      npcId,
      npcName: npcNames[npcId] ?? npcId,
      trust: npc.emotional.trust,
      fear: npc.emotional.fear,
      respect: npc.emotional.respect,
      suspicion: npc.emotional.suspicion,
      attachment: npc.emotional.attachment,
      posture: npc.posture,
      marks: (finalWs.narrativeMarks ?? []).filter((m: any) => m.npcId === npcId).map((m: any) => m.type),
    }));
    if (npcEmotionalUIs.length > 0) {
      (result.ui as any).npcEmotional = npcEmotionalUIs;
    }

    // === Notification System: 알림 조립 ===
    const notifResult = this.notificationAssembler.build({
      turnNo,
      locationId,
      resolveOutcome: resolveResult.outcome,
      actionType: intent.actionType,
      goalText: intentV3.goalText,
      targetNpcId: (matchedEvent?.payload as any)?.primaryNpcId ?? intent.target ?? null,
      relatedIncidentId: routingResult?.incident?.incidentId ?? null,
      prevIncidents,
      currentIncidents: finalWs.activeIncidents ?? [],
      ws: finalWs,
      prevHeat,
      prevSafety,
    });
    if (notifResult.notifications.length > 0) {
      (result.ui as any).notifications = notifResult.notifications;
    }
    if (notifResult.pinnedAlerts.length > 0) {
      (result.ui as any).pinnedAlerts = notifResult.pinnedAlerts;
    }
    if (notifResult.worldDeltaSummary) {
      (result.ui as any).worldDeltaSummary = notifResult.worldDeltaSummary;
    }

    // Phase 4b: 상점 정보 UI에 포함 (현재 장소에 상점이 있을 때)
    if (this.shopService && updatedRunState.regionEconomy) {
      const locShops = this.content.getShopsByLocation(locationId);
      if (locShops.length > 0) {
        const shopDisplays = locShops.map((shopDef) => {
          const stock = updatedRunState.regionEconomy!.shopStocks[shopDef.shopId];
          return {
            shopId: shopDef.shopId,
            name: shopDef.name,
            items: stock
              ? this.shopService!.getDisplayItems(stock, updatedRunState.regionEconomy!.priceIndex)
              : [],
          };
        }).filter((s) => s.items.length > 0);
        if (shopDisplays.length > 0) {
          (result.ui as any).shops = shopDisplays;
          (result.ui as any).priceIndex = updatedRunState.regionEconomy.priceIndex;
        }
      }
    }

    // PlayerThread UI 번들에 포함
    if (ws.playerThreads && ws.playerThreads.length > 0) {
      (result.ui as any).playerThreads = ws.playerThreads;
    }

    // Quest UI 번들: arcState, narrativeMarks, mainArcClock, day
    (result.ui as any).arcState = updatedRunState.arcState ?? null;
    (result.ui as any).narrativeMarks = ws.narrativeMarks ?? [];
    (result.ui as any).mainArcClock = ws.mainArcClock ?? null;
    (result.ui as any).day = ws.day ?? 1;

    // 이벤트 추가 (sceneFrame은 actionContext에서 전달, 여기서는 행동 요약만)
    result.events.push({
      id: `event_${matchedEvent.eventId}`,
      kind: 'NPC',
      text: `${actionLabel} — ${matchedEvent.eventType}`,
      tags: matchedEvent.payload.tags,
    });

    // Step 10: Off-screen Tick (턴 커밋 전 RunState에 반영)
    const postTickRunState = this.orchestration.offscreenTick(
      updatedRunState,
      turnNo,
      resolveResult.outcome,
      matchedEvent.payload.tags ?? [],
    );

    // === Narrative Engine v1: NPC passive drift (offscreen) ===
    if (postTickRunState.npcStates) {
      for (const [npcId, npc] of Object.entries(postTickRunState.npcStates as Record<string, NPCState>)) {
        npc.emotional = this.npcEmotional.applyPassiveDrift(npc.emotional);
        (postTickRunState.npcStates as Record<string, NPCState>)[npcId] = this.npcEmotional.syncLegacyFields(npc);
      }
    }

    // === Narrative Engine v1: Ending 조건 체크 ===
    const endWs = postTickRunState.worldState!;
    const { shouldEnd, reason: endReason } = this.endingGenerator.checkEndingConditions(
      endWs.activeIncidents ?? [],
      endWs.mainArcClock ?? { startDay: 1, softDeadlineDay: 14, triggered: false },
      endWs.day ?? 1,
      turnNo,
    );

    // === Structured Memory v2: 실시간 수집 ===
    try {
      // NPC 감정 변화 delta 계산 (이번 턴에서 변경된 축만)
      let npcEmoDelta: { npcId: string; delta: Record<string, number> } | undefined;
      if (effectiveNpcId) {
        const npc = npcStates[effectiveNpcId];
        if (npc?.emotional) {
          // 대략적인 delta — applyActionImpact에서 변경된 값 (정확한 before 없으므로 간략화)
          npcEmoDelta = { npcId: effectiveNpcId, delta: {} };
        }
      }
      await this.memoryCollector.collectFromTurn(
        run.id,
        currentNode.id,
        locationId,
        turnNo,
        {
          actionType: intent.actionType,
          secondaryActionType: intent.secondaryActionType,
          rawInput: rawInput.slice(0, 30),
          outcome: resolveResult.outcome,
          eventId: matchedEvent.eventId,
          sceneFrame: resolvedSceneFrame,
          primaryNpcId: effectiveNpcId ?? undefined,
          eventTags: matchedEvent.payload.tags ?? [],
          summaryShort: summaryText ?? undefined,
          reputationChanges: resolveResult.reputationChanges,
          goldDelta: totalGoldDelta,
          incidentImpact: relevantIncident
            ? {
                incidentId: relevantIncident.incident.incidentId,
                controlDelta: relevantIncident.incident.control - (priorWsSnapshot.activeIncidents?.find((i) => i.incidentId === relevantIncident.incident.incidentId)?.control ?? 0),
                pressureDelta: relevantIncident.incident.pressure - (priorWsSnapshot.activeIncidents?.find((i) => i.incidentId === relevantIncident.incident.incidentId)?.pressure ?? 0),
              }
            : undefined,
          npcEmotionalDelta: npcEmoDelta as any,
          newMarks: newMarks.map((m) => m.type),
        },
      );
    } catch (err) {
      // 수집 실패는 게임 진행에 영향 없음
      this.logger.warn(`[MemoryCollector] collectFromTurn failed: ${(err as Error).message}`);
    }

    await this.commitTurnRecord(run, currentNode, turnNo, body, rawInput, result, postTickRunState, body.options?.skipLlm);

    if (shouldEnd && endReason) {
      // Fixplan3-P1: RUN_ENDED 전 structuredMemory 통합 (go_hub 없이 런 종료 시 누락 방지)
      try {
        const locMemEnd = await this.memoryIntegration.finalizeVisit(run.id, currentNode.id, postTickRunState, turnNo);
        if (locMemEnd) postTickRunState.locationMemories = locMemEnd;
      } catch { /* 메모리 통합 실패는 엔딩 생성에 영향 없음 */ }

      // 엔딩 생성
      // User-Driven System v3: playerThreads를 엔딩 입력에 전달
      const endingThreads = (endWs.playerThreads ?? []).map((t) => ({
        approachVector: t.approachVector,
        goalCategory: t.goalCategory,
        actionCount: t.actionCount,
        successCount: t.successCount,
        status: t.status,
      }));
      const endingInput = this.endingGenerator.gatherEndingInputs(
        endWs.activeIncidents ?? [],
        (postTickRunState.npcStates ?? {}) as Record<string, NPCState>,
        endWs.narrativeMarks ?? [],
        endWs as unknown as Record<string, unknown>,
        postTickRunState.arcState ?? null,
        postTickRunState.actionHistory ?? [],
        endingThreads,
      );
      const endingResult = this.endingGenerator.generateEnding(endingInput, endReason, turnNo);

      // RUN_ENDED로 상태 변경
      await this.db.update(runSessions).set({
        status: 'RUN_ENDED',
        updatedAt: new Date(),
      }).where(eq(runSessions.id, run.id));

      // Campaign: 시나리오 결과 저장
      await this.saveCampaignResultIfNeeded(run.id);

      // 엔딩 결과를 이벤트에 추가
      result.events.push({
        id: `ending_${turnNo}`,
        kind: 'SYSTEM',
        text: `[엔딩] ${endingResult.closingLine}`,
        tags: ['RUN_ENDED'],
        data: { endingResult },
      });

      return {
        accepted: true, turnNo, serverResult: result,
        llm: { status: (body.options?.skipLlm ? 'SKIPPED' : 'PENDING') as LlmStatus, narrative: null },
        meta: { nodeOutcome: 'RUN_ENDED', policyResult: 'ALLOW' },
      };
    }

    return {
      accepted: true, turnNo, serverResult: result,
      llm: { status: (body.options?.skipLlm ? 'SKIPPED' : 'PENDING') as LlmStatus, narrative: null },
      meta: { nodeOutcome: 'ONGOING', policyResult: 'ALLOW' },
    };
  }

  // --- DAG 노드 턴 (EVENT/REST/SHOP/EXIT in DAG mode) ---
  private async handleDagNodeTurn(
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
    const resolveResult = this.nodeResolver.resolve({
      turnNo,
      nodeId: currentNode.id,
      nodeIndex: currentNode.nodeIndex,
      nodeType,
      nodeMeta: currentNode.nodeMeta as import('../db/types/index.js').NodeMeta,
      envTags: currentNode.environmentTags ?? [],
      inputType: body.input.type as 'ACTION' | 'CHOICE' | 'SYSTEM',
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
    });

    // RunState 반영 (gold, hp, stamina 변동)
    if (resolveResult.goldDelta) updatedRunState.gold += resolveResult.goldDelta;
    if (resolveResult.hpDelta) {
      updatedRunState.hp = Math.max(0, Math.min(updatedRunState.maxHp, updatedRunState.hp + resolveResult.hpDelta));
    }
    if (resolveResult.staminaDelta) {
      updatedRunState.stamina = Math.max(0, Math.min(updatedRunState.maxStamina, updatedRunState.stamina + resolveResult.staminaDelta));
    }
    if (resolveResult.itemsBought) {
      for (const item of resolveResult.itemsBought) {
        const existing = updatedRunState.inventory.find((i) => i.itemId === item.itemId);
        if (existing) existing.qty += item.qty;
        else updatedRunState.inventory.push({ itemId: item.itemId, qty: item.qty });
      }
    }

    // 턴 커밋
    const llmStatus: LlmStatus = body.options?.skipLlm ? 'SKIPPED' : 'PENDING';
    await this.db.insert(turns).values({
      runId: run.id, turnNo, nodeInstanceId: currentNode.id,
      nodeType, inputType: body.input.type,
      rawInput, idempotencyKey: body.idempotencyKey,
      parsedBy: null, confidence: null, parsedIntent: null,
      policyResult: 'ALLOW', transformedIntent: null, actionPlan: null,
      serverResult: resolveResult.serverResult, llmStatus,
    });

    // NODE_ENDED → DAG 다음 노드 전환
    if (resolveResult.nodeOutcome === 'NODE_ENDED' || resolveResult.nodeOutcome === 'RUN_ENDED') {
      // 현재 노드 종료
      await this.db.update(nodeInstances).set({
        status: 'NODE_ENDED',
        nodeState: resolveResult.nextNodeState ?? null,
        updatedAt: new Date(),
      }).where(eq(nodeInstances.id, currentNode.id));

      if (resolveResult.nodeOutcome === 'RUN_ENDED' || nodeType === 'EXIT') {
        await this.db.update(runSessions).set({
          status: 'RUN_ENDED', currentTurnNo: turnNo, runState: updatedRunState, updatedAt: new Date(),
        }).where(eq(runSessions.id, run.id));
        await this.saveCampaignResultIfNeeded(run.id);
        return {
          accepted: true, turnNo, serverResult: resolveResult.serverResult,
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

      const ws = updatedRunState.worldState ?? this.worldStateService.initWorldState();
      const dagTransition = await this.nodeTransition.transitionByGraphNode(
        run.id,
        run.currentGraphNodeId!,
        dagRouteContext,
        turnNo + 1,
        ws,
        updatedRunState.hp,
        updatedRunState.stamina,
        run.seed,
      );

      if (!dagTransition || dagTransition.nextNodeType === 'EXIT') {
        // 그래프 종료 → RUN_ENDED
        await this.db.update(runSessions).set({
          status: 'RUN_ENDED', currentTurnNo: turnNo, runState: updatedRunState, updatedAt: new Date(),
        }).where(eq(runSessions.id, run.id));
        await this.saveCampaignResultIfNeeded(run.id);

        const response: any = {
          accepted: true, turnNo, serverResult: resolveResult.serverResult,
          llm: { status: llmStatus, narrative: null },
          meta: { nodeOutcome: 'RUN_ENDED', policyResult: 'ALLOW' },
        };
        if (dagTransition) {
          response.transition = {
            nextNodeIndex: dagTransition.nextNodeIndex, nextNodeType: dagTransition.nextNodeType,
            enterResult: dagTransition.enterResult, battleState: null, enterTurnNo: turnNo + 1,
          };
        }
        return response;
      }

      // routeTag가 결정된 경우 runState에도 반영
      if (dagTransition.routeTag) {
        updatedRunState.worldState = {
          ...(updatedRunState.worldState ?? this.worldStateService.initWorldState()),
        };
      }

      dagTransition.enterResult.turnNo = turnNo + 1;
      await this.db.insert(turns).values({
        runId: run.id, turnNo: turnNo + 1, nodeInstanceId: dagTransition.enterResult.node.id,
        nodeType: dagTransition.nextNodeType, inputType: 'SYSTEM', rawInput: '',
        idempotencyKey: `${run.id}_dag_${dagTransition.nextNodeIndex}`,
        parsedBy: null, confidence: null, parsedIntent: null,
        policyResult: 'ALLOW', transformedIntent: null, actionPlan: null,
        serverResult: dagTransition.enterResult, llmStatus: 'PENDING',
      });
      await this.db.update(runSessions).set({
        currentTurnNo: turnNo + 1, runState: updatedRunState, updatedAt: new Date(),
      }).where(eq(runSessions.id, run.id));

      return {
        accepted: true, turnNo, serverResult: resolveResult.serverResult,
        llm: { status: llmStatus, narrative: null },
        meta: { nodeOutcome: 'NODE_ENDED', policyResult: 'ALLOW' },
        transition: {
          nextNodeIndex: dagTransition.nextNodeIndex, nextNodeType: dagTransition.nextNodeType,
          enterResult: dagTransition.enterResult, battleState: dagTransition.battleState ?? null, enterTurnNo: turnNo + 1,
        },
      };
    }

    // ONGOING — 노드 상태 업데이트
    if (resolveResult.nextNodeState) {
      await this.db.update(nodeInstances).set({
        nodeState: resolveResult.nextNodeState, updatedAt: new Date(),
      }).where(eq(nodeInstances.id, currentNode.id));
    }
    await this.db.update(runSessions).set({
      currentTurnNo: turnNo, runState: updatedRunState, updatedAt: new Date(),
    }).where(eq(runSessions.id, run.id));

    return {
      accepted: true, turnNo, serverResult: resolveResult.serverResult,
      llm: { status: llmStatus, narrative: null },
      meta: { nodeOutcome: 'ONGOING', policyResult: 'ALLOW' },
    };
  }

  // --- COMBAT 턴 (기존 전투 엔진 재사용) ---
  private async handleCombatTurn(
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
    let battleState = bs?.state ?? null;
    if (!battleState) throw new InternalError('BattleState not found for COMBAT node');

    // 입력 파이프라인 (기존 로직 재사용)
    let rawInput = body.input.text ?? body.input.choiceId ?? '';
    if (body.input.type === 'CHOICE' && body.input.choiceId) {
      const prevTurn = await this.db.query.turns.findFirst({
        where: and(eq(turns.runId, run.id), eq(turns.turnNo, run.currentTurnNo)),
        columns: { serverResult: true },
      });
      const prevChoices = (prevTurn?.serverResult as ServerResultV1 | null)?.choices;
      const matched = prevChoices?.find((c) => c.id === body.input.choiceId);
      if (matched) rawInput = matched.label;
    }

    let parsedIntent: ParsedIntent | undefined;
    let actionPlan: ActionPlan | undefined;
    let policyResult: 'ALLOW' | 'TRANSFORM' | 'PARTIAL' | 'DENY' = 'ALLOW';
    let transformedIntent: ParsedIntent | undefined;

    if (body.input.type === 'ACTION') {
      parsedIntent = this.ruleParser.parse(rawInput);
      const policyCheck = this.policyService.check(
        parsedIntent, currentNode.nodeType,
        currentNode.status as 'NODE_ACTIVE' | 'NODE_ENDED',
        battleState.player?.stamina ?? playerStats.maxStamina,
      );
      policyResult = policyCheck.result;
      if (policyCheck.transformedIntents) transformedIntent = policyCheck.transformedIntents;

      if (policyResult === 'DENY') {
        const denyResult = this.buildDenyResult(turnNo, currentNode, policyCheck.reason ?? 'Policy denied');
        return this.commitCombatTurn(run, currentNode, turnNo, body, rawInput, parsedIntent, policyResult, transformedIntent, undefined, denyResult, battleState, body.options?.skipLlm);
      }

      const effectiveIntent = transformedIntent ?? parsedIntent;
      actionPlan = this.actionPlanService.buildPlan(effectiveIntent, policyResult, battleState.player?.stamina ?? playerStats.maxStamina);
    }

    if (body.input.type === 'CHOICE' && body.input.choiceId) {
      actionPlan = this.mapCombatChoiceToActionPlan(body.input.choiceId);
    }

    // 적 스탯 로드
    const enemyStats: Record<string, PermanentStats> = {};
    const enemyNames: Record<string, string> = {};
    for (const e of battleState.enemies) {
      const enemyRef = e.id.replace(/_\d+$/, '');
      const def = this.content.getEnemy(enemyRef);
      if (def) {
        const es = def.stats as Record<string, number>;
        enemyStats[e.id] = {
          maxHP: def.hp, maxStamina: 5,
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

    const resolveResult = this.nodeResolver.resolve({
      turnNo, nodeId: currentNode.id, nodeIndex: currentNode.nodeIndex,
      nodeType: 'COMBAT', nodeMeta: currentNode.nodeMeta ?? undefined,
      envTags: currentNode.environmentTags ?? [], inputType: body.input.type,
      rawInput, choiceId: body.input.choiceId, actionPlan,
      battleState, playerStats,
      enemyStats: Object.keys(enemyStats).length > 0 ? enemyStats : undefined,
      enemyNames: Object.keys(enemyNames).length > 0 ? enemyNames : undefined,
      rewardSeed: `${run.seed}_t${turnNo}`,
      playerHp: battleState.player?.hp ?? runState.hp,
      playerMaxHp: runState.maxHp, playerStamina: battleState.player?.stamina ?? runState.stamina,
      playerMaxStamina: runState.maxStamina, playerGold: runState.gold,
      inventory: runState.inventory, inventoryCount: runState.inventory.length,
      inventoryMax: InventoryService.DEFAULT_MAX_SLOTS,
      nodeState: currentNode.nodeState ?? undefined,
    });

    // runState 업데이트
    const updatedRunState: RunState = { ...runState };
    const goldDelta = resolveResult.goldDelta ?? resolveResult.serverResult.diff.inventory.goldDelta ?? 0;
    updatedRunState.gold = Math.max(0, updatedRunState.gold + goldDelta);
    if (resolveResult.nextBattleState?.player) {
      updatedRunState.hp = resolveResult.nextBattleState.player.hp;
      updatedRunState.stamina = resolveResult.nextBattleState.player.stamina;
    }
    for (const added of resolveResult.serverResult.diff.inventory.itemsAdded ?? []) {
      const existing = updatedRunState.inventory.find((i) => i.itemId === added.itemId);
      if (existing) existing.qty += added.qty;
      else updatedRunState.inventory.push({ itemId: added.itemId, qty: added.qty });
    }

    // Phase 4a: 전투 승리 시 장비 드랍
    if (resolveResult.combatOutcome === 'VICTORY') {
      const locationId = updatedRunState.worldState?.currentLocationId ?? 'LOC_HARBOR';
      const encounterEnc = currentNode.nodeMeta?.encounterId as string | undefined;
      const isBoss = !!(currentNode.nodeMeta?.isBoss);
      const enemyIds = Object.keys(resolveResult.nextBattleState?.enemies ?? {});
      const combatDropRng = this.rngService.create(run.seed + '_eqdrop', turnNo);
      const equipDrop = this.rewardsService.rollCombatEquipmentDrops(
        enemyIds, encounterEnc, isBoss, locationId, combatDropRng,
      );
      if (equipDrop.droppedInstances.length > 0) {
        if (!updatedRunState.equipmentBag) updatedRunState.equipmentBag = [];
        const combatEquipAdded: import('../db/types/equipment.js').ItemInstance[] = [];
        const acquiredFrom = isBoss ? '보스전 드랍' : '전투 보상';
        for (const inst of equipDrop.droppedInstances) {
          updatedRunState.equipmentBag.push(inst);
          combatEquipAdded.push(inst);
          // Phase 3: ItemMemory — 전투 장비 드랍 기록
          this.recordItemMemory(updatedRunState, inst, turnNo, acquiredFrom, locationId);
          resolveResult.serverResult.events.push({
            id: `eq_drop_${inst.instanceId.slice(0, 8)}`,
            kind: 'LOOT',
            text: `[장비] ${inst.displayName} 획득`,
            tags: ['LOOT', 'EQUIPMENT_DROP'],
            data: { baseItemId: inst.baseItemId, instanceId: inst.instanceId, displayName: inst.displayName },
          });
        }
        resolveResult.serverResult.diff.equipmentAdded = combatEquipAdded;
      }
    }

    const response = await this.commitCombatTurn(
      run, currentNode, turnNo, body, rawInput, parsedIntent, policyResult,
      transformedIntent, actionPlan ? [actionPlan] : undefined,
      resolveResult.serverResult, resolveResult.nextBattleState ?? battleState,
      body.options?.skipLlm, resolveResult.nodeOutcome, resolveResult.nextNodeState, updatedRunState,
    );

    // 전투 종료 처리 (VICTORY/DEFEAT/FLEE)
    if (resolveResult.nodeOutcome === 'NODE_ENDED') {
      const ws = updatedRunState.worldState ?? this.worldStateService.initWorldState();
      const arcState = updatedRunState.arcState ?? this.arcService.initArcState();

      // 패배 시 RUN_ENDED + 엔딩 내러티브 생성
      if (resolveResult.combatOutcome === 'DEFEAT') {
        // structuredMemory 통합
        try {
          const locMemDefeat = await this.memoryIntegration.finalizeVisit(run.id, currentNode.id, updatedRunState, turnNo);
          if (locMemDefeat) updatedRunState.locationMemories = locMemDefeat;
        } catch { /* 메모리 통합 실패는 엔딩 생성에 영향 없음 */ }

        // 패배 엔딩 생성
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
            (updatedRunState.npcStates ?? {}) as Record<string, NPCState>,
            ws.narrativeMarks ?? [],
            ws as unknown as Record<string, unknown>,
            updatedRunState.arcState ?? null,
            updatedRunState.actionHistory ?? [],
            endingThreads,
          );
          const endingResult = this.endingGenerator.generateEnding(endingInput, 'DEFEAT', turnNo);
          (response as any).serverResult.events.push({
            id: `ending_${turnNo}`,
            kind: 'SYSTEM',
            text: `[엔딩] ${endingResult.closingLine}`,
            tags: ['RUN_ENDED'],
            data: { endingResult },
          });
        } catch (e) {
          this.logger.warn(`DEFEAT ending generation failed: ${e}`);
        }

        await this.db.update(runSessions).set({ status: 'RUN_ENDED', updatedAt: new Date() }).where(eq(runSessions.id, run.id));

        // Campaign: 시나리오 결과 저장
        await this.saveCampaignResultIfNeeded(run.id);

        (response as any).meta.nodeOutcome = 'RUN_ENDED';
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
            const locMemDag = await this.memoryIntegration.finalizeVisit(run.id, currentNode.id, updatedRunState, turnNo);
            if (locMemDag) updatedRunState.locationMemories = locMemDag;
          } catch { /* 메모리 통합 실패는 엔딩 생성에 영향 없음 */ }
          await this.db.update(runSessions).set({ status: 'RUN_ENDED', updatedAt: new Date() }).where(eq(runSessions.id, run.id));
          await this.saveCampaignResultIfNeeded(run.id);
          (response as any).meta.nodeOutcome = 'RUN_ENDED';
          if (dagTransition) {
            (response as any).transition = {
              nextNodeIndex: dagTransition.nextNodeIndex, nextNodeType: dagTransition.nextNodeType,
              enterResult: dagTransition.enterResult, battleState: null, enterTurnNo: turnNo + 1,
            };
          }
          return response;
        }

        dagTransition.enterResult.turnNo = turnNo + 1;
        await this.db.insert(turns).values({
          runId: run.id, turnNo: turnNo + 1, nodeInstanceId: dagTransition.enterResult.node.id,
          nodeType: dagTransition.nextNodeType, inputType: 'SYSTEM', rawInput: '',
          idempotencyKey: `${run.id}_dag_${dagTransition.nextNodeIndex}`,
          parsedBy: null, confidence: null, parsedIntent: null,
          policyResult: 'ALLOW', transformedIntent: null, actionPlan: null,
          serverResult: dagTransition.enterResult, llmStatus: 'PENDING',
        });
        await this.db.update(runSessions).set({ currentTurnNo: turnNo + 1, runState: updatedRunState, updatedAt: new Date() }).where(eq(runSessions.id, run.id));

        (response as any).transition = {
          nextNodeIndex: dagTransition.nextNodeIndex, nextNodeType: dagTransition.nextNodeType,
          enterResult: dagTransition.enterResult, battleState: dagTransition.battleState ?? null, enterTurnNo: turnNo + 1,
        };
      } else {
        // HUB 모드: 승리/도주 → 부모 LOCATION 복귀
        const parentNodeId = currentNode.parentNodeInstanceId ?? (currentNode.nodeState as any)?.parentNodeId;
        if (parentNodeId) {
          // 부모 노드의 index 찾기
          const parentNode = await this.db.query.nodeInstances.findFirst({
            where: eq(nodeInstances.id, parentNodeId),
          });
          const parentNodeIndex = parentNode?.nodeIndex ?? currentNode.nodeIndex - 1;
          const locationId = ws.currentLocationId ?? 'LOC_MARKET';

          // Heat 반영 (combatWindowCount는 전투 시작 시 이미 증가됨 — 중복 증가 방지)
          const newWs = this.heatService.applyHeatDelta(ws, 3);
          updatedRunState.worldState = this.worldStateService.updateHubSafety(newWs);

          const transition = await this.nodeTransition.returnFromCombat(
            run.id, parentNodeIndex, turnNo + 1, locationId, updatedRunState.worldState!,
          );
          transition.enterResult.turnNo = turnNo + 1;
          await this.db.insert(turns).values({
            runId: run.id, turnNo: turnNo + 1, nodeInstanceId: transition.enterResult.node.id,
            nodeType: 'LOCATION', inputType: 'SYSTEM', rawInput: '',
            idempotencyKey: `${run.id}_return_${turnNo + 1}`,
            parsedBy: null, confidence: null, parsedIntent: null,
            policyResult: 'ALLOW', transformedIntent: null, actionPlan: null,
            serverResult: transition.enterResult, llmStatus: 'PENDING',
          });
          await this.db.update(runSessions).set({ currentTurnNo: turnNo + 1, runState: updatedRunState, updatedAt: new Date() }).where(eq(runSessions.id, run.id));

          (response as any).transition = {
            nextNodeIndex: transition.nextNodeIndex, nextNodeType: 'LOCATION',
            enterResult: transition.enterResult, battleState: null, enterTurnNo: turnNo + 1,
          };
        }
      }
    }

    return response;
  }

  // --- Helper: 전투 턴 커밋 ---
  private async commitCombatTurn(
    run: any, currentNode: any, turnNo: number, body: SubmitTurnBody,
    rawInput: string, parsedIntent: ParsedIntent | undefined,
    policyResult: string, transformedIntent: ParsedIntent | undefined,
    actionPlan: ActionPlan[] | undefined, serverResult: ServerResultV1,
    nextBattleState: BattleStateV1 | null | undefined, skipLlm: boolean | undefined,
    nodeOutcome?: string, nextNodeState?: Record<string, unknown>, runStateUpdate?: RunState,
  ) {
    const llmStatus: LlmStatus = skipLlm ? 'SKIPPED' : 'PENDING';

    await this.db.transaction(async (tx) => {
      await tx.insert(turns).values({
        runId: run.id, turnNo, nodeInstanceId: currentNode.id,
        nodeType: currentNode.nodeType as NodeType, inputType: body.input.type,
        rawInput, idempotencyKey: body.idempotencyKey,
        parsedBy: parsedIntent?.source ?? null, confidence: parsedIntent?.confidence ?? null,
        parsedIntent: parsedIntent ?? null, policyResult: policyResult as any,
        transformedIntent: transformedIntent ?? null, actionPlan: actionPlan ?? null,
        serverResult, llmStatus,
      });

      await tx.update(runSessions).set({
        currentTurnNo: turnNo, updatedAt: new Date(),
        ...(nodeOutcome === 'RUN_ENDED' ? { status: 'RUN_ENDED' } : {}),
        ...(runStateUpdate ? { runState: runStateUpdate } : {}),
      }).where(eq(runSessions.id, run.id));

      if (nodeOutcome === 'NODE_ENDED' || nodeOutcome === 'RUN_ENDED') {
        await tx.update(nodeInstances).set({
          status: 'NODE_ENDED', nodeState: nextNodeState ?? null, updatedAt: new Date(),
        }).where(eq(nodeInstances.id, currentNode.id));
      } else if (nextNodeState) {
        await tx.update(nodeInstances).set({ nodeState: nextNodeState, updatedAt: new Date() })
          .where(eq(nodeInstances.id, currentNode.id));
      }

      if (nextBattleState && currentNode.nodeType === 'COMBAT') {
        await tx.update(battleStates).set({ state: nextBattleState, updatedAt: new Date() })
          .where(and(eq(battleStates.runId, run.id), eq(battleStates.nodeInstanceId, currentNode.id)));
      }
    });

    return {
      accepted: true, turnNo, serverResult,
      llm: { status: llmStatus, narrative: null },
      meta: { nodeOutcome: nodeOutcome ?? 'ONGOING', policyResult },
    };
  }


  // --- Helper: 일반 턴 레코드 커밋 ---
  private async commitTurnRecord(
    run: any, currentNode: any, turnNo: number, body: SubmitTurnBody,
    rawInput: string, serverResult: ServerResultV1, runStateUpdate: RunState,
    skipLlm?: boolean,
  ) {
    const llmStatus: LlmStatus = skipLlm ? 'SKIPPED' : 'PENDING';
    await this.db.insert(turns).values({
      runId: run.id, turnNo, nodeInstanceId: currentNode.id,
      nodeType: currentNode.nodeType as NodeType, inputType: body.input.type,
      rawInput, idempotencyKey: body.idempotencyKey,
      parsedBy: null, confidence: null, parsedIntent: null,
      policyResult: 'ALLOW', transformedIntent: null, actionPlan: null,
      serverResult, llmStatus,
    });
    await this.db.update(runSessions).set({
      currentTurnNo: turnNo, runState: runStateUpdate, updatedAt: new Date(),
    }).where(eq(runSessions.id, run.id));
  }

  // --- Result builders ---
  private buildSystemResult(turnNo: number, node: any, text: string): ServerResultV1 {
    return {
      version: 'server_result_v1', turnNo,
      node: { id: node.id, type: node.nodeType, index: node.nodeIndex, state: 'NODE_ACTIVE' },
      summary: { short: text, display: text },
      events: [{ id: `sys_${turnNo}`, kind: 'SYSTEM', text, tags: [] }],
      diff: {
        player: { hp: { from: 0, to: 0, delta: 0 }, stamina: { from: 0, to: 0, delta: 0 }, status: [] },
        enemies: [], inventory: { itemsAdded: [], itemsRemoved: [], goldDelta: 0 },
        meta: { battle: { phase: 'NONE' }, position: { env: [] } },
      },
      ui: { availableActions: [], targetLabels: [], actionSlots: { base: 2, bonusAvailable: false, max: 3 }, toneHint: 'neutral' },
      choices: [],
      flags: { bonusSlot: false, downed: false, battleEnded: false },
    };
  }

  private buildHubActionResult(turnNo: number, node: any, text: string, choices: ServerResultV1['choices'], ws: WorldState): ServerResultV1 {
    return {
      ...this.buildSystemResult(turnNo, node, text),
      ui: {
        availableActions: ['CHOICE'], targetLabels: [],
        actionSlots: { base: 2, bonusAvailable: false, max: 3 }, toneHint: 'neutral',
        worldState: { hubHeat: ws.hubHeat, hubSafety: ws.hubSafety, timePhase: ws.timePhase, currentLocationId: null, locationDynamicStates: ws.locationDynamicStates ?? {}, playerGoals: (ws.playerGoals ?? []).filter((g) => !g.completed), reputation: ws.reputation ?? {} },
      },
      choices,
    };
  }

  /**
   * Phase 3: ItemMemory — RARE 이상 장비 획득 시 아이템 기록 생성.
   * COMMON 아이템은 기록하지 않음.
   */
  private recordItemMemory(
    runState: RunState,
    inst: import('../db/types/equipment.js').ItemInstance,
    turnNo: number,
    acquiredFrom: string,
    locationId: string,
  ): void {
    const itemDef = this.content.getItem(inst.baseItemId);
    const rarity = itemDef?.rarity ?? 'COMMON';
    if (rarity === 'COMMON') return;

    if (!runState.itemMemories) runState.itemMemories = {};
    runState.itemMemories[inst.instanceId] = {
      acquiredTurn: turnNo,
      acquiredFrom,
      acquiredLocation: locationId,
      usedInEvents: [],
      narrativeNote: itemDef?.narrativeTags?.[0] ?? '',
    };
  }

  /**
   * Phase 3: ItemMemory — 아이템 사용 이벤트 기록 추가 (usedInEvents, 최대 5개)
   */
  private recordItemUsedEvent(
    runState: RunState,
    instanceId: string,
    turnNo: number,
    eventDesc: string,
  ): void {
    const mem = runState.itemMemories?.[instanceId];
    if (!mem) return;
    if (mem.usedInEvents.length >= 5) {
      mem.usedInEvents.shift(); // 오래된 항목 제거
    }
    mem.usedInEvents.push(`T${turnNo} ${eventDesc}`);
  }

  /** LOCATION 방문 대화를 결정론적 요약으로 장기기억에 저장 */
  private async saveLocationVisitSummary(
    runId: string,
    nodeInstanceId: string,
    locationId: string,
  ): Promise<void> {
    // 현재 LOCATION 노드의 모든 플레이어 턴 조회
    const visitTurns = await this.db
      .select({
        turnNo: turns.turnNo,
        inputType: turns.inputType,
        rawInput: turns.rawInput,
        serverResult: turns.serverResult,
        llmOutput: turns.llmOutput,
      })
      .from(turns)
      .where(
        and(
          eq(turns.runId, runId),
          eq(turns.nodeInstanceId, nodeInstanceId),
          ne(turns.inputType, 'SYSTEM'),
        ),
      )
      .orderBy(asc(turns.turnNo));

    if (visitTurns.length === 0) return;

    // 결정론적 요약 생성 (LLM 불필요 — 행동+결과 기반)
    const locationNames: Record<string, string> = {
      LOC_MARKET: '시장 거리',
      LOC_GUARD: '경비대 지구',
      LOC_HARBOR: '항만 부두',
      LOC_SLUMS: '빈민가',
    };
    const locName = locationNames[locationId] ?? locationId;
    // 핵심 행동+결과 요약 (행동 라인)
    const summaryLines = visitTurns.map((t) => {
      const sr = t.serverResult as ServerResultV1 | null;
      const outcome = (sr?.ui as Record<string, unknown>)?.resolveOutcome as string | undefined;
      const outcomeText = outcome === 'SUCCESS' ? '성공' : outcome === 'PARTIAL' ? '부분 성공' : outcome === 'FAIL' ? '실패' : '';
      const outcomePart = outcomeText ? `(${outcomeText})` : '';
      // 이벤트 sceneFrame → 어떤 상황이었는지 보존
      const sceneFrame = (sr?.summary?.short as string) ?? '';
      const scenePart = sceneFrame ? ` [${sceneFrame.slice(0, 60)}]` : '';
      return `"${t.rawInput}"${outcomePart}${scenePart}`;
    });

    // NPC 이름 추출: LLM 서술에서 콘텐츠 NPC 이름 매칭
    const allNpcs = this.content.getAllNpcs();
    const mentionedNpcs = new Set<string>();
    for (const t of visitTurns) {
      if (t.llmOutput) {
        for (const npc of allNpcs) {
          if (t.llmOutput.includes(npc.name)) {
            mentionedNpcs.add(npc.name);
          }
        }
      }
    }
    const npcPart = mentionedNpcs.size > 0 ? ` 만난 인물: ${[...mentionedNpcs].join(', ')}.` : '';

    const visitSummary = `[${locName} 방문]${npcPart} ${summaryLines.join('; ')}`.slice(0, 600);

    // run_memories.storySummary에 추가
    const existing = await this.db.query.runMemories.findFirst({
      where: eq(runMemories.runId, runId),
    });

    if (existing) {
      const currentSummary = existing.storySummary ?? '';
      // 기존 요약에 방문 기록 추가 (최대 3000자 유지)
      let newSummary = currentSummary
        ? `${currentSummary}\n${visitSummary}`
        : visitSummary;
      if (newSummary.length > 3000) {
        // 오래된 방문 기록부터 잘라냄 (앞부분 삭제)
        newSummary = '...' + newSummary.slice(newSummary.length - 2997);
      }
      await this.db
        .update(runMemories)
        .set({ storySummary: newSummary, updatedAt: new Date() })
        .where(eq(runMemories.runId, runId));
    }
    // run_memories가 없으면 LLM Worker가 아직 생성 전 — 스킵 (다음 방문 시 저장)
  }

  /** LOCATION→LOCATION 직접 이동 (HUB 경유 없이) */
  private async performLocationTransition(
    run: any, currentNode: any, turnNo: number, body: SubmitTurnBody,
    rawInput: string, runState: RunState, ws: WorldState, arcState: ArcState,
    fromLocationId: string, toLocationId: string,
  ) {
    const updatedRunState: RunState = { ...runState };

    // Structured Memory v2: 방문 종료 통합
    const locMemTransition = await this.memoryIntegration.finalizeVisit(run.id, currentNode.id, runState, turnNo);
    if (locMemTransition) updatedRunState.locationMemories = locMemTransition;

    // WorldState 업데이트
    const newWs = this.worldStateService.moveToLocation(ws, toLocationId);
    updatedRunState.worldState = newWs;
    updatedRunState.actionHistory = []; // 이동 시 고집 이력 초기화

    // 현재 노드 종료
    await this.db.update(nodeInstances)
      .set({ status: 'NODE_ENDED', updatedAt: new Date() })
      .where(eq(nodeInstances.id, currentNode.id));

    // 이동 턴 커밋
    const locationNames: Record<string, string> = {
      LOC_MARKET: '시장 거리', LOC_GUARD: '경비대 지구',
      LOC_HARBOR: '항만 부두', LOC_SLUMS: '빈민가',
      LOC_NOBLE: '상류 거리', LOC_TAVERN: '잠긴 닻 선술집',
      LOC_DOCKS_WAREHOUSE: '항만 창고구',
    };
    const toName = locationNames[toLocationId] ?? toLocationId;
    const moveResult = this.buildSystemResult(turnNo, currentNode, `${toName}(으)로 향한다.`);
    await this.commitTurnRecord(run, currentNode, turnNo, body, rawInput, moveResult, updatedRunState, body.options?.skipLlm);

    // 새 LOCATION 노드 생성
    const transition = await this.nodeTransition.transitionToLocation(
      run.id, currentNode.nodeIndex, turnNo + 1, toLocationId,
      updatedRunState.worldState!, updatedRunState,
    );

    // 전환 턴 생성
    transition.enterResult.turnNo = turnNo + 1;
    await this.db.insert(turns).values({
      runId: run.id, turnNo: turnNo + 1, nodeInstanceId: transition.enterResult.node.id,
      nodeType: 'LOCATION', inputType: 'SYSTEM', rawInput: '',
      idempotencyKey: `${run.id}_loc_${transition.nextNodeIndex}`,
      parsedBy: null, confidence: null, parsedIntent: null,
      policyResult: 'ALLOW', transformedIntent: null, actionPlan: null,
      serverResult: transition.enterResult, llmStatus: 'PENDING',
    });

    await this.db.update(runSessions).set({
      currentTurnNo: turnNo + 1, runState: updatedRunState, updatedAt: new Date(),
    }).where(eq(runSessions.id, run.id));

    return {
      accepted: true, turnNo, serverResult: moveResult,
      llm: { status: 'PENDING' as LlmStatus, narrative: null },
      meta: { nodeOutcome: 'NODE_ENDED', policyResult: 'ALLOW' },
      transition: {
        nextNodeIndex: transition.nextNodeIndex,
        nextNodeType: transition.nextNodeType,
        enterResult: transition.enterResult,
        battleState: null,
        enterTurnNo: turnNo + 1,
      },
    };
  }

  /**
   * Phase 4a: EQUIP/UNEQUIP 처리 — 장비 착용/해제 (주사위 판정 없음)
   * - EQUIP: equipmentBag에서 아이템을 equipped 슬롯에 장착
   * - UNEQUIP: equipped에서 equipmentBag으로 이동
   * - 입력 텍스트 또는 choiceId에서 대상 아이템/슬롯 추출
   */
  private async handleEquipAction(
    run: any,
    currentNode: any,
    turnNo: number,
    body: any,
    rawInput: string,
    runState: RunState,
    intent: any,
  ) {
    const equipped = runState.equipped ?? {};
    const equipmentBag = [...(runState.equipmentBag ?? [])];

    let summaryText = '';
    const events: any[] = [];

    if (intent.actionType === 'EQUIP') {
      // 대상 아이템 탐색: choiceId(instanceId)로 먼저, 없으면 텍스트 매칭
      const targetInstanceId = body.input.choiceId ?? null;
      let targetInstance = targetInstanceId
        ? equipmentBag.find((i) => i.instanceId === targetInstanceId)
        : null;

      // 텍스트 매칭: displayName 또는 baseItemId 일부 매칭
      if (!targetInstance) {
        const normalized = rawInput.toLowerCase();
        targetInstance = equipmentBag.find((i) =>
          normalized.includes(i.displayName.toLowerCase()) ||
          normalized.includes((this.content.getItem(i.baseItemId)?.name ?? '').toLowerCase()),
        );
      }

      if (!targetInstance) {
        // 가방에 장비가 있으면 첫 번째 아이템 자동 선택
        if (equipmentBag.length > 0) {
          targetInstance = equipmentBag[0];
        } else {
          const result = this.buildSystemResult(turnNo, currentNode, '장착할 장비가 가방에 없다.');
          await this.commitTurnRecord(run, currentNode, turnNo, body, rawInput, result, runState, true);
          return {
            accepted: true, turnNo, serverResult: result,
            llm: { status: 'SKIPPED' as LlmStatus, narrative: null },
            meta: { nodeOutcome: 'ONGOING', policyResult: 'ALLOW' },
          };
        }
      }

      // 장비 착용
      const { equipped: newEquipped, unequippedInstance } = this.equipmentService.equip(equipped, targetInstance);
      const updatedBag = equipmentBag.filter((i) => i.instanceId !== targetInstance!.instanceId);
      if (unequippedInstance) {
        updatedBag.push(unequippedInstance);
      }

      runState.equipped = newEquipped;
      runState.equipmentBag = updatedBag;
      summaryText = `${targetInstance.displayName}을(를) 장착했다.`;
      if (unequippedInstance) {
        summaryText += ` (${unequippedInstance.displayName} 해제)`;
      }
      events.push({
        id: `equip_${turnNo}`,
        kind: 'SYSTEM',
        text: `[장비] ${summaryText}`,
        tags: ['EQUIP'],
        data: { equipped: targetInstance.baseItemId, unequipped: unequippedInstance?.baseItemId },
      });
    } else {
      // UNEQUIP: 슬롯 이름 또는 아이템 이름으로 대상 탐색
      const { EQUIPMENT_SLOTS } = await import('../db/types/equipment.js');
      const normalized = rawInput.toLowerCase();
      let targetSlot: string | null = null;

      // 슬롯 이름 매칭
      const slotKeywords: Record<string, string[]> = {
        WEAPON: ['무기', '검', '칼', '단검', '만도', '단도'],
        ARMOR: ['갑옷', '방어구', '조끼', '망토', '경갑'],
        TACTICAL: ['전술', '장화', '부츠', '고글', '장비'],
        POLITICAL: ['정치', '원장', '반지', '봉인', '인장'],
        RELIC: ['유물', '나침반', '렐릭'],
      };
      for (const [slot, keywords] of Object.entries(slotKeywords)) {
        if (keywords.some((kw) => normalized.includes(kw)) && equipped[slot as keyof typeof equipped]) {
          targetSlot = slot;
          break;
        }
      }

      // 아이템 이름 매칭
      if (!targetSlot) {
        for (const slot of EQUIPMENT_SLOTS) {
          const instance = equipped[slot];
          if (!instance) continue;
          if (normalized.includes(instance.displayName.toLowerCase()) ||
              normalized.includes((this.content.getItem(instance.baseItemId)?.name ?? '').toLowerCase())) {
            targetSlot = slot;
            break;
          }
        }
      }

      if (!targetSlot) {
        const result = this.buildSystemResult(turnNo, currentNode, '해제할 장비를 특정할 수 없다.');
        await this.commitTurnRecord(run, currentNode, turnNo, body, rawInput, result, runState, true);
        return {
          accepted: true, turnNo, serverResult: result,
          llm: { status: 'SKIPPED' as LlmStatus, narrative: null },
          meta: { nodeOutcome: 'ONGOING', policyResult: 'ALLOW' },
        };
      }

      const { equipped: newEquipped, unequippedInstance } = this.equipmentService.unequip(
        equipped, targetSlot as import('../db/types/equipment.js').EquipmentSlot,
      );
      if (unequippedInstance) {
        equipmentBag.push(unequippedInstance);
      }
      runState.equipped = newEquipped;
      runState.equipmentBag = equipmentBag;
      summaryText = unequippedInstance
        ? `${unequippedInstance.displayName}을(를) 해제했다.`
        : '해제할 장비가 없다.';
      if (unequippedInstance) {
        events.push({
          id: `unequip_${turnNo}`,
          kind: 'SYSTEM',
          text: `[장비] ${summaryText}`,
          tags: ['UNEQUIP'],
          data: { unequipped: unequippedInstance.baseItemId, slot: targetSlot },
        });
      }
    }

    const result = this.buildSystemResult(turnNo, currentNode, summaryText);
    result.events = events;
    await this.commitTurnRecord(run, currentNode, turnNo, body, rawInput, result, runState, body.options?.skipLlm);
    await this.db.update(runSessions).set({ runState, updatedAt: new Date() }).where(eq(runSessions.id, run.id));

    return {
      accepted: true, turnNo, serverResult: result,
      llm: { status: (body.options?.skipLlm ? 'SKIPPED' : 'PENDING') as LlmStatus, narrative: null },
      meta: { nodeOutcome: 'ONGOING', policyResult: 'ALLOW' },
    };
  }

  /** 자유 텍스트에서 목표 위치 추출 */
  private extractTargetLocation(input: string, currentLocationId: string): string | null {
    const normalized = input.toLowerCase();
    const locationKeywords: Array<{ keywords: string[]; locationId: string }> = [
      {
        keywords: [
          '시장', '상점가', '장터', '노점가', '노점', '좌판거리',
          '상인들이 모인', '물건 파는',
        ],
        locationId: 'LOC_MARKET',
      },
      {
        keywords: [
          '경비대', '경비', '초소', '병영', '수비대', '순찰대',
          '경비병', '병사들', '관청',
        ],
        locationId: 'LOC_GUARD',
      },
      {
        keywords: [
          '항만', '부두', '항구', '선착장', '포구', '배터',
          '창고가', '선박', '정박', '바닷가',
        ],
        locationId: 'LOC_HARBOR',
      },
      {
        keywords: [
          '빈민가', '빈민', '슬럼', '뒷골목', '하층가', '빈민굴',
          '어두운 골목', '허름한 골목',
        ],
        locationId: 'LOC_SLUMS',
      },
      {
        keywords: [
          '귀족', '상류', '저택', '귀족가', '귀족 거리', '정원',
          '의회', '노블',
        ],
        locationId: 'LOC_NOBLE',
      },
      {
        keywords: [
          '선술집', '잠긴 닻', '숙소', '주점', '술집',
          '거점',
        ],
        locationId: 'LOC_TAVERN',
      },
      {
        keywords: [
          '창고', '창고구', '창고 지구', '물류', '하역장',
          '화물 창고',
        ],
        locationId: 'LOC_DOCKS_WAREHOUSE',
      },
      {
        keywords: [
          '거점', '본거지', '돌아가',
        ],
        locationId: 'LOC_TAVERN',
      },
    ];
    for (const entry of locationKeywords) {
      for (const kw of entry.keywords) {
        if (normalized.includes(kw)) return entry.locationId;
      }
    }
    return null;
  }

  /** 고집(insistence) 카운트: 같은 actionType 연속 반복 횟수 + 반복 타입 반환 */
  private calculateInsistenceCount(
    history: Array<{ actionType: string; suppressedActionType?: string; inputText: string }>,
  ): { count: number; repeatedType: string | null } {
    if (history.length === 0) return { count: 0, repeatedType: null };
    const lastType = history[history.length - 1].actionType;
    let count = 0;
    for (let i = history.length - 1; i >= 0; i--) {
      if (history[i].actionType === lastType) {
        count++;
      } else {
        break;
      }
    }
    return { count, repeatedType: lastType };
  }

  /** IntentActionType → 한국어 라벨 (summary.short용) */
  private actionTypeToKorean(actionType: string): string {
    const map: Record<string, string> = {
      INVESTIGATE: '조사', PERSUADE: '설득', SNEAK: '은밀 행동', BRIBE: '뇌물',
      THREATEN: '위협', HELP: '도움', STEAL: '절도', FIGHT: '전투',
      OBSERVE: '관찰', TRADE: '거래', TALK: '대화', SEARCH: '탐색',
      MOVE_LOCATION: '이동', REST: '휴식', SHOP: '상점 이용',
    };
    return map[actionType] ?? actionType;
  }

  private buildLocationResult(
    turnNo: number, node: any, text: string, outcome: string,
    choices: ServerResultV1['choices'], ws: WorldState,
    actionContext?: { parsedType: string; originalInput: string; tone: string; escalated?: boolean; insistenceCount?: number; eventSceneFrame?: string; eventMatchPolicy?: string; eventId?: string; primaryNpcId?: string | null; goalCategory?: string; approachVector?: string; goalText?: string },
    hideResolve?: boolean,
    goldDelta?: number,
    itemsAdded?: import('../db/types/index.js').ItemStack[],
    resolveBreakdown?: import('../db/types/index.js').ResolveBreakdown,
    equipmentAdded?: import('../db/types/equipment.js').ItemInstance[],
  ): ServerResultV1 {
    const base = this.buildSystemResult(turnNo, node, text);
    if (goldDelta && goldDelta !== 0) {
      base.diff.inventory.goldDelta = goldDelta;
    }
    if (itemsAdded && itemsAdded.length > 0) {
      base.diff.inventory.itemsAdded = itemsAdded;
    }
    if (equipmentAdded && equipmentAdded.length > 0) {
      base.diff.equipmentAdded = equipmentAdded;
    }
    return {
      ...base,
      // 내러티브 텍스트는 summary(NARRATOR)에만 — SYSTEM 이벤트로 표시하지 않음
      events: [],
      ui: {
        availableActions: ['ACTION', 'CHOICE'], targetLabels: [],
        actionSlots: { base: 2, bonusAvailable: false, max: 3 },
        toneHint: outcome === 'FAIL' ? 'danger' : outcome === 'SUCCESS' ? 'triumph' : 'neutral',
        worldState: { hubHeat: ws.hubHeat, hubSafety: ws.hubSafety, timePhase: ws.timePhase, currentLocationId: ws.currentLocationId, locationDynamicStates: ws.locationDynamicStates ?? {}, playerGoals: (ws.playerGoals ?? []).filter((g) => !g.completed), reputation: ws.reputation ?? {} },
        // 비도전 행위는 주사위 UI를 표시하지 않음
        ...(hideResolve ? {} : { resolveOutcome: outcome as any }),
        ...(resolveBreakdown ? { resolveBreakdown } : {}),
        ...(actionContext ? { actionContext } : {}),
      },
      choices,
    };
  }

  private buildDenyResult(turnNo: number, node: any, reason: string): ServerResultV1 {
    return {
      ...this.buildSystemResult(turnNo, node, reason),
      events: [{ id: `deny_${turnNo}`, kind: 'SYSTEM', text: reason, tags: ['POLICY_DENY'] }],
    };
  }

  // --- 전투 CHOICE 매핑 (기존 재사용) ---
  private mapCombatChoiceToActionPlan(choiceId: string): ActionPlan {
    if (choiceId.startsWith('combo_')) return this.parseComboChoiceToActionPlan(choiceId);
    if (choiceId === 'env_action') return { units: [{ type: 'INTERACT', meta: { envAction: true } }], consumedSlots: { base: 2, used: 1, bonusUsed: false }, staminaCost: 1, policyResult: 'ALLOW', parsedBy: 'RULE' };
    if (choiceId === 'combat_avoid') return { units: [{ type: 'FLEE', meta: { isAvoid: true } }], consumedSlots: { base: 2, used: 1, bonusUsed: false }, staminaCost: 1, policyResult: 'ALLOW', parsedBy: 'RULE' };
    const unit = this.parseCombatChoiceId(choiceId);
    return { units: [unit], consumedSlots: { base: 2, used: 1, bonusUsed: false }, staminaCost: 1, policyResult: 'ALLOW', parsedBy: 'RULE' };
  }

  private parseComboChoiceToActionPlan(choiceId: string): ActionPlan {
    if (choiceId.startsWith('combo_double_attack_')) {
      const targetId = choiceId.replace('combo_double_attack_', '');
      return { units: [{ type: 'ATTACK_MELEE', targetId }, { type: 'ATTACK_MELEE', targetId }], consumedSlots: { base: 2, used: 2, bonusUsed: false }, staminaCost: 2, policyResult: 'ALLOW', parsedBy: 'RULE' };
    }
    if (choiceId.startsWith('combo_attack_defend_')) {
      const targetId = choiceId.replace('combo_attack_defend_', '');
      return { units: [{ type: 'ATTACK_MELEE', targetId }, { type: 'DEFEND' }], consumedSlots: { base: 2, used: 2, bonusUsed: false }, staminaCost: 2, policyResult: 'ALLOW', parsedBy: 'RULE' };
    }
    return { units: [{ type: 'DEFEND' }], consumedSlots: { base: 2, used: 1, bonusUsed: false }, staminaCost: 1, policyResult: 'ALLOW', parsedBy: 'RULE' };
  }

  private parseCombatChoiceId(choiceId: string): import('../db/types/index.js').ActionUnit {
    if (choiceId.startsWith('attack_melee_')) return { type: 'ATTACK_MELEE', targetId: choiceId.replace('attack_melee_', '') };
    if (choiceId === 'defend') return { type: 'DEFEND' };
    if (choiceId === 'evade') return { type: 'EVADE' };
    if (choiceId === 'flee') return { type: 'FLEE' };
    if (choiceId === 'move_forward') return { type: 'MOVE', direction: 'FORWARD' };
    if (choiceId === 'move_back') return { type: 'MOVE', direction: 'BACK' };
    if (choiceId.startsWith('use_item_')) return { type: 'USE_ITEM', meta: { itemHint: choiceId.replace('use_item_', '') } };
    return { type: 'DEFEND' };
  }

  async getTurnDetail(runId: string, turnNo: number, userId: string, query: GetTurnQuery) {
    const run = await this.db.query.runSessions.findFirst({ where: eq(runSessions.id, runId) });
    if (!run) throw new NotFoundError('Run not found');
    if (run.userId !== userId) throw new ForbiddenError('Not your run');

    const turn = await this.db.query.turns.findFirst({
      where: and(eq(turns.runId, runId), eq(turns.turnNo, turnNo)),
    });
    if (!turn) throw new NotFoundError('Turn not found');

    const response: Record<string, unknown> = {
      run: { id: run.id, status: run.status, actLevel: run.actLevel, currentTurnNo: run.currentTurnNo },
      turn: { turnNo: turn.turnNo, nodeInstanceId: turn.nodeInstanceId, nodeType: turn.nodeType, inputType: turn.inputType, rawInput: turn.rawInput, createdAt: turn.createdAt },
      serverResult: turn.serverResult,
      llm: { status: turn.llmStatus, output: turn.llmOutput, modelUsed: turn.llmModelUsed, completedAt: turn.llmCompletedAt, error: turn.llmError, tokenStats: turn.llmTokenStats ?? null, choices: turn.llmChoices ?? null },
    };

    if (query.includeDebug) {
      response.debug = {
        parsedBy: turn.parsedBy, parseConfidence: turn.confidence,
        parsedIntent: turn.parsedIntent, policyResult: turn.policyResult,
        actionPlan: turn.actionPlan, idempotencyKey: turn.idempotencyKey,
      };
    }

    return response;
  }

  /**
   * LLM 재시도 — FAILED 상태의 턴을 PENDING으로 리셋하여 Worker가 다시 처리하도록 한다.
   */
  async retryLlm(runId: string, turnNo: number, userId: string) {
    const run = await this.db.query.runSessions.findFirst({ where: eq(runSessions.id, runId) });
    if (!run) throw new NotFoundError('Run not found');
    if (run.userId !== userId) throw new ForbiddenError('Not your run');

    const turn = await this.db.query.turns.findFirst({
      where: and(eq(turns.runId, runId), eq(turns.turnNo, turnNo)),
    });
    if (!turn) throw new NotFoundError('Turn not found');

    if (turn.llmStatus !== 'FAILED') {
      throw new InvalidInputError(`Cannot retry: current LLM status is ${turn.llmStatus}`);
    }

    // FAILED → PENDING 리셋
    await this.db
      .update(turns)
      .set({
        llmStatus: 'PENDING',
        llmError: null,
        llmLockedAt: null,
        llmLockOwner: null,
      })
      .where(eq(turns.id, turn.id));

    return { success: true, turnNo, llmStatus: 'PENDING' };
  }

  /**
   * 런 전체 턴의 LLM 토큰 사용량 집계
   */
  async getLlmUsage(runId: string, userId: string) {
    const run = await this.db.query.runSessions.findFirst({ where: eq(runSessions.id, runId) });
    if (!run) throw new NotFoundError('Run not found');
    if (run.userId !== userId) throw new ForbiddenError('Not your run');

    const allTurns = await this.db
      .select({
        turnNo: turns.turnNo,
        llmModelUsed: turns.llmModelUsed,
        llmTokenStats: turns.llmTokenStats,
      })
      .from(turns)
      .where(eq(turns.runId, runId))
      .orderBy(asc(turns.turnNo));

    const usageTurns: Array<{
      turnNo: number;
      model: string | null;
      prompt: number;
      cached: number;
      completion: number;
      latencyMs: number;
    }> = [];

    let totalPrompt = 0;
    let totalCached = 0;
    let totalCompletion = 0;

    for (const t of allTurns) {
      if (!t.llmTokenStats) continue;
      const stats = t.llmTokenStats;
      usageTurns.push({
        turnNo: t.turnNo,
        model: t.llmModelUsed,
        prompt: stats.prompt,
        cached: stats.cached,
        completion: stats.completion,
        latencyMs: stats.latencyMs,
      });
      totalPrompt += stats.prompt;
      totalCached += stats.cached;
      totalCompletion += stats.completion;
    }

    return {
      turns: usageTurns,
      totals: {
        prompt: totalPrompt,
        cached: totalCached,
        completion: totalCompletion,
        turns: usageTurns.length,
      },
    };
  }
}
