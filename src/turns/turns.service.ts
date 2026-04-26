/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-call, @typescript-eslint/restrict-template-expressions, @typescript-eslint/no-base-to-string, @typescript-eslint/no-require-imports */
// 정본: specs/HUB_system.md — Action-First 턴 파이프라인
// Player-First Event Engine: 이벤트가 유저를 끌고가지 않고, 유저가 게임을 끌고간다

/** LOCATION 턴 모드 — 이벤트 매칭 전에 결정되어 파이프라인을 분기 */
enum TurnMode {
  /** 플레이어가 NPC/행동을 명시 → 이벤트 매칭 스킵, NPC 직접 상호작용 */
  PLAYER_DIRECTED = 'PLAYER_DIRECTED',
  /** 대화 연속 중 → 이벤트 매칭 스킵, 같은 NPC 유지 */
  CONVERSATION_CONT = 'CONVERSATION_CONT',
  /** 세계 이벤트 트리거 → 기존 이벤트 매칭 파이프라인 */
  WORLD_EVENT = 'WORLD_EVENT',
}

import { NPC_PORTRAITS } from '../db/types/npc-portraits.js';

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
import {
  DEFAULT_PERMANENT_STATS,
  deriveCombatStats,
} from '../db/types/index.js';
import type {
  BattleStateV1,
  ServerResultV1,
  ActionPlan,
  ParsedIntent,
  PermanentStats,
  RunState,
  WorldState,
  ArcState,
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
import { PropMatcherService } from '../engine/combat/prop-matcher.service.js';
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
import { LlmCallerService } from '../llm/llm-caller.service.js';
import { TurnOrchestrationService } from '../engine/hub/turn-orchestration.service.js';
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
import {
  EndingGeneratorService,
  MIN_TURNS_FOR_NATURAL,
} from '../engine/hub/ending-generator.service.js';
import { SummaryBuilderService } from '../engine/hub/summary-builder.service.js';
import {
  MemoryCollectorService,
  TAG_TO_NPC,
} from '../engine/hub/memory-collector.service.js';
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
import {
  NanoEventDirectorService,
  type NanoEventResult,
  type NanoEventContext,
} from '../llm/nano-event-director.service.js';
import type { RegionEconomy } from '../db/types/region-state.js';
import { CampaignsService } from '../campaigns/campaigns.service.js';
import {
  initNPCState,
  getNpcDisplayName,
  isNameRevealed,
  shouldIntroduce,
  resolveNpcPlaceholders,
  recordNpcEncounter,
  addNpcKnownFact,
  buildNpcLlmSummary,
  buildTopicEntry,
  addRecentTopic,
} from '../db/types/npc-state.js';
import type {
  IncidentDef,
  IncidentRuntime,
  NarrativeMarkCondition,
  NPCState,
  NpcEmotionalState,
} from '../db/types/index.js';
import type {
  IncidentSummaryUI,
  SignalFeedItemUI,
  NpcEmotionalUI,
} from '../db/types/server-result.js';
import type { SubmitTurnBody, GetTurnQuery } from './dto/submit-turn.dto.js';

/** 한국어 조사 자동 판별 — 받침 유무에 따라 을/를, 이/가 등 선택 */
function korParticle(
  word: string,
  withBatchim: string,
  withoutBatchim: string,
): string {
  if (!word) return withBatchim;
  const last = word.charCodeAt(word.length - 1);
  if (last < 0xac00 || last > 0xd7a3) return withBatchim;
  return (last - 0xac00) % 28 !== 0 ? withBatchim : withoutBatchim;
}

@Injectable()
export class TurnsService {
  private readonly logger = new Logger(TurnsService.name);

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
    // Journey Archive Phase 1
    private readonly summaryBuilder: SummaryBuilderService,
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
    @Optional()
    private readonly consequenceProcessor?: ConsequenceProcessorService,
    @Optional() private readonly playerGoalService?: PlayerGoalService,
    @Optional() private readonly questProgression?: QuestProgressionService,
    @Optional() private readonly nanoEventDirector?: NanoEventDirectorService,
    @Optional() private readonly llmCaller?: LlmCallerService,
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
        this.logger.log(
          `Campaign scenario result saved: campaign=${run.campaignId}, run=${runId}`,
        );
      }
    } catch (err) {
      // 캠페인 결과 저장 실패는 게임 종료에 영향 없음
      this.logger.warn(
        `Failed to save campaign scenario result for run ${runId}: ${(err as Error).message}`,
      );
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
    if (run.status !== 'RUN_ACTIVE')
      throw new InvalidInputError('Run is not active');

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
    const playerStats = deriveCombatStats(
      profile?.permanentStats ?? DEFAULT_PERMANENT_STATS,
    );

    const runState = run.runState ?? {
      gold: 0,
      hp: playerStats.maxHP,
      maxHp: playerStats.maxHP,
      stamina: playerStats.maxStamina,
      maxStamina: playerStats.maxStamina,
      inventory: [],
    };

    // 노드 타입에 따라 분기
    const nodeType = currentNode.nodeType;

    if (nodeType === 'HUB') {
      return this.handleHubTurn(
        run,
        currentNode,
        expectedTurnNo,
        body,
        runState,
        playerStats,
      );
    } else if (nodeType === 'LOCATION') {
      return this.handleLocationTurn(
        run,
        currentNode,
        expectedTurnNo,
        body,
        runState,
        playerStats,
      );
    } else if (nodeType === 'COMBAT') {
      return this.handleCombatTurn(
        run,
        currentNode,
        expectedTurnNo,
        body,
        runState,
        playerStats,
      );
    } else if (
      run.currentGraphNodeId &&
      (nodeType === 'EVENT' ||
        nodeType === 'REST' ||
        nodeType === 'SHOP' ||
        nodeType === 'EXIT')
    ) {
      return this.handleDagNodeTurn(
        run,
        currentNode,
        expectedTurnNo,
        body,
        runState,
        playerStats,
      );
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
    _playerStats: PermanentStats,
  ) {
    if (body.input.type !== 'CHOICE' || !body.input.choiceId) {
      throw new InvalidInputError('HUB requires CHOICE input');
    }

    const ws = runState.worldState ?? this.worldStateService.initWorldState();
    const arcState = runState.arcState ?? this.arcService.initArcState();
    const _agenda = runState.agenda ?? this.agendaService.initAgenda();
    const updatedRunState: RunState = { ...runState };

    // pendingQuestHint 만료 정리 (HUB 턴에서도 실행): 발견 다음 턴 1회만 전달
    if (
      updatedRunState.pendingQuestHint &&
      updatedRunState.pendingQuestHint.setAtTurn < turnNo
    ) {
      updatedRunState.pendingQuestHint = null;
    }

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
      const hubResult = this.buildSystemResult(
        turnNo,
        currentNode,
        `${locName}(으)로 향한다.`,
      );
      await this.commitTurnRecord(
        run,
        currentNode,
        turnNo,
        body,
        choiceId,
        hubResult,
        updatedRunState,
        body.options?.skipLlm,
      );

      // LOCATION 전환
      const transition = await this.nodeTransition.transitionToLocation(
        run.id,
        currentNode.nodeIndex,
        turnNo + 1,
        locationId,
        updatedRunState.worldState,
        updatedRunState,
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

      return {
        accepted: true,
        turnNo,
        serverResult: hubResult,
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
      const bestNpc = Object.entries(relations).sort(
        ([, a], [, b]) => b - a,
      )[0];
      if (bestNpc) {
        const { ws: newWs } = this.heatService.resolveByAlly(
          ws,
          bestNpc[0],
          relations,
        );
        updatedRunState.worldState =
          this.worldStateService.updateHubSafety(newWs);
      }
      const hubChoices = this.sceneShellService.buildHubChoices(
        updatedRunState.worldState!,
        arcState,
      );
      const result = this.buildHubActionResult(
        turnNo,
        currentNode,
        '협력자에게 연락하여 열기를 식혔다.',
        hubChoices,
        updatedRunState.worldState!,
      );

      await this.commitTurnRecord(
        run,
        currentNode,
        turnNo,
        body,
        choiceId,
        result,
        updatedRunState,
        body.options?.skipLlm,
      );
      return {
        accepted: true,
        turnNo,
        serverResult: result,
        llm: { status: 'PENDING' as LlmStatus, narrative: null },
        meta: { nodeOutcome: 'ONGOING', policyResult: 'ALLOW' },
      };
    }

    // Heat 해결: PAY_COST
    if (choiceId === 'pay_cost') {
      const usageCount = 0; // TODO: track usage
      const { cost, ws: newWs } = this.heatService.resolveByCost(
        ws,
        usageCount,
      );
      if (runState.gold >= cost) {
        updatedRunState.gold -= cost;
        updatedRunState.worldState =
          this.worldStateService.updateHubSafety(newWs);
      }
      const hubChoices = this.sceneShellService.buildHubChoices(
        updatedRunState.worldState!,
        arcState,
      );
      const result = this.buildHubActionResult(
        turnNo,
        currentNode,
        `금화 ${cost}으로 열기를 해소했다.`,
        hubChoices,
        updatedRunState.worldState!,
      );

      await this.commitTurnRecord(
        run,
        currentNode,
        turnNo,
        body,
        choiceId,
        result,
        updatedRunState,
        body.options?.skipLlm,
      );
      return {
        accepted: true,
        turnNo,
        serverResult: result,
        llm: { status: 'PENDING' as LlmStatus, narrative: null },
        meta: { nodeOutcome: 'ONGOING', policyResult: 'ALLOW' },
      };
    }

    // 프롤로그 의뢰 수락
    if (choiceId === 'accept_quest') {
      const hubChoices = this.sceneShellService.buildHubChoices(ws, arcState);
      const result: ServerResultV1 = {
        ...this.buildSystemResult(turnNo, currentNode, '의뢰를 수락했다.'),
        summary: {
          short: [
            '[상황] 당신은 로넨의 의뢰를 수락했다. 사라진 공물 장부를 찾기로 했다.',
            '[NPC] 서기관 로넨 — 항만 노동 길드 말단 서기관. ⚠️ 말투: 합쇼체("~습니다", "~입니다", "~십시오"). 예: "감사합니다", "은혜를 잊지 않겠습니다".',
            '[서술 지시] 150~300자. 의뢰 수락 장면을 서술하세요.',
            '- 당신이 수락의 의사를 행동(고개 끄덕임, 잔을 내려놓음, 몸을 일으킴 등)으로 표현하는 장면을 묘사하세요.',
            '- 로넨이 안도하며 짧게 감사를 표한다. 반드시 합쇼체로 말한다. 예: "감사합니다", "은혜를 잊지 않겠습니다".',
            '- 로넨의 @마커: @[로넨|/npc-portraits/ronen.webp] "대사" 형태로 작성하세요. 다른 NPC 마커를 사용하지 마세요.',
            '- 선술집을 나서며 밤의 그레이마르 거리를 바라보는 것으로 마무리하세요. 어디로 갈지는 언급하지 마세요.',
            '- 당신의 내면("결심한다", "다짐한다")을 쓰지 마세요. 행동만 묘사하세요.',
          ].join('\n'),
          display:
            '당신은 고개를 끄덕이며 의뢰를 수락했다. 서기관 로넨이 안도의 한숨을 내쉬었다. "감사합니다… 은혜를 잊지 않겠습니다." 당신은 선술집을 나서 밤의 그레이마르 거리를 바라보았다.',
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

      // HUB accept_quest: speakingNpc를 로넨으로 고정 (LLM이 다른 NPC로 마킹 방지)
      (result.ui as any).speakingNpc = {
        npcId: 'NPC_RONEN',
        displayName: '로넨',
        imageUrl: '/npc-portraits/ronen.webp',
      };

      await this.commitTurnRecord(
        run,
        currentNode,
        turnNo,
        body,
        choiceId,
        result,
        updatedRunState,
      );
      return {
        accepted: true,
        turnNo,
        serverResult: result,
        llm: { status: 'PENDING' as LlmStatus, narrative: null },
        meta: { nodeOutcome: 'ONGOING', policyResult: 'ALLOW' },
      };
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
      const result = this.buildSystemResult(
        turnNo,
        currentNode,
        '더 이상 버틸 수 없다...',
      );
      let endingSummaryHp: ReturnType<
        SummaryBuilderService['buildEndingSummary']
      > | null = null;
      try {
        const ws =
          runState.worldState ?? this.worldStateService.initWorldState();
        const endingThreads = (ws.playerThreads ?? []).map((t) => ({
          approachVector: t.approachVector,
          goalCategory: t.goalCategory,
          actionCount: t.actionCount,
          successCount: t.successCount,
          status: t.status,
        }));
        const endingInput = this.endingGenerator.gatherEndingInputs(
          ws.activeIncidents ?? [],
          runState.npcStates ?? {},
          ws.narrativeMarks ?? [],
          ws as unknown as Record<string, unknown>,
          runState.arcState ?? null,
          runState.actionHistory ?? [],
          endingThreads,
        );
        const endingResult = this.endingGenerator.generateEnding(
          endingInput,
          'DEFEAT',
          turnNo,
        );
        (result.ui as any).endingResult = endingResult;
        result.events.push({
          id: `ending_${turnNo}`,
          kind: 'SYSTEM',
          text: `[엔딩] ${endingResult.closingLine}`,
          tags: ['RUN_ENDED'],
          data: { endingResult },
        });
        // Journey Archive: summary 조립
        try {
          endingSummaryHp = this.summaryBuilder.buildEndingSummary(
            {
              id: run.id,
              presetId: run.presetId ?? null,
              gender: (run.gender as 'male' | 'female' | null) ?? null,
              updatedAt: new Date(),
              currentTurnNo: turnNo,
            },
            runState,
            endingResult,
          );
        } catch (se) {
          this.logger.warn(
            `EndingSummary build failed (HP<=0) runId=${run.id}: ${String(se)}`,
          );
        }
      } catch (e) {
        this.logger.warn(`HP≤0 DEFEAT ending generation failed: ${e}`);
      }

      await this.db
        .update(runSessions)
        .set({
          status: 'RUN_ENDED',
          updatedAt: new Date(),
          ...(endingSummaryHp ? { endingSummary: endingSummaryHp } : {}),
        })
        .where(eq(runSessions.id, run.id));

      // Campaign: 시나리오 결과 저장
      await this.saveCampaignResultIfNeeded(run.id);

      await this.commitTurnRecord(
        run,
        currentNode,
        turnNo,
        body,
        '',
        result,
        runState,
      );

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
    const locationId =
      ws.currentLocationId ?? currentNode.nodeMeta?.locationId ?? 'LOC_MARKET';
    const updatedRunState: RunState = { ...runState };

    // go_hub 선택 시 → HUB 복귀
    if (body.input.type === 'CHOICE' && body.input.choiceId === 'go_hub') {
      // Structured Memory v2: 방문 종료 통합 (기존 saveLocationVisitSummary 역할 포함)
      const locMemUpdate = await this.memoryIntegration.finalizeVisit(
        run.id,
        currentNode.id,
        runState,
        turnNo,
      );
      if (locMemUpdate) updatedRunState.locationMemories = locMemUpdate;

      ws = this.worldStateService.returnToHub(ws);
      updatedRunState.worldState = ws;
      updatedRunState.actionHistory = []; // HUB 복귀 시 고집 이력 초기화

      await this.db
        .update(nodeInstances)
        .set({ status: 'NODE_ENDED', updatedAt: new Date() })
        .where(eq(nodeInstances.id, currentNode.id));

      const result = this.buildSystemResult(
        turnNo,
        currentNode,
        '잠긴 닻 선술집으로 발걸음을 돌린다.',
      );
      await this.commitTurnRecord(
        run,
        currentNode,
        turnNo,
        body,
        body.input.choiceId,
        result,
        updatedRunState,
        body.options?.skipLlm,
      );

      const transition = await this.nodeTransition.transitionToHub(
        run.id,
        currentNode.nodeIndex,
        turnNo + 1,
        ws,
        arcState,
      );
      transition.enterResult.turnNo = turnNo + 1;
      await this.db.insert(turns).values({
        runId: run.id,
        turnNo: turnNo + 1,
        nodeInstanceId: transition.enterResult.node.id,
        nodeType: 'HUB',
        inputType: 'SYSTEM',
        rawInput: '',
        idempotencyKey: `${run.id}_hub_${turnNo + 1}`,
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

      return {
        accepted: true,
        turnNo,
        serverResult: result,
        llm: { status: 'PENDING' as LlmStatus, narrative: null },
        meta: { nodeOutcome: 'NODE_ENDED', policyResult: 'ALLOW' },
        transition: {
          nextNodeIndex: transition.nextNodeIndex,
          nextNodeType: 'HUB',
          enterResult: transition.enterResult,
          battleState: null,
          enterTurnNo: turnNo + 1,
        },
      };
    }

    // ACTION/CHOICE → IntentParserV2 파싱
    let rawInput = body.input.text ?? body.input.choiceId ?? '';
    const source =
      body.input.type === 'CHOICE' ? ('CHOICE' as const) : ('RULE' as const);
    let choicePayload: Record<string, unknown> | undefined;

    if (body.input.type === 'CHOICE' && body.input.choiceId) {
      const prevTurn = await this.db.query.turns.findFirst({
        where: and(
          eq(turns.runId, run.id),
          eq(turns.turnNo, run.currentTurnNo),
        ),
        columns: { serverResult: true, llmChoices: true },
      });
      // 서버 생성 선택지에서 먼저 탐색
      const prevChoices = (prevTurn?.serverResult as ServerResultV1 | null)
        ?.choices;
      let matched = prevChoices?.find((c) => c.id === body.input.choiceId);
      // 못 찾으면 LLM 생성 선택지에서 탐색
      if (!matched && prevTurn?.llmChoices) {
        const llmChoices = prevTurn.llmChoices;
        matched = llmChoices.find((c) => c.id === body.input.choiceId);
      }
      if (matched) {
        rawInput = matched.label;
        choicePayload = matched.action.payload;
      }
    }

    // 고집(insistence) 카운트 계산: 같은 actionType 연속 반복 횟수
    const actionHistory = runState.actionHistory ?? [];
    const { count: insistenceCount, repeatedType } =
      this.calculateInsistenceCount(actionHistory);
    // NPC 목록을 NpcForIntent로 변환하여 IntentParser에 전달 (targetNpc 파싱용)
    const npcsForIntent = this.content.getAllNpcs().map((n) => ({
      npcId: n.npcId,
      name: n.name,
      unknownAlias: n.unknownAlias,
      title: n.title,
    }));
    const intent = await this.llmIntentParser.parseWithInsistence(
      rawInput,
      source,
      choicePayload,
      insistenceCount,
      repeatedType,
      locationId,
      npcsForIntent,
    );
    const _sec = intent.secondaryActionType
      ? `+${intent.secondaryActionType}`
      : '';
    this.logger.log(
      `[Intent] "${rawInput.slice(0, 30)}" → ${intent.actionType}${_sec} (source=${intent.source}, tone=${intent.tone}, conf=${intent.confidence})`,
    );

    // V3 Intent 확장 (유저 주도형 시스템)
    const intentV3 = this.intentV3Builder.build(
      intent,
      rawInput,
      locationId,
      choicePayload,
    );
    this.logger.debug(
      `[IntentV3] goal=${intentV3.goalCategory}, vector=${intentV3.approachVector}, goalText="${intentV3.goalText}"`,
    );

    // Phase 4a: EQUIP/UNEQUIP — 장비 착용/해제 (주사위 판정 없음, 즉시 처리)
    if (
      (intent.actionType === 'EQUIP' || intent.actionType === 'UNEQUIP') &&
      (body.input.type === 'ACTION' || body.input.type === 'CHOICE')
    ) {
      return this.handleEquipAction(
        run,
        currentNode,
        turnNo,
        body,
        rawInput,
        updatedRunState,
        intent,
      );
    }

    // MOVE_LOCATION: 자유 텍스트로 다른 LOCATION 이동 요청 시 실제 전환
    if (
      intent.actionType === 'MOVE_LOCATION' &&
      (body.input.type === 'ACTION' || body.input.type === 'CHOICE')
    ) {
      const targetLocationId = this.extractTargetLocation(rawInput, locationId);
      if (targetLocationId && targetLocationId !== locationId) {
        return this.performLocationTransition(
          run,
          currentNode,
          turnNo,
          body,
          rawInput,
          runState,
          ws,
          arcState,
          locationId,
          targetLocationId,
        );
      }
      // Fixplan3-P4: 목표 장소 불명확 시 HUB 복귀 (go_hub와 동일 처리)
      const locMemFallback = await this.memoryIntegration.finalizeVisit(
        run.id,
        currentNode.id,
        runState,
        turnNo,
      );
      const hubWs = this.worldStateService.returnToHub(ws);
      const hubRunState: RunState = {
        ...runState,
        worldState: hubWs,
        actionHistory: [],
        ...(locMemFallback ? { locationMemories: locMemFallback } : {}),
      };

      await this.db
        .update(nodeInstances)
        .set({ status: 'NODE_ENDED', updatedAt: new Date() })
        .where(eq(nodeInstances.id, currentNode.id));

      const moveResult = this.buildSystemResult(
        turnNo,
        currentNode,
        '잠긴 닻 선술집으로 돌아가기로 한다.',
      );
      await this.commitTurnRecord(
        run,
        currentNode,
        turnNo,
        body,
        rawInput,
        moveResult,
        hubRunState,
        body.options?.skipLlm,
      );

      const transition = await this.nodeTransition.transitionToHub(
        run.id,
        currentNode.nodeIndex,
        turnNo + 1,
        hubWs,
        arcState,
      );
      transition.enterResult.turnNo = turnNo + 1;
      await this.db.insert(turns).values({
        runId: run.id,
        turnNo: turnNo + 1,
        nodeInstanceId: transition.enterResult.node.id,
        nodeType: 'HUB',
        inputType: 'SYSTEM',
        rawInput: '',
        idempotencyKey: `${run.id}_hub_${turnNo + 1}`,
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
          runState: hubRunState,
          updatedAt: new Date(),
        })
        .where(eq(runSessions.id, run.id));

      return {
        accepted: true,
        turnNo,
        serverResult: moveResult,
        llm: { status: 'PENDING' as LlmStatus, narrative: null },
        meta: { nodeOutcome: 'NODE_ENDED', policyResult: 'ALLOW' },
        transition: {
          nextNodeIndex: transition.nextNodeIndex,
          nextNodeType: 'HUB',
          enterResult: transition.enterResult,
          battleState: null,
          enterTurnNo: turnNo + 1,
        },
      };
    }

    // 이벤트 연속성: 의도 기반 씬 연속성 판단 (3단계)
    const sourceEventId = choicePayload?.sourceEventId as string | undefined;
    const rng = this.rngService.create(run.seed, turnNo);
    let matchedEvent: import('../db/types/event-def.js').EventDefV2 | null =
      null;

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

    // Step 2: IncidentRouter — intentV3 기반으로 관련 incident 라우팅
    const incidentDefsForRouting =
      this.content.getIncidentsData() as IncidentDef[];
    const routingResult = this.incidentRouter.route(
      ws,
      locationId,
      intentV3,
      incidentDefsForRouting,
    );
    if (routingResult.routeMode !== 'FALLBACK_SCENE') {
      this.logger.debug(
        `[IncidentRouter] mode=${routingResult.routeMode}, incident=${routingResult.incident?.incidentId}, score=${routingResult.matchScore}, vector=${routingResult.matchedVector}`,
      );
    }

    // Step 3: Player-First 턴 모드 결정 + 이벤트 매칭
    if (!matchedEvent) {
      const isFirstTurnAtLocation = actionHistory.length === 0;
      const discoveredFacts = new Set(runState.discoveredQuestFacts ?? []);
      const allEventsForCheck = this.content.getAllEventsV2();
      const hasUndiscoveredFactEvent = allEventsForCheck.some(
        (e: any) =>
          e.locationId === locationId &&
          e.discoverableFact &&
          !discoveredFacts.has(e.discoverableFact),
      );
      const questFactTrigger =
        hasUndiscoveredFactEvent && actionHistory.length > 0;

      // 직전 턴 NPC 정보
      const lastEntry = actionHistory[actionHistory.length - 1] as
        | Record<string, unknown>
        | undefined;
      const lastPrimaryNpcId = lastEntry?.primaryNpcId as
        | string
        | null
        | undefined;

      // 플레이어 텍스트에서 NPC 매칭 (사전 판별 — turnMode 결정용)
      const earlyTargetNpcId = this.extractTargetNpcFromInput(
        rawInput,
        body.input.type,
      );

      // 사건 압력 계산 (pressure ≥ 70으로 상향 — Player-First)
      const incidentPressureHigh = (ws.activeIncidents ?? []).some(
        (inc: any) => inc.pressure >= 70 && inc.locationId === locationId,
      );

      // 맥락 NPC: 직전 턴의 primaryNpcId (행동 종류 무관 — FIGHT 후에도 유지)
      // lastPrimaryNpcId는 대화 잠금용(SOCIAL_ACTION 연속), contextNpcId는 모든 행동에서 유지
      const contextNpcId = (lastEntry?.primaryNpcId as string) ?? null;

      // ── Player-First 턴 모드 결정 ──
      const turnMode = this.determineTurnMode({
        earlyTargetNpcId,
        intentV3TargetNpcId: intentV3.targetNpcId ?? null,
        actionType: intent.actionType,
        lastPrimaryNpcId: lastPrimaryNpcId ?? null,
        contextNpcId,
        isFirstTurnAtLocation,
        incidentPressureHigh,
        questFactTrigger,
      });
      this.logger.log(
        `[TurnMode] ${turnMode} (target=${earlyTargetNpcId ?? intentV3.targetNpcId ?? 'none'}, action=${intent.actionType}, firstTurn=${isFirstTurnAtLocation}, pressure=${incidentPressureHigh}, questFact=${questFactTrigger}, contextNpc=${contextNpcId ?? 'none'})`,
      );

      // ── 모드별 이벤트 매칭 ──
      switch (turnMode) {
        case TurnMode.PLAYER_DIRECTED: {
          // 플레이어가 NPC/행동을 명시 → 이벤트 매칭 스킵
          const targetNpcForShell =
            earlyTargetNpcId ?? intentV3.targetNpcId ?? null;
          matchedEvent = {
            eventId: `FREE_PLAYER_${turnNo}`,
            eventType: 'ENCOUNTER' as any,
            locationId,
            affordances: [intent.actionType] as any[],
            matchPolicy: 'NEUTRAL' as any,
            priority: 1,
            weight: 1,
            friction: 0,
            conditions: [],
            payload: {
              sceneFrame: '',
              choices: [],
              tags: [],
              primaryNpcId: targetNpcForShell,
            },
          } as any;
          this.logger.log(
            `[PlayerDirected] 이벤트 스킵, NPC=${targetNpcForShell ?? 'none'}, action=${intent.actionType}`,
          );
          break;
        }

        case TurnMode.CONVERSATION_CONT: {
          // 대화 연속 → 이벤트 매칭 스킵, 같은 NPC 유지
          // lastPrimaryNpcId(대화 잠금) 우선, 없으면 contextNpcId(맥락 NPC) fallback
          const convNpcId = lastPrimaryNpcId ?? contextNpcId;
          matchedEvent = {
            eventId: `FREE_CONV_${turnNo}`,
            eventType: 'FALLBACK' as any,
            locationId,
            priority: 1,
            weight: 1,
            conditions: [],
            affordances: ['ANY'],
            friction: 0,
            matchPolicy: 'NEUTRAL',
            payload: {
              sceneFrame: '',
              choices: [],
              tags: [],
              primaryNpcId: convNpcId,
            },
          } as any;
          this.logger.log(
            `[ConversationCont] 대화 연속 감지 → 이벤트 스킵, NPC=${lastPrimaryNpcId}, action=${intent.actionType}`,
          );
          break;
        }

        case TurnMode.WORLD_EVENT: {
          // 세계 이벤트 트리거 → 기존 이벤트 매칭 파이프라인
          this.logger.log(
            `[WorldEvent] firstTurn=${isFirstTurnAtLocation} pressureHigh=${incidentPressureHigh} questFact=${questFactTrigger}`,
          );

          const allEvents = this.content.getAllEventsV2();
          const recentEventIds = actionHistory
            .filter((h) => h.eventId)
            .map((h) => h.eventId!);

          // SituationGenerator 우선 시도
          const lastEventId = recentEventIds[recentEventIds.length - 1] ?? '';
          const lastWasDynamic =
            lastEventId.startsWith('SIT_') || lastEventId.startsWith('PROC_');
          const dynamicRoll = rng.range(0, 100);

          const { SITGEN_CHANCE } =
            require('../engine/hub/quest-balance.config.js').QUEST_BALANCE;
          if (
            this.situationGenerator &&
            !lastWasDynamic &&
            dynamicRoll < SITGEN_CHANCE &&
            !questFactTrigger
          ) {
            try {
              const incidentDefs =
                this.content.getIncidentsData() as IncidentDef[];
              const recentPrimaryNpcIds = actionHistory
                .filter((h) => (h as Record<string, unknown>).primaryNpcId)
                .map(
                  (h) => (h as Record<string, unknown>).primaryNpcId as string,
                );
              const situation = this.situationGenerator.generate(
                ws,
                locationId,
                intent,
                allEvents,
                incidentDefs,
                recentPrimaryNpcIds,
                discoveredFacts,
              );
              if (situation) {
                matchedEvent = situation.eventDef;
                this.logger.debug(
                  `[SituationGenerator] trigger=${situation.trigger} event=${matchedEvent.eventId} npc=${situation.primaryNpcId ?? '-'} facts=${situation.relatedFacts.length}`,
                );
                if (
                  situation.trigger === 'CONSEQUENCE' &&
                  situation.relatedFacts.length > 0
                ) {
                  const usedFacts = (ws as any)._consequenceUsedFacts ?? [];
                  (ws as any)._consequenceUsedFacts = [
                    ...usedFacts,
                    ...situation.relatedFacts,
                  ];
                }
              }
            } catch (err) {
              this.logger.warn(
                `[SituationGenerator] error, falling back to EventMatcher: ${err}`,
              );
            }
          }

          if (!matchedEvent) {
            const NON_SOCIAL_BREAK = new Set(['SNEAK', 'STEAL', 'FIGHT']);
            const shouldBreakNpc = NON_SOCIAL_BREAK.has(intent.actionType);
            const sessionNpcContext = {
              lastPrimaryNpcId: shouldBreakNpc
                ? null
                : ((lastEntry?.primaryNpcId as string) ?? null),
              sessionTurnCount: actionHistory.length,
              interactedNpcIds: [
                ...new Set(
                  (actionHistory as Array<Record<string, unknown>>)
                    .filter((a) => a.primaryNpcId)
                    .map((a) => a.primaryNpcId as string),
                ),
              ],
            };

            // Player-First: WORLD_EVENT에서도 targetNpcId를 전달하여 호환 이벤트 우선
            const earlyTarget =
              earlyTargetNpcId ?? intentV3.targetNpcId ?? null;
            const directorResult = this.eventDirector.select(
              allEvents,
              locationId,
              intent,
              ws,
              arcState,
              agenda,
              cooldowns,
              turnNo,
              rng,
              recentEventIds,
              routingResult,
              sessionNpcContext,
              intentV3,
              earlyTarget,
            );
            matchedEvent = directorResult.selectedEvent;

            if (directorResult.filterLog.length > 0) {
              this.logger.debug(
                `[EventDirector] ${directorResult.filterLog.join(', ')}`,
              );
            }
          }

          // ProceduralEvent fallback
          if (!matchedEvent || matchedEvent.eventType === 'FALLBACK') {
            const proceduralHistory = ws.proceduralHistory ?? [];
            const proceduralResult = this.proceduralEvent.generate(
              {
                locationId,
                timePhase: ws.phaseV2 ?? ws.timePhase,
                stage:
                  ws.mainArc?.stage != null
                    ? String(ws.mainArc.stage)
                    : undefined,
              },
              proceduralHistory,
              turnNo,
              rng,
            );
            if (proceduralResult) {
              matchedEvent = proceduralResult;
              this.logger.debug(
                `[ProceduralEvent] 생성: ${proceduralResult.eventId}`,
              );
            }
          }
          break;
        }
      }
    }

    // 이벤트 없는 턴: FREE 이벤트 셸 보장
    if (!matchedEvent) {
      matchedEvent = {
        eventId: `FREE_${turnNo}`,
        eventType: 'ENCOUNTER' as any,
        locationId,
        affordances: [intent.actionType] as any[],
        matchPolicy: 'NEUTRAL' as any,
        priority: 1,
        weight: 1,
        friction: 0,
        payload: {
          sceneFrame: '',
          tags: [],
          suggested_choices: [],
        },
      } as any;
      this.logger.debug(
        `[FreeAction] No event matched — player-driven turn (action=${intent.actionType})`,
      );
    }

    // matchedEvent는 이 시점에서 항상 non-null (FREE 이벤트 셸이 보장)
    const event = matchedEvent!;

    // Notification + WorldDelta: 변경 전 상태 스냅샷
    const prevHeat = ws.hubHeat;
    const prevSafety = ws.hubSafety;
    const prevIncidents = [...(ws.activeIncidents ?? [])];
    const priorWsSnapshot = {
      ...ws,
      activeIncidents: [...(ws.activeIncidents ?? [])],
    };

    // === 플레이어 대상 NPC 오버라이드 ===
    // 플레이어가 ACTION 텍스트에서 특정 NPC를 지목한 경우, 이벤트의 primaryNpcId를 교체
    // 우선순위: (1) 실명 전체 매칭 (2) "~에게" 패턴 키워드 (3) 별칭 전체 매칭 (4) 키워드 3자+ 부분 매칭
    if (body.input.type === 'ACTION' && rawInput) {
      const playerInputLower = rawInput.toLowerCase();
      const allNpcDefs = this.content.getAllNpcs();
      let overrideNpcId: string | null = null;

      // Pass 1: 실명 또는 별칭 전체 매칭
      for (const npcDef of allNpcDefs) {
        if (
          npcDef.name &&
          playerInputLower.includes(npcDef.name.toLowerCase())
        ) {
          overrideNpcId = npcDef.npcId;
          break;
        }
        if (
          npcDef.unknownAlias &&
          playerInputLower.includes(npcDef.unknownAlias.toLowerCase())
        ) {
          overrideNpcId = npcDef.npcId;
          break;
        }
      }

      // Pass 2: "~에게" 패턴에서 대상 NPC 추출 (가장 정확한 플레이어 의도)
      if (!overrideNpcId) {
        const egeMatch = rawInput.match(/(.+?)에게/);
        if (egeMatch) {
          const targetWord = egeMatch[1].trim().toLowerCase();
          for (const npcDef of allNpcDefs) {
            if (npcDef.name && targetWord.includes(npcDef.name.toLowerCase())) {
              overrideNpcId = npcDef.npcId;
              break;
            }
            const aliasKeywords = npcDef.unknownAlias?.split(/\s+/) ?? [];
            if (
              aliasKeywords.some(
                (kw: string) =>
                  kw.length >= 2 && targetWord.includes(kw.toLowerCase()),
              )
            ) {
              overrideNpcId = npcDef.npcId;
              break;
            }
          }
        }
      }

      // Pass 3: "~을/를" 패턴에서 대상 NPC 추출
      if (!overrideNpcId) {
        const eulMatch = rawInput.match(/(.+?)(?:을|를)\s/);
        if (eulMatch) {
          const targetWord = eulMatch[1].trim().toLowerCase();
          for (const npcDef of allNpcDefs) {
            if (npcDef.name && targetWord.includes(npcDef.name.toLowerCase())) {
              overrideNpcId = npcDef.npcId;
              break;
            }
            const aliasKeywords = npcDef.unknownAlias?.split(/\s+/) ?? [];
            if (
              aliasKeywords.some(
                (kw: string) =>
                  kw.length >= 2 && targetWord.includes(kw.toLowerCase()),
              )
            ) {
              overrideNpcId = npcDef.npcId;
              break;
            }
          }
        }
      }

      // Pass 4: 별칭 키워드 부분 매칭 (3자 이상만 — 오매칭 방지)
      if (!overrideNpcId) {
        for (const npcDef of allNpcDefs) {
          const aliasKeywords = npcDef.unknownAlias?.split(/\s+/) ?? [];
          if (
            aliasKeywords.some(
              (kw: string) =>
                kw.length >= 3 && playerInputLower.includes(kw.toLowerCase()),
            )
          ) {
            overrideNpcId = npcDef.npcId;
            break;
          }
        }
      }

      if (overrideNpcId) {
        const prevNpc = (event.payload as Record<string, unknown>)
          ?.primaryNpcId;
        if (prevNpc !== overrideNpcId) {
          (event.payload as Record<string, unknown>).primaryNpcId =
            overrideNpcId;
          this.logger.log(
            `[NpcOverride] Player targeted ${overrideNpcId} (was: ${prevNpc ?? 'none'})`,
          );
        }
      }
    }

    // Phase 4c: 세트 specialEffect 수집
    const activeSpecialEffects = this.equipmentService.getActiveSpecialEffects(
      runState.equipped ?? {},
    );

    // 판정 보너스 조회 — runState에 합산된 actionBonuses 우선, 없으면 프리셋 fallback
    const presetDef = run.presetId
      ? this.content.getPreset(run.presetId)
      : undefined;
    const presetActionBonuses =
      runState.actionBonuses ?? presetDef?.actionBonuses;

    // NPC faction 조회 (평판 변동용)
    const primaryNpcIdForResolve = (event.payload as Record<string, unknown>)
      ?.primaryNpcId as string | undefined;
    const primaryNpcFaction = primaryNpcIdForResolve
      ? (this.content.getNpc(primaryNpcIdForResolve)?.faction ?? null)
      : null;

    // ResolveService 판정
    const resolveResult = this.resolveService.resolve(
      event,
      intent,
      ws,
      playerStats,
      rng,
      activeSpecialEffects,
      presetActionBonuses,
      primaryNpcFaction,
      runState,
    );
    this.logger.log(
      `[Resolve] ${resolveResult.outcome} (score=${resolveResult.score}) event=${event.eventId} heat=${resolveResult.heatDelta}${presetActionBonuses?.[intent.actionType] ? ` presetBonus=+${presetActionBonuses[intent.actionType]}` : ''}${resolveResult.traitBonus ? ` traitBonus=${resolveResult.traitBonus > 0 ? '+' : ''}${resolveResult.traitBonus}` : ''}${resolveResult.gamblerLuckTriggered ? ' GAMBLER_LUCK!' : ''}`,
    );

    // === NanoEventDirector: 비동기 분리 — nanoCtx만 빌드, LLM Worker에서 호출 ===
    const nanoEventResult: NanoEventResult | null = null;
    let nanoEventCtx: NanoEventContext | null = null;
    if (this.nanoEventDirector) {
      try {
        // 장소에 있는 NPC 목록
        const locDynamic = ws.locationDynamicStates as
          | Record<string, { presentNpcs?: string[] }>
          | undefined;
        const presentNpcIds = locDynamic?.[locationId]?.presentNpcs ?? [];
        const existingNpcStates = runState.npcStates ?? {};
        // NPC별 연속 대화 턴 수 계산
        const npcConsecutiveMap: Record<string, number> = {};
        for (let i = actionHistory.length - 1; i >= 0; i--) {
          const hNpc = (actionHistory[i] as Record<string, unknown>)
            .primaryNpcId as string | undefined;
          if (!hNpc) break;
          npcConsecutiveMap[hNpc] = (npcConsecutiveMap[hNpc] ?? 0) + 1;
          if (
            i > 0 &&
            (actionHistory[i - 1] as Record<string, unknown>).primaryNpcId !==
              hNpc
          )
            break;
        }
        const presentNpcs = presentNpcIds.map((id: string) => {
          const npcDef = this.content.getNpc(id);
          const npcState = existingNpcStates[id];
          const met = actionHistory.some(
            (h) => (h as Record<string, unknown>).primaryNpcId === id,
          );
          return {
            npcId: id,
            displayName: getNpcDisplayName(npcState, npcDef),
            posture: npcState?.posture ?? npcDef?.basePosture ?? 'CAUTIOUS',
            trust: npcState?.emotional?.trust ?? 0,
            consecutiveTurns: npcConsecutiveMap[id] ?? 0,
            met,
          };
        });

        // 발견 가능 fact 목록
        const discoveredFactsSet = new Set(runState.discoveredQuestFacts ?? []);
        const availableFacts = this.questProgression
          ? this.content
              .getAllEventsV2()
              .filter(
                (e: any) =>
                  e.locationId === locationId &&
                  e.discoverableFact &&
                  !discoveredFactsSet.has(e.discoverableFact),
              )
              .map((e: any) => {
                const factDetail = this.questProgression!.getFactDetail(
                  e.discoverableFact,
                );
                return {
                  factId: e.discoverableFact as string,
                  description: factDetail ?? e.discoverableFact,
                  rate:
                    resolveResult.outcome === 'SUCCESS'
                      ? 1.0
                      : resolveResult.outcome === 'PARTIAL'
                        ? 0.5
                        : 0,
                };
              })
          : [];

        // 직전 2턴 요약
        const recentSummaryParts = actionHistory.slice(-2).map((h, i) => {
          const ah = h as Record<string, unknown>;
          const t = actionHistory.length - 2 + i + 1;
          return `T${turnNo - (actionHistory.length - (actionHistory.length - 2 + i))}: ${ah.eventId ?? '자유행동'} (${ah.actionType})`;
        });

        // 직전 NPC
        const lastEntry = actionHistory[actionHistory.length - 1] as
          | Record<string, unknown>
          | undefined;
        const lastNpcId = (lastEntry?.primaryNpcId as string) ?? null;
        const lastNpcDef = lastNpcId ? this.content.getNpc(lastNpcId) : null;

        // sourceNpcId from choice payload (NPC 연속성)
        const choiceSourceNpcId =
          (choicePayload?.sourceNpcId as string) ?? null;
        const effectiveLastNpcId = choiceSourceNpcId ?? lastNpcId;

        // targetNpcId: IntentV3에서 감지된 대상 NPC
        const nanoTargetNpcId = intentV3.targetNpcId ?? null;

        // wantNewNpc: "다른/아무나/새로운" 키워드 감지
        const WANT_NEW_KEYWORDS = [
          '다른 사람',
          '아무나',
          '아무한테',
          '새로운',
          '다른 누구',
          '다른사람',
        ];
        const wantNewNpc = WANT_NEW_KEYWORDS.some((kw) =>
          rawInput.includes(kw),
        );

        // 같은 NPC 연속 턴 수
        let npcConsecutiveTurns = 0;
        if (effectiveLastNpcId) {
          for (let i = actionHistory.length - 1; i >= 0; i--) {
            if (
              (actionHistory[i] as Record<string, unknown>).primaryNpcId ===
              effectiveLastNpcId
            ) {
              npcConsecutiveTurns++;
            } else {
              break;
            }
          }
        }

        // Player-First: npcLocked 판정 — FREE_PLAYER_ / FREE_CONV_ 이벤트면 NPC 고정
        const isNpcLocked =
          event.eventId.startsWith('FREE_PLAYER_') ||
          event.eventId.startsWith('FREE_CONV_');
        const lockedNpcId = isNpcLocked
          ? ((event.payload as Record<string, unknown>).primaryNpcId as
              | string
              | null)
          : null;

        const nanoCtx: NanoEventContext = {
          locationId,
          locationName:
            this.content.getLocation(locationId)?.name ?? locationId,
          timePhase: (ws.phaseV2 ?? ws.timePhase) as string,
          hubHeat: ws.hubHeat,
          hubSafety: ws.hubSafety as string,
          rawInput,
          actionType: intent.actionType,
          resolveOutcome: resolveResult.outcome,
          lastNpcId: effectiveLastNpcId,
          lastNpcName: effectiveLastNpcId
            ? getNpcDisplayName(
                existingNpcStates[effectiveLastNpcId],
                this.content.getNpc(effectiveLastNpcId),
              )
            : null,
          targetNpcId: nanoTargetNpcId,
          wantNewNpc,
          npcConsecutiveTurns,
          presentNpcs,
          recentSummary: recentSummaryParts.join('\n'),
          availableFacts,
          questState: runState.questState ?? 'S0_ARRIVE',
          previousOpening: null,
          activeConditions:
            (locDynamic?.[locationId] as any)?.activeConditions ?? [],
          npcReactions: [], // 이번 턴 반응은 nano 호출 후 계산됨 — LLM 프롬프트에서 직접 주입
          npcLocked: isNpcLocked,
          lockedNpcId,
        };

        // 비동기 분리: nanoCtx만 저장, LLM Worker에서 generate() 호출
        nanoEventCtx = nanoCtx;
        this.logger.debug(
          `[NanoEventDirector] nanoCtx 빌드 완료 → LLM Worker에서 비동기 호출 예정`,
        );
      } catch (err) {
        this.logger.warn(
          `[NanoEventDirector] nanoCtx 빌드 실패 (non-fatal): ${err}`,
        );
        nanoEventCtx = null;
      }
    }

    // Living World v2: 판정 결과 → WorldFact 생성 + LocationState 변경 + NPC 목격
    if (this.consequenceProcessor) {
      try {
        const consequenceOutput = this.consequenceProcessor.process(ws, {
          resolveResult,
          intent,
          event: event,
          locationId,
          turnNo,
          day: ws.day,
          primaryNpcId: event.payload.primaryNpcId,
        });
        if (consequenceOutput.factsCreated.length > 0) {
          this.logger.debug(
            `[ConsequenceProcessor] facts=${consequenceOutput.factsCreated.length} locEffects=${consequenceOutput.locationEffects.length} witnesses=${consequenceOutput.npcWitnesses.length}`,
          );
        }
        // 임계값 트리거 로깅 + 시그널 이벤트 생성
        if (consequenceOutput.triggeredConditions.length > 0) {
          this.logger.log(
            `[ThresholdTrigger] ${consequenceOutput.triggeredConditions.join(', ')} at ${locationId}`,
          );
          // NanoEventDirector에 전달할 nanoEventResult에 반영 (이미 ui에 저장됨)
          // 시그널 피드에 세계 변화 알림 추가
          const CONDITION_SIGNALS: Record<string, string> = {
            INCREASED_PATROLS: '🛡️ 경비대가 순찰을 강화했다',
            LOCKDOWN: '🔒 경비대가 지역을 봉쇄했다',
            UNREST_RUMORS: '💬 불안한 소문이 돌고 있다',
            RIOT: '🔥 폭동이 발생했다!',
          };
          // 시그널 피드에 직접 추가
          const signalFeed = (ws.signalFeed ?? []) as Array<
            Record<string, unknown>
          >;
          for (const condId of consequenceOutput.triggeredConditions) {
            const signalText = CONDITION_SIGNALS[condId];
            if (signalText) {
              signalFeed.push({
                id: `cond_${condId}_${turnNo}`,
                channel: 'SECURITY',
                severity: condId === 'RIOT' || condId === 'LOCKDOWN' ? 3 : 2,
                locationId,
                text: signalText,
                sourceIncidentId: null,
                createdAtClock: ws.globalClock ?? turnNo,
                expiresAtClock: (ws.globalClock ?? turnNo) + 12,
              });
            }
          }
          ws = { ...ws, signalFeed } as WorldState;
        }
      } catch (err) {
        this.logger.warn(`[ConsequenceProcessor] error (non-fatal): ${err}`);
      }
    }

    // === Layer 3: NPC 능동 반응 — WITNESSED NPC가 trust/posture에 따라 반응 ===
    const npcReactions: Array<{
      npcId: string;
      npcName: string;
      type: 'warn' | 'inform' | 'avoid' | 'hostile';
      text: string;
      heatDelta: number;
    }> = [];
    {
      // 최근 WorldFacts에서 WITNESSED 기록 조회
      const worldFacts = (ws.worldFacts ?? []) as Array<{
        turnCreated: number;
        category: string;
        tags: string[];
        impact?: { npcKnowledge?: Record<string, string> };
      }>;
      // 이번 턴 + 직전 턴의 PLAYER_ACTION fact에서 목격자 수집
      const recentWitnesses = new Map<string, string[]>(); // npcId → witnessed action tags
      for (const fact of worldFacts) {
        if (fact.category !== 'PLAYER_ACTION') continue;
        if (fact.turnCreated < turnNo - 1) continue; // 최근 2턴만
        const witnesses = fact.impact?.npcKnowledge ?? {};
        for (const [npcId, status] of Object.entries(witnesses)) {
          if (status === 'WITNESSED') {
            const existing = recentWitnesses.get(npcId) ?? [];
            existing.push(...fact.tags);
            recentWitnesses.set(npcId, existing);
          }
        }
      }

      // 각 목격 NPC의 trust/posture에 따라 반응 결정
      const DANGEROUS_TAGS = new Set(['fight', 'steal', 'threaten', 'success']);
      const existingNpcStatesForReaction = runState.npcStates ?? {};

      for (const [npcId, tags] of recentWitnesses) {
        const npcState = existingNpcStatesForReaction[npcId];
        if (!npcState) continue;
        const npcDef = this.content.getNpc(npcId);
        const npcName = getNpcDisplayName(npcState, npcDef);
        const trust = npcState.emotional?.trust ?? npcState.trustToPlayer ?? 0;
        const hasDangerousAction = tags.some((t) => DANGEROUS_TAGS.has(t));

        if (!hasDangerousAction) continue; // 위험한 행동 목격만 반응

        let reaction: {
          type: 'warn' | 'inform' | 'avoid' | 'hostile';
          text: string;
          heatDelta: number;
        };

        if (trust >= 20) {
          // 우호적 NPC → 경고 (Heat 변동 없음)
          reaction = {
            type: 'warn',
            text: `${npcName}이(가) 조심하라고 경고한다`,
            heatDelta: 0,
          };
        } else if (trust >= -10) {
          // 중립 NPC → 회피 (관계 소폭 악화)
          reaction = {
            type: 'avoid',
            text: `${npcName}이(가) 눈을 피하며 거리를 둔다`,
            heatDelta: 0,
          };
        } else if (trust >= -30) {
          // 적대적 NPC → 밀고 (Heat 증가)
          reaction = {
            type: 'inform',
            text: `${npcName}이(가) 경비대에 밀고했다`,
            heatDelta: 5,
          };
        } else {
          // 매우 적대적 → 적극 대응
          reaction = {
            type: 'hostile',
            text: `${npcName}이(가) 경비대를 불러왔다`,
            heatDelta: 8,
          };
        }

        npcReactions.push({ npcId, npcName, ...reaction });

        // Heat 변동 적용
        if (reaction.heatDelta > 0) {
          ws = {
            ...ws,
            hubHeat: Math.min(100, ws.hubHeat + reaction.heatDelta),
          };
        }
      }

      if (npcReactions.length > 0) {
        this.logger.log(
          `[NpcReaction] ${npcReactions.map((r) => `${r.npcName}:${r.type}(heat+${r.heatDelta})`).join(', ')}`,
        );
      }
    }

    // Living World v2: PlayerGoal 진행도 체크 + 암시적 목표 감지
    if (this.playerGoalService) {
      try {
        const milestoneResults = this.playerGoalService.checkMilestones(ws);
        if (milestoneResults.length > 0) {
          this.logger.debug(
            `[PlayerGoal] milestones: ${milestoneResults.length} advanced`,
          );
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
            this.playerGoalService.detectImplicitGoals(
              ws,
              patterns,
              turnNo,
              ws.day,
            );
          }
        }
      } catch (err) {
        this.logger.warn(`[PlayerGoal] error (non-fatal): ${err}`);
      }
    }

    // architecture/43: 돌발행동 → NPC 감정·기억 자동 갱신 (combat/non-combat 공통)
    // combat 트리거 분기보다 먼저 실행해 COMBAT 경로에서도 NPC 상태가 반영되도록 한다.
    if (resolveResult.suddenAction && resolveResult.suddenAction.targetNpcId) {
      const npcId = resolveResult.suddenAction.targetNpcId;
      const npcStates = updatedRunState.npcStates ?? {};
      const targetNpc = npcStates[npcId];
      if (targetNpc) {
        const sa = resolveResult.suddenAction;
        const fearBoost =
          sa.severity === 'CRITICAL' ? 40 : sa.severity === 'SEVERE' ? 25 : 15;
        const trustDrop =
          sa.severity === 'CRITICAL' ? 30 : sa.severity === 'SEVERE' ? 20 : 10;
        const suspicionBoost =
          sa.severity === 'CRITICAL' ? 40 : sa.severity === 'SEVERE' ? 25 : 10;
        const emo = targetNpc.emotional ?? {
          trust: 0,
          fear: 0,
          respect: 0,
          suspicion: 0,
          attachment: 0,
        };
        const updatedEmo = {
          ...emo,
          suspicion: Math.max(
            sa.severity === 'CRITICAL' ? 65 : 0,
            Math.min(100, emo.suspicion + suspicionBoost),
          ),
          fear: Math.min(100, emo.fear + fearBoost),
          trust: Math.max(-100, emo.trust - trustDrop),
        };
        const { recordNpcEncounter, addNpcKnownFact } =
          await import('../db/types/npc-state.js');
        const locationId = (ws.currentLocationId as string) || '';
        let updated: import('../db/types/index.js').NPCState = {
          ...targetNpc,
          emotional: updatedEmo,
        };
        updated = recordNpcEncounter(
          updated,
          turnNo,
          locationId,
          sa.type,
          'SUCCESS',
          sa.summary,
        );
        updated = addNpcKnownFact(updated, `⚠️ ${sa.summary} (T${turnNo})`);
        npcStates[npcId] = updated;
        updatedRunState.npcStates = npcStates;
        this.logger.debug(
          `[SuddenAction] ${sa.severity} ${sa.type} -> ${npcId}: fear+${fearBoost} suspicion+${suspicionBoost} trust-${trustDrop}`,
        );
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
        event.payload.sceneFrame,
        runState.npcStates ?? {},
        (id) => this.content.getNpc(id),
      );
      const preResult = this.buildLocationResult(
        turnNo,
        currentNode,
        `${combatSceneFrame} — 전투가 시작된다!`,
        resolveResult.outcome,
        [],
        ws,
      );
      await this.commitTurnRecord(
        run,
        currentNode,
        turnNo,
        body,
        rawInput,
        preResult,
        updatedRunState,
        body.options?.skipLlm,
      );

      const transition = await this.nodeTransition.insertCombatSubNode(
        run.id,
        currentNode.id,
        currentNode.nodeIndex,
        turnNo + 1,
        resolveResult.combatEncounterId,
        currentNode.environmentTags ?? [],
        run.seed,
        updatedRunState.hp,
        updatedRunState.stamina,
      );
      transition.enterResult.turnNo = turnNo + 1;

      // 전투 진입 summary에 트리거 행동 컨텍스트 추가 (LLM 내러티브 연속성)
      const triggerContext = `플레이어가 "${rawInput}"${korParticle(rawInput, '을', '를')} 시도했으나 실패하여 전투가 발생했다.`;
      transition.enterResult.summary = {
        short: `${triggerContext} ${transition.enterResult.summary.short}`,
        display: transition.enterResult.summary.display,
      };
      await this.db.insert(turns).values({
        runId: run.id,
        turnNo: turnNo + 1,
        nodeInstanceId: transition.enterResult.node.id,
        nodeType: 'COMBAT',
        inputType: 'SYSTEM',
        rawInput: '',
        idempotencyKey: `${run.id}_combat_${turnNo + 1}`,
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

      return {
        accepted: true,
        turnNo,
        serverResult: preResult,
        llm: { status: 'PENDING' as LlmStatus, narrative: null },
        meta: { nodeOutcome: 'ONGOING', policyResult: 'ALLOW' },
        transition: {
          nextNodeIndex: transition.nextNodeIndex,
          nextNodeType: 'COMBAT',
          enterResult: transition.enterResult,
          battleState: transition.battleState ?? null,
          enterTurnNo: turnNo + 1,
        },
      };
    }

    // 비전투 → WorldState 업데이트
    ws = this.heatService.applyHeatDelta(ws, resolveResult.heatDelta);
    ws = {
      ...ws,
      tension: Math.max(
        0,
        Math.min(10, ws.tension + resolveResult.tensionDelta),
      ),
    };
    // relation 변경
    const relations = { ...(runState.npcRelations ?? {}) };
    for (const [npcId, delta] of Object.entries(
      resolveResult.relationChanges,
    )) {
      relations[npcId] = Math.max(
        0,
        Math.min(100, (relations[npcId] ?? 50) + delta),
      );
    }
    // reputation 변동 반영
    for (const [factionId, delta] of Object.entries(
      resolveResult.reputationChanges,
    )) {
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
        deferredEffects: [
          ...ws.deferredEffects,
          { ...de, sourceTurnNo: turnNo },
        ],
      };
    }

    // (architecture/43 돌발행동 처리는 전투 트리거 분기보다 앞에서 이미 실행됨)

    // === Narrative Engine v1: preStepTick (시간 사이클 + Incident tick + signal) ===
    const incidentDefs = this.content.getIncidentsData() as IncidentDef[];
    ws = this.worldStateService.migrateWorldState(ws);
    const { ws: wsAfterTick, resolvedPatches } = this.worldTick.preStepTick(
      ws,
      incidentDefs,
      rng,
      1,
    );
    ws = wsAfterTick;

    // === Narrative Engine v1: Incident impact 적용 ===
    const relevantIncident = this.incidentMgmt.findRelevantIncident(
      ws,
      locationId,
      intent.actionType,
      incidentDefs,
      intent.secondaryActionType,
    );
    if (relevantIncident) {
      const updatedIncident = this.incidentMgmt.applyImpact(
        relevantIncident.incident,
        relevantIncident.def,
        resolveResult.outcome,
        ws.globalClock,
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
    if (
      routingResult.routeMode !== 'FALLBACK_SCENE' &&
      routingResult.incident
    ) {
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
      const currInc = (ws.activeIncidents ?? []).find(
        (i) => i.incidentId === incId,
      );
      const controlDelta = (currInc?.control ?? 0) - (prevInc?.control ?? 0);
      const pressureDelta = (currInc?.pressure ?? 0) - (prevInc?.pressure ?? 0);

      // 행동 요약
      const actionLabel = `${this.actionTypeToKorean(intent.actionType)} (${resolveResult.outcome})`;
      const impactParts: string[] = [];
      if (controlDelta !== 0)
        impactParts.push(
          `control${controlDelta > 0 ? '+' : ''}${controlDelta}`,
        );
      if (pressureDelta !== 0)
        impactParts.push(
          `pressure${pressureDelta > 0 ? '+' : ''}${pressureDelta}`,
        );
      const impactStr =
        impactParts.length > 0 ? impactParts.join(', ') : 'no change';

      // playerInvolvements 추가 (최대 8개, 오래된 것 trim)
      const involvements = [
        ...existing.playerInvolvements,
        { turnNo, locationId, action: actionLabel, impact: impactStr },
      ].slice(-8);

      // knownClues: 이벤트 sceneFrame 앞 40자를 단서로 추가 (중복 제거, 최대 5개)
      const sceneFrame = event?.payload?.sceneFrame;
      const clueFromEvent = sceneFrame
        ? sceneFrame.slice(0, 40)
        : (event?.eventId ?? null);
      const clues = [...existing.knownClues];
      if (clueFromEvent && !clues.includes(clueFromEvent)) {
        clues.push(clueFromEvent);
      }
      const trimmedClues = clues.slice(-5);

      // relatedNpcIds: 이벤트의 primaryNpcId + incident def의 relatedNpcIds
      const relatedNpcs = new Set(existing.relatedNpcIds);
      const eventNpc = event?.payload?.primaryNpcId;
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
    // phaseV2가 없는 기존 런 방어 (NpcSchedule DAWN 크래시 방지)
    if (!ws.phaseV2) {
      ws.phaseV2 = (
        ws.timePhase === 'NIGHT' ? 'NIGHT' : 'DAY'
      ) as import('../db/types/world-state.js').TimePhaseV2;
    }
    ws = this.worldTick.postStepTick(ws, resolvedPatches);

    // diff용 장비 추가 수집기 (클라이언트 즉시 반영)
    const allEquipmentAdded: import('../db/types/equipment.js').ItemInstance[] =
      [];

    // === Phase 4d: Legendary Quest Rewards (Incident CONTAINED + commitment 조건) ===
    const prevContainedSet = new Set(
      prevIncidents
        .filter((i) => i.resolved && i.outcome === 'CONTAINED')
        .map((i) => i.incidentId),
    );
    const newlyContainedIds = (ws.activeIncidents ?? [])
      .filter(
        (i) =>
          i.resolved &&
          i.outcome === 'CONTAINED' &&
          !prevContainedSet.has(i.incidentId),
      )
      .map((i) => i.incidentId);
    const legendaryResult = this.legendaryRewardService.check(
      updatedRunState,
      ws.activeIncidents ?? [],
      newlyContainedIds,
    );
    if (legendaryResult.awarded.length > 0) {
      if (!updatedRunState.equipmentBag) updatedRunState.equipmentBag = [];
      for (const inst of legendaryResult.awarded) {
        updatedRunState.equipmentBag.push(inst);
        allEquipmentAdded.push(inst);
        // Phase 3: ItemMemory — 전설 보상 기록
        this.recordItemMemory(
          updatedRunState,
          inst,
          turnNo,
          '전설 보상',
          locationId,
        );
      }
      updatedRunState.legendaryRewards = [
        ...(updatedRunState.legendaryRewards ?? []),
        ...legendaryResult.awarded.map((i) => i.baseItemId),
      ];
    }

    // === Narrative Engine v1: NPC Emotional 업데이트 ===
    const npcStates = { ...(runState.npcStates ?? {}) } as Record<
      string,
      NPCState
    >;
    const newlyIntroducedNpcIds: string[] = [];
    const newlyEncounteredNpcIds: string[] = [];

    // 대화 잠금 NPC 보정: 대화 행동 + targetNpc 미지정/불일치 + 이전 턴에 대화 NPC 존재 → 이전 NPC 유지
    // IntentParser의 targetNpc보다 입력 텍스트의 NPC 이름/별칭 키워드 매칭이 우선
    const SOCIAL_ACTIONS_FOR_LOCK = new Set([
      'TALK',
      'PERSUADE',
      'BRIBE',
      'THREATEN',
      'HELP',
      'INVESTIGATE',
      'OBSERVE',
      'TRADE',
    ]);

    // 입력 텍스트에서 NPC 키워드 직접 매칭 (IntentParser LLM보다 정확)
    // 우선순위: (1) 실명 전체 매칭 (2) 별칭 전체 매칭 (3) 별칭 키워드 부분 매칭
    // 부분 키워드("수상한")가 다른 NPC 별칭에 우연히 포함되는 오매칭 방지
    let textMatchedNpcId: string | null = null;
    {
      const inputLower = rawInput.toLowerCase();
      const allNpcs = this.content.getAllNpcs();

      // Pass 1: 실명 또는 별칭 전체 매칭 (가장 정확)
      for (const npc of allNpcs) {
        if (npc.name && inputLower.includes(npc.name.toLowerCase())) {
          textMatchedNpcId = npc.npcId;
          break;
        }
        if (
          npc.unknownAlias &&
          inputLower.includes(npc.unknownAlias.toLowerCase())
        ) {
          textMatchedNpcId = npc.npcId;
          break;
        }
      }

      // Pass 2: "~에게" 패턴에서 대상 NPC 추출 (가장 정확한 플레이어 의도)
      if (!textMatchedNpcId) {
        const targetMatch = rawInput.match(/(.+?)에게/);
        if (targetMatch) {
          const targetWord = targetMatch[1].trim().toLowerCase();
          this.logger.debug(
            `[TextNpcMatch] Pass2 에게 패턴: targetWord="${targetWord}"`,
          );
          for (const npc of allNpcs) {
            const nameMatch =
              npc.name && targetWord.includes(npc.name.toLowerCase());
            const aliasKeywords = npc.unknownAlias?.split(/\s+/) ?? [];
            const kwMatch = aliasKeywords.some(
              (kw: string) =>
                kw.length >= 2 && targetWord.includes(kw.toLowerCase()),
            );
            if (nameMatch || kwMatch) {
              textMatchedNpcId = npc.npcId;
              break;
            }
          }
        }
      }

      // Pass 3: 별칭 키워드 부분 매칭 (3자 이상)
      if (!textMatchedNpcId) {
        for (const npc of allNpcs) {
          const aliasKeywords = npc.unknownAlias?.split(/\s+/) ?? [];
          const kwMatch = aliasKeywords.some(
            (kw: string) =>
              kw.length >= 3 && inputLower.includes(kw.toLowerCase()),
          );
          if (kwMatch) {
            textMatchedNpcId = npc.npcId;
            break;
          }
        }
      }
    }

    // textMatchedNpcId가 있으면 intentV3.targetNpcId보다 우선 (플레이어가 직접 이름을 언급)
    const resolvedTargetNpcId =
      textMatchedNpcId ?? intentV3.targetNpcId ?? null;

    let conversationLockedNpcId: string | null = null;
    if (
      SOCIAL_ACTIONS_FOR_LOCK.has(intent.actionType) &&
      !resolvedTargetNpcId
    ) {
      // architecture/46 §4.1 — Continuity Engine 강화:
      // SYSTEM 턴이나 primary 없는 턴은 skip하고 진짜 마지막 SOCIAL NPC 찾기.
      // 비-SOCIAL 행동 만나면 잠금 해제 (이동/공격 같은 명시적 전환 신호).
      for (let i = actionHistory.length - 1; i >= 0; i--) {
        const prev = actionHistory[i] as Record<string, unknown>;
        const prevNpc = prev.primaryNpcId as string | undefined;
        const prevAction = prev.actionType as string | undefined;

        // primary 없음 (SYSTEM 턴 등) → skip 후 계속 거슬러 검사
        if (!prevNpc) continue;

        if (SOCIAL_ACTIONS_FOR_LOCK.has(prevAction ?? '')) {
          conversationLockedNpcId = prevNpc;
          this.logger.debug(
            `[대화잠금] 이전 대화 NPC ${conversationLockedNpcId} 유지 (action=${intent.actionType}, prevAction=${prevAction}, depth=${actionHistory.length - 1 - i})`,
          );
          break;
        }
        // 비-SOCIAL primary 있는 턴 → 의도적 전환 → 잠금 해제
        break;
      }
    }

    // effectiveNpcId: (1) 텍스트 매칭 NPC (2) intent.targetNpcId (3) conversationLockedNpcId (4) event.payload.primaryNpcId
    let eventPrimaryNpc = event.payload.primaryNpcId ?? null;
    if (resolvedTargetNpcId) {
      // 입력 텍스트 키워드 또는 IntentParser가 NPC를 지정 → 최우선
      eventPrimaryNpc = resolvedTargetNpcId;
    } else if (conversationLockedNpcId) {
      // 대화 잠금 NPC → 이벤트 배정 NPC보다 우선 (연속 대화 중 다른 NPC 끼어들기 방지)
      eventPrimaryNpc = conversationLockedNpcId;
      (event.payload as Record<string, unknown>).primaryNpcId =
        conversationLockedNpcId;
    }

    // architecture/46: 잠금 NPC + Fact awareness 통합
    // 잠금 NPC가 입력 키워드 매칭 fact를 보유하면 EventMatcher의 다른 NPC override 무력화.
    // 잠금 NPC가 fact 모를 때는 EventMatcher 결과 따라가 자연 인계 (다른 NPC 등장).
    if (
      !resolvedTargetNpcId &&
      eventPrimaryNpc &&
      eventPrimaryNpc !== conversationLockedNpcId
    ) {
      // 잠금 NPC 후보를 actionHistory에서 직전 SOCIAL primary로 fallback (강한 모드)
      let candidateLockNpc = conversationLockedNpcId;
      if (!candidateLockNpc) {
        for (let i = actionHistory.length - 1; i >= 0; i--) {
          const prev = actionHistory[i] as Record<string, unknown>;
          const prevNpc = prev.primaryNpcId as string | undefined;
          const prevAction = prev.actionType as string | undefined;
          if (!prevNpc) continue;
          if (SOCIAL_ACTIONS_FOR_LOCK.has(prevAction ?? '')) {
            candidateLockNpc = prevNpc;
          }
          break;
        }
      }
      if (
        candidateLockNpc &&
        candidateLockNpc !== eventPrimaryNpc &&
        SOCIAL_ACTIONS_FOR_LOCK.has(intent.actionType)
      ) {
        // 입력 키워드 추출 + fact 매칭 검사
        const inputKwSet = new Set(rawInput.match(/[가-힣]{2,}/g) ?? []);
        const factCandidates = this.content.getFactsByKeywords(inputKwSet);
        const lockNpcKnowsFact = factCandidates.some((f) =>
          f.knownBy.includes(candidateLockNpc!),
        );
        if (lockNpcKnowsFact) {
          this.logger.debug(
            `[잠금+Fact] ${candidateLockNpc} 잠금 유지 — 매칭 fact 보유 (EventMatcher의 ${eventPrimaryNpc} override)`,
          );
          eventPrimaryNpc = candidateLockNpc;
          (event.payload as Record<string, unknown>).primaryNpcId =
            candidateLockNpc;
        } else if (factCandidates.length > 0) {
          // 잠금 NPC fact 모름 + 다른 NPC가 보유 → EventMatcher 결과 그대로 (자연 인계)
          this.logger.debug(
            `[잠금+Fact] ${candidateLockNpc} fact 미보유 → EventMatcher의 ${eventPrimaryNpc}로 자연 인계`,
          );
        }
      }
    }
    // Posture 변화 이벤트 (result 선언 전이므로 임시 저장)
    const pendingPostureEvents: Array<{
      id: string;
      kind: 'NPC';
      text: string;
      tags: string[];
      data: Record<string, unknown>;
    }> = [];

    // 현재 location의 관련 NPC에게 감정 영향 적용
    if (eventPrimaryNpc) {
      const npcId = eventPrimaryNpc;
      const wasNewlyCreated = !npcStates[npcId];
      const prevEncounterCount = npcStates[npcId]?.encounterCount ?? 0;
      if (wasNewlyCreated) {
        const npcDef = this.content.getNpc(npcId);
        npcStates[npcId] = initNPCState({
          npcId,
          basePosture: npcDef?.basePosture,
          initialTrust: npcDef?.initialTrust ?? relations[npcId] ?? 0,
          agenda: npcDef?.agenda,
        });
      }

      // encounterCount 증가 — 이번 방문 내 첫 만남인 경우에만 (방문 단위 1회)
      const alreadyMetThisVisit = actionHistory.some(
        (h) => h.primaryNpcId === npcId,
      );
      if (!alreadyMetThisVisit) {
        npcStates[npcId].encounterCount =
          (npcStates[npcId].encounterCount ?? 0) + 1;
      }

      // 첫 실제 만남 감지: 새로 생성되었거나, encounterCount가 0→1로 변한 경우
      if (
        wasNewlyCreated ||
        (prevEncounterCount === 0 && (npcStates[npcId].encounterCount ?? 0) > 0)
      ) {
        newlyEncounteredNpcIds.push(npcId);
      }

      // 성격 기반 소개 판정 — base posture 기준 (감정 변화로 effective posture가 바뀌어도 소개 임계값은 고정)
      const introPosture = npcStates[npcId].posture;
      const npcDefForIntro = this.content.getNpc(npcId);
      const npcTier = (npcDefForIntro as Record<string, unknown>)?.tier as
        | string
        | undefined;
      if (shouldIntroduce(npcStates[npcId], introPosture, npcTier)) {
        npcStates[npcId].introduced = true;
        npcStates[npcId].introducedAtTurn = turnNo; // 2턴 분리: 이번 턴은 alias, 다음 턴부터 실명
        newlyIntroducedNpcIds.push(npcId);
      }

      const npc = npcStates[npcId];
      // 감정 변화 delta 계산을 위해 before 저장
      const emoBefore = npc.emotional ? { ...npc.emotional } : undefined;
      const postureBefore = npc.posture;
      npc.emotional = this.npcEmotional.applyActionImpact(
        npc.emotional,
        intent.actionType,
        resolveResult.outcome,
        true,
      );
      npcStates[npcId] = this.npcEmotional.syncLegacyFields(npc);

      // Posture 변화 감지 (result 선언 후 이벤트에 추가)
      const postureAfter = npcStates[npcId].posture;
      if (postureBefore && postureAfter && postureBefore !== postureAfter) {
        const displayName = getNpcDisplayName(
          npcStates[npcId],
          this.content.getNpc(npcId),
        );
        const POSTURE_LABEL: Record<string, string> = {
          FRIENDLY: '우호',
          CAUTIOUS: '경계',
          HOSTILE: '적대',
          FEARFUL: '두려움',
          CALCULATING: '계산적',
        };
        const fromLabel = POSTURE_LABEL[postureBefore] ?? postureBefore;
        const toLabel = POSTURE_LABEL[postureAfter] ?? postureAfter;
        pendingPostureEvents.push({
          id: `posture_${npcId}_${turnNo}`,
          kind: 'NPC' as const,
          text: `${displayName}의 태도가 변했다 — ${fromLabel} → ${toLabel}`,
          tags: ['POSTURE_CHANGE'],
          data: { npcId, from: postureBefore, to: postureAfter },
        });
      }
      // delta 계산 및 runState에 저장 (LLM 컨텍스트 전달용)
      if (emoBefore && npc.emotional) {
        const delta: Record<string, number> = {};
        for (const axis of [
          'trust',
          'fear',
          'respect',
          'suspicion',
          'attachment',
        ] as const) {
          const d = Math.round(
            ((npc.emotional as any)[axis] ?? 0) -
              ((emoBefore as any)[axis] ?? 0),
          );
          if (d !== 0) delta[axis] = d;
        }
        if (Object.keys(delta).length > 0) {
          (runState as any).lastNpcDelta = {
            npcId,
            delta,
            actionType: intent.actionType,
            outcome: resolveResult.outcome,
          };
        }
      }

      // === NPC 개인 기록 축적 ===
      const briefNote = (event.payload.sceneFrame ?? rawInput).slice(0, 50);
      npcStates[npcId] = recordNpcEncounter(
        npcStates[npcId],
        turnNo,
        locationId,
        intent.actionType,
        resolveResult.outcome,
        briefNote,
      );
      // knownFacts: 이벤트 결과에서 중요 발견사항 추출 (SUCCESS 판정 + 정보성 행동)
      if (
        resolveResult.outcome === 'SUCCESS' &&
        ['INVESTIGATE', 'PERSUADE', 'TALK', 'TRADE', 'OBSERVE'].includes(
          intent.actionType,
        )
      ) {
        const factNote = event.payload.sceneFrame
          ? event.payload.sceneFrame.slice(0, 60)
          : undefined;
        if (factNote) {
          npcStates[npcId] = addNpcKnownFact(npcStates[npcId], factNote);
        }
      }

      // === NPC LLM Summary 업데이트 (재등장 시 간소 프롬프트 블록용) ===
      npcStates[npcId].llmSummary = buildNpcLlmSummary(
        npcStates[npcId],
        this.content.getNpc(npcId),
        turnNo,
        (event.payload.sceneFrame ?? '').slice(0, 40),
        '', // LLM 출력은 비동기이므로 다음 턴에서 snippet 반영
      );

      // === 대화 주제 추적: recentTopics에 이번 턴 주제 기록 ===
      {
        const topicEntry = buildTopicEntry(
          turnNo,
          null, // factId는 quest 처리 후 결정되므로 여기서는 null
          null,
          event.payload.sceneFrame ?? null,
          intent.actionType,
          rawInput,
        );
        npcStates[npcId] = addRecentTopic(npcStates[npcId], topicEntry);
      }

      // === signature 카운터 업데이트: 3턴 간격이 지났으면 이번 턴을 기록 ===
      const lastSig = npcStates[npcId].lastSignatureTurn ?? 0;
      if (turnNo - lastSig >= 3) {
        npcStates[npcId].lastSignatureTurn = turnNo;
      }
    }

    // Fixplan3-P2: eventPrimaryNpc가 null일 때 이벤트 태그에서 NPC 상태 초기화
    // 태그는 간접 참조이므로 encounterCount는 증가하지 않음 (직접 대면=primaryNpcId만 카운트)
    if (!eventPrimaryNpc && event.payload.tags) {
      for (const tag of event.payload.tags) {
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
    const resolvedSceneFrame = npcResolve(event.payload.sceneFrame);
    const resolvedChoices = event.payload.choices?.map((c: any) => ({
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
      npcNames[npcId] = getNpcDisplayName(npcStates[npcId], npcDef, turnNo);
    }
    // resolve outcome 횟수 집계
    const resolveOutcomeCounts: Record<string, number> = {};
    for (const h of actionHistory) {
      if (h.resolveOutcome) {
        resolveOutcomeCounts[h.resolveOutcome] =
          (resolveOutcomeCounts[h.resolveOutcome] ?? 0) + 1;
      }
    }
    // 현재 턴의 결과도 추가
    resolveOutcomeCounts[resolveResult.outcome] =
      (resolveOutcomeCounts[resolveResult.outcome] ?? 0) + 1;

    const newMarks = this.narrativeMarkService.checkAndApply(
      ws.narrativeMarks ?? [],
      markConditions as NarrativeMarkCondition[],
      {
        ws,
        npcEmotionals,
        npcNames,
        resolveOutcomes: resolveOutcomeCounts,
        clock: ws.globalClock,
      },
    );
    if (newMarks.length > 0) {
      ws = {
        ...ws,
        narrativeMarks: [...(ws.narrativeMarks ?? []), ...newMarks],
      };
    }

    ws = this.worldStateService.advanceTime(ws);
    ws = this.worldStateService.updateHubSafety(ws);

    // Deferred 체크
    const { ws: wsAfterDeferred } =
      this.worldStateService.processDeferredEffects(ws, turnNo);
    ws = wsAfterDeferred;

    // Agenda 업데이트
    agenda = this.agendaService.updateFromResolve(agenda, resolveResult, event);

    // Arc commitment 업데이트
    let newArcState = arcState;
    if (resolveResult.commitmentDelta > 0 && newArcState.currentRoute) {
      newArcState = this.arcService.progressCommitment(
        newArcState,
        resolveResult.commitmentDelta,
      );
    }
    // Arc route tag로 route 설정
    if (event.arcRouteTag && !newArcState.currentRoute) {
      const route = event.arcRouteTag as any;
      if (this.arcService.canSwitchRoute(newArcState)) {
        newArcState = this.arcService.switchRoute(newArcState, route);
      }
    }

    // cooldown 업데이트
    const newCooldowns = { ...cooldowns, [event.eventId]: turnNo };

    // 행동 이력 업데이트 (고집 시스템 + FALLBACK 페널티 + 선택지 중복 방지)
    const eventPrimaryNpcId = (event.payload as Record<string, unknown>)
      ?.primaryNpcId as string | undefined;
    const newHistory = [
      ...actionHistory,
      {
        turnNo,
        actionType: intent.actionType,
        secondaryActionType: intent.secondaryActionType,
        suppressedActionType: intent.suppressedActionType,
        inputText: rawInput,
        eventId: event.eventId,
        choiceId:
          body.input.type === 'CHOICE' ? body.input.choiceId : undefined,
        primaryNpcId: eventPrimaryNpcId ?? undefined,
        resolveOutcome: resolveResult.outcome,
      },
    ].slice(-10); // 최대 10개 유지

    // LOCATION 보상 계산 (resolve 주사위 이후 같은 RNG로 수행)
    const locationReward = this.rewardsService.calculateLocationRewards({
      outcome: resolveResult.outcome,
      eventType: event.eventType,
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
      const existing = updatedRunState.inventory.find(
        (i) => i.itemId === added.itemId,
      );
      if (existing) existing.qty += added.qty;
      else
        updatedRunState.inventory.push({
          itemId: added.itemId,
          qty: added.qty,
        });
    }

    // 이벤트 payload.itemRewards 지급 (대화·상호작용 계열 NPC 선물 등)
    // DropTable은 GOLD_ACTIONS(STEAL/FIGHT/SEARCH/…)만 대상이라 대화에선 아이템이 안 나옴 →
    // 콘텐츠가 명시적으로 선언한 itemRewards만 여기서 처리.
    // 실제 지급은 locationReward.items에 병합해서 buildLocationResult가 diff를 만들도록 위임.
    const payloadItemRewards: import('../db/types/event-def.js').EventItemReward[] =
      (
        event.payload as unknown as {
          itemRewards?: import('../db/types/event-def.js').EventItemReward[];
        }
      ).itemRewards ?? [];
    const pendingItemRewardEvents: Array<{
      id: string;
      kind: 'LOOT';
      text: string;
      tags: string[];
      data?: Record<string, unknown>;
    }> = [];
    for (const reward of payloadItemRewards) {
      const pass =
        reward.condition === 'SUCCESS'
          ? resolveResult.outcome === 'SUCCESS'
          : resolveResult.outcome === 'SUCCESS' ||
            resolveResult.outcome === 'PARTIAL';
      if (!pass) continue;
      const qty = reward.qty ?? 1;
      const existing = updatedRunState.inventory.find(
        (i) => i.itemId === reward.itemId,
      );
      if (existing) existing.qty += qty;
      else updatedRunState.inventory.push({ itemId: reward.itemId, qty });
      // locationReward.items에 병합 → buildLocationResult가 diff.inventory.itemsAdded로 반영
      locationReward.items.push({ itemId: reward.itemId, qty });
      const itemDef = this.content.getItem(reward.itemId);
      pendingItemRewardEvents.push({
        id: `item_reward_${reward.itemId}`,
        kind: 'LOOT',
        text: `[아이템] ${itemDef?.name ?? reward.itemId} 획득`,
        tags: ['LOOT', 'ITEM_REWARD'],
        data: { itemId: reward.itemId, qty },
      });
    }

    // Phase 4a: LOCATION 장비 드랍 (GOLD_ACTIONS + SUCCESS/PARTIAL)
    const locationEquipDropEvents: Array<{
      id: string;
      kind: 'LOOT';
      text: string;
      tags: string[];
      data?: Record<string, unknown>;
    }> = [];
    if (resolveResult.outcome !== 'FAIL') {
      const equipDrop = this.rewardsService.rollLocationEquipmentDrop(
        locationId,
        rng,
      );
      if (equipDrop.droppedInstances.length > 0) {
        if (!updatedRunState.equipmentBag) updatedRunState.equipmentBag = [];
        for (const inst of equipDrop.droppedInstances) {
          updatedRunState.equipmentBag.push(inst);
          allEquipmentAdded.push(inst);
          // Phase 3: ItemMemory — LOCATION 드랍 기록
          this.recordItemMemory(
            updatedRunState,
            inst,
            turnNo,
            `${locationId} 탐색 드랍`,
            locationId,
          );
          locationEquipDropEvents.push({
            id: `eq_drop_${inst.instanceId.slice(0, 8)}`,
            kind: 'LOOT' as const,
            text: `[장비] ${inst.displayName} 획득`,
            tags: ['LOOT', 'EQUIPMENT_DROP'],
            data: {
              baseItemId: inst.baseItemId,
              instanceId: inst.instanceId,
              displayName: inst.displayName,
            } as Record<string, unknown>,
          });
        }
      }
    }

    // === Phase 4b: RegionEconomy — SHOP 액션 + priceIndex + 재고 갱신 ===
    const shopActionEvents: Array<{
      id: string;
      kind: 'GOLD' | 'LOOT' | 'SYSTEM';
      text: string;
      tags: string[];
    }> = [];
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
          shopDef,
          currentStock,
          turnNo,
          run.seed,
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
          const matchedItem = stock.items.find(
            (si) =>
              si.itemId === targetItemId ||
              si.itemId.includes(targetItemId) ||
              (this.content.getItem(si.itemId)?.name ?? '').includes(
                intent.target!,
              ),
          );

          if (matchedItem && matchedItem.qty > 0) {
            const { result: purchaseResult, updatedStock } =
              this.shopService.purchase(
                stock,
                matchedItem.itemId,
                updatedRunState.gold,
                economy.priceIndex,
              );

            if (purchaseResult.success) {
              // 골드 감소
              updatedRunState.gold = Math.max(
                0,
                updatedRunState.gold - purchaseResult.goldSpent,
              );

              // 아이템 추가 (장비 vs 소비)
              const itemDef = this.content.getItem(matchedItem.itemId);
              if (itemDef?.type === 'EQUIPMENT') {
                if (!updatedRunState.equipmentBag)
                  updatedRunState.equipmentBag = [];
                const instance = {
                  instanceId: `${matchedItem.itemId}_${turnNo}`,
                  baseItemId: matchedItem.itemId,
                  displayName: itemDef.name,
                  affixes: [],
                };
                updatedRunState.equipmentBag.push(instance);
                allEquipmentAdded.push(instance);
                // Phase 3: ItemMemory — 상점 구매 기록
                this.recordItemMemory(
                  updatedRunState,
                  instance,
                  turnNo,
                  '상점 구매',
                  locationId,
                );
                shopActionEvents.push({
                  id: `shop_buy_eq_${turnNo}`,
                  kind: 'LOOT',
                  text: `[상점] ${itemDef.name}${korParticle(itemDef.name, '을', '를')} ${purchaseResult.goldSpent}G에 구매했다.`,
                  tags: ['SHOP', 'BUY', 'EQUIPMENT'],
                });
              } else {
                const existing = updatedRunState.inventory.find(
                  (i) => i.itemId === matchedItem.itemId,
                );
                if (existing) existing.qty += 1;
                else
                  updatedRunState.inventory.push({
                    itemId: matchedItem.itemId,
                    qty: 1,
                  });
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
                shopStocks: {
                  ...economy.shopStocks,
                  [shopDef.shopId]: updatedStock,
                },
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
    const { ws: wsWithDelta } = this.worldDeltaService.build(
      turnNo,
      priorWsSnapshot,
      ws,
    );
    ws = wsWithDelta;

    // === User-Driven System v3: PlayerThread (반복 행동 패턴 추적) ===
    ws = this.playerThreadService.update(
      ws,
      turnNo,
      locationId,
      intentV3.approachVector,
      intentV3.goalCategory,
      resolveResult.outcome,
      routingResult,
    );

    // === Signal Feed: 행동 결과 기반 시그널 생성 ===
    const actionSignal = this.signalFeed.generateFromActionResult(
      intent.actionType,
      resolveResult.outcome,
      locationId,
      ws.globalClock,
      (event?.payload as any)?.primaryNpcId ?? intent.target,
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

    // === pendingQuestHint 만료 정리: 발견 다음 턴 1회만 전달, 이후 삭제 ===
    if (
      updatedRunState.pendingQuestHint &&
      updatedRunState.pendingQuestHint.setAtTurn < turnNo
    ) {
      updatedRunState.pendingQuestHint = null;
    }

    // === Quest Progression: 3경로 FACT 발견 + 단계 전환 ===
    const discoveredFactIdsThisTurn: string[] = []; // 대화 주제 추적용
    if (this.questProgression) {
      try {
        const existing = updatedRunState.discoveredQuestFacts ?? [];
        const addFact = (factId: string, source: string) => {
          if (factId && !existing.includes(factId)) {
            updatedRunState.discoveredQuestFacts = [
              ...(updatedRunState.discoveredQuestFacts ?? []),
              factId,
            ];
            // arcState에도 동기화 (checkTransition + API 응답에서 arcState.discoveredQuestFacts 참조)
            if (updatedRunState.arcState) {
              updatedRunState.arcState.discoveredQuestFacts =
                updatedRunState.discoveredQuestFacts;
            }
            existing.push(factId); // 같은 턴 중복 방지
            discoveredFactIdsThisTurn.push(factId);
            this.logger.log(
              `[Quest] Fact discovered: ${factId} (source: ${source})`,
            );
          }
        };

        // 경로 1: 이벤트 discoverableFact — SUCCESS 시 자동 발견
        if (resolveResult.outcome === 'SUCCESS' && event) {
          const eventFact =
            ((event.payload as Record<string, unknown>)?.discoverableFact as
              | string
              | undefined) ??
            ((event as Record<string, unknown>).discoverableFact as
              | string
              | undefined);
          if (eventFact) {
            addFact(eventFact, `event:${event.eventId}`);
          }
        }

        // 경로 2: NPC knownFacts — SUCCESS/PARTIAL + 정보성 행동 + 2단계 NPC 반응 판정
        // effectiveNpcId: 텍스트 매칭 → IntentParser → 대화 잠금 → 이벤트 NPC 순으로 결정됨
        const INFO_ACTIONS = new Set([
          'INVESTIGATE',
          'PERSUADE',
          'TALK',
          'TRADE',
          'OBSERVE',
          'SEARCH',
          'HELP',
          'BRIBE',
          'THREATEN',
          'STEAL',
        ]);
        if (
          (resolveResult.outcome === 'SUCCESS' ||
            resolveResult.outcome === 'PARTIAL') &&
          INFO_ACTIONS.has(intent.actionType)
        ) {
          const npcId =
            eventPrimaryNpc ??
            ((event?.payload as Record<string, unknown>)?.primaryNpcId as
              | string
              | undefined) ??
            null;
          if (npcId) {
            // 2단계: NPC trust 기반 반응 판정
            const npcState = npcStates[npcId];
            const npcTrust = npcState?.emotional?.trust ?? 0;
            // BRIBE/THREATEN은 특수: trust 무관하게 작동 (금전/공포 기반)
            const bypassTrust =
              intent.actionType === 'BRIBE' || intent.actionType === 'THREATEN';

            // trust 단계별 반응:
            //   trust > 20: 직접 전달 (SUCCESS/PARTIAL 모두)
            //   trust 0~20: 간접 전달 (SUCCESS만, PARTIAL은 힌트만)
            //   trust -20~0: 관찰 힌트 (SUCCESS만 — fact 발견되지만 전달 방식만 다름)
            //   trust < -20: 거부 (fact 미발견 — 다른 NPC나 이벤트로 우회 필요)
            let npcWillReveal = false;
            let npcRevealMode: 'direct' | 'indirect' | 'observe' | 'refuse' =
              'refuse';

            if (bypassTrust) {
              // BRIBE/THREATEN: trust 무관, 판정 결과만으로 결정
              npcWillReveal = true;
              npcRevealMode =
                resolveResult.outcome === 'SUCCESS' ? 'indirect' : 'observe';
            } else if (npcTrust > 20) {
              npcWillReveal = true;
              npcRevealMode = 'direct';
            } else if (npcTrust >= 0) {
              npcWillReveal = resolveResult.outcome === 'SUCCESS';
              npcRevealMode = 'indirect';
            } else if (npcTrust >= -20) {
              npcWillReveal = resolveResult.outcome === 'SUCCESS';
              npcRevealMode = 'observe';
            } else {
              // trust < -20: 거부
              npcWillReveal = false;
              npcRevealMode = 'refuse';
            }

            this.logger.log(
              `[Quest:NpcReaction] npc=${npcId} trust=${npcTrust} action=${intent.actionType} outcome=${resolveResult.outcome} → willReveal=${npcWillReveal} mode=${npcRevealMode}`,
            );

            if (npcWillReveal) {
              const revealedFactId =
                this.questProgression.getRevealableQuestFact(
                  npcId,
                  updatedRunState,
                );
              if (revealedFactId) {
                addFact(revealedFactId, `npc:${npcId}:${npcRevealMode}`);
                // revealMode를 serverResult에 전달하여 context-builder에서 프롬프트 분기에 활용
                (
                  updatedRunState as unknown as Record<string, unknown>
                )._npcRevealMode = npcRevealMode;
              }
            }
          }
        }

        // 경로 3: PARTIAL + 이벤트 discoverableFact — P2/P4: 확률은 config에서 관리

        const { PARTIAL_FACT_DISCOVERY_CHANCE } =
          require('../engine/hub/quest-balance.config.js').QUEST_BALANCE;
        if (resolveResult.outcome === 'PARTIAL' && event) {
          const eventFact =
            ((event.payload as Record<string, unknown>)?.discoverableFact as
              | string
              | undefined) ??
            ((event as Record<string, unknown>).discoverableFact as
              | string
              | undefined);
          if (eventFact && !existing.includes(eventFact)) {
            const roll = rng.range(0, 100);
            if (roll < PARTIAL_FACT_DISCOVERY_CHANCE) {
              addFact(eventFact, `event_partial:${event.eventId}`);
            }
          }
        }

        // 경로 4: NanoEventDirector 추천 fact — LLM Worker에서 비동기 처리 (비동기 분리)
        // nanoEventResult는 비동기 분리 후 항상 null — fact 발견은 경로 1~3으로 충분

        // 전체 발견 팩트 수집 + 단계 전환 체크
        const discoveredFacts =
          this.questProgression.collectDiscoveredFacts(updatedRunState);
        const currentQuestState = updatedRunState.questState ?? 'S0_ARRIVE';
        const transition = this.questProgression.checkTransition(
          currentQuestState,
          discoveredFacts,
        );
        if (transition.newState) {
          updatedRunState.questState = transition.newState;
          if (updatedRunState.arcState) {
            updatedRunState.arcState.questState = transition.newState;
          }
          // 퀘스트 단계 변경 → 체류 턴 리셋
          (
            updatedRunState as unknown as Record<string, unknown>
          ).questStateSinceTurn = turnNo;
          this.logger.log(
            `[Quest] ${currentQuestState} -> ${transition.newState}`,
          );

          // 퀘스트 전환 시그널 → 호외 발행 대상
          if (updatedRunState.worldState) {
            const QUEST_LABEL: Record<string, string> = {
              S1_GET_ANGLE: '사건의 실마리가 포착되었다.',
              S2_PROVE_TAMPER: '조작의 흔적이 드러나기 시작했다.',
              S3_TRACE_ROUTE: '배후의 경로가 윤곽을 드러내고 있다.',
              S4_CONFRONT: '진실에 한 걸음 더 다가섰다.',
              S5_RESOLVE: '모든 것이 끝을 향해 치닫고 있다.',
            };
            const questText =
              QUEST_LABEL[transition.newState] ??
              `사건이 새로운 국면에 접어들었다.`;
            const sf = (updatedRunState.worldState.signalFeed ?? []) as Array<
              Record<string, unknown>
            >;
            sf.push({
              id: `sig_quest_${transition.newState}_${turnNo}`,
              channel: 'RUMOR',
              severity: 4,
              text: questText,
              createdAtClock:
                (updatedRunState.worldState as any).globalClock ?? 0,
            });
            updatedRunState.worldState = {
              ...updatedRunState.worldState,
              signalFeed: sf,
            } as any;
          }
        } else {
          // 단계 미변경 → 체류 턴 체크 (진행도 힌트)
          const STALE_THRESHOLD = 5;
          const sinceTurn = (
            updatedRunState as unknown as Record<string, unknown>
          ).questStateSinceTurn as number | undefined;
          const staleTurns = sinceTurn ? turnNo - sinceTurn : turnNo;

          if (
            staleTurns >= STALE_THRESHOLD &&
            discoveredFactIdsThisTurn.length === 0
          ) {
            const staleHint = this.questProgression.getStaleHint(
              currentQuestState,
              discoveredFacts,
            );
            if (staleHint) {
              const AUTO_DISCOVER_THRESHOLD = 3; // 힌트 3회 반복 → fact 자동 발견
              const hintCount = staleTurns - STALE_THRESHOLD + 1;

              if (hintCount >= AUTO_DISCOVER_THRESHOLD) {
                // 힌트 3회 이상 → fact 자동 발견 (플레이어가 소문을 충분히 인지)
                if (!updatedRunState.discoveredQuestFacts)
                  updatedRunState.discoveredQuestFacts = [];
                if (
                  !updatedRunState.discoveredQuestFacts.includes(
                    staleHint.factId,
                  )
                ) {
                  updatedRunState.discoveredQuestFacts.push(staleHint.factId);
                  discoveredFacts.add(staleHint.factId);
                  discoveredFactIdsThisTurn.push(staleHint.factId);
                  if (updatedRunState.arcState?.discoveredQuestFacts) {
                    updatedRunState.arcState.discoveredQuestFacts = [
                      ...updatedRunState.discoveredQuestFacts,
                    ];
                  }
                  this.logger.log(
                    `[Quest] Auto-discovered fact: ${staleHint.factId} (${hintCount} hints on ${currentQuestState})`,
                  );

                  // 자동 발견 후 전환 재체크
                  const recheck = this.questProgression.checkTransition(
                    currentQuestState,
                    discoveredFacts,
                  );
                  if (recheck.newState) {
                    updatedRunState.questState = recheck.newState;
                    if (updatedRunState.arcState) {
                      updatedRunState.arcState.questState = recheck.newState;
                    }
                    (
                      updatedRunState as unknown as Record<string, unknown>
                    ).questStateSinceTurn = turnNo;
                    this.logger.log(
                      `[Quest] Auto-transition: ${currentQuestState} -> ${recheck.newState}`,
                    );
                  }
                }
              } else {
                // 힌트만 제공 (아직 자동 발견 안 함)
                const HINT_MODES = [
                  'OVERHEARD',
                  'RUMOR_ECHO',
                  'SCENE_CLUE',
                ] as const;
                const hintMode = HINT_MODES[rng.range(0, HINT_MODES.length)];
                updatedRunState.pendingQuestHint = {
                  hint: staleHint.hint,
                  setAtTurn: turnNo,
                  mode: hintMode,
                };
                this.logger.log(
                  `[Quest] Stale hint ${hintCount}/${AUTO_DISCOVER_THRESHOLD}: ${staleHint.factId} (${staleTurns} turns on ${currentQuestState}) mode=${hintMode}`,
                );
              }
            }
          }
        }

        // Part A: fact 발견 → 관련 Incident control 증가 (퀘스트-Incident 연동)
        if (
          discoveredFactIdsThisTurn.length > 0 &&
          updatedRunState.worldState
        ) {
          const questData = this.content.getQuestData() as {
            factToIncident?: Record<
              string,
              { incidents: string[]; controlBonus: number }
            >;
          } | null;
          const mapping = questData?.factToIncident;
          if (mapping) {
            const activeIncidents = (updatedRunState.worldState
              .activeIncidents ?? []) as Array<{
              incidentId: string;
              control: number;
              resolved?: boolean;
            }>;
            for (const factId of discoveredFactIdsThisTurn) {
              const entry = mapping[factId];
              if (!entry) continue;
              for (const incId of entry.incidents) {
                const incident = activeIncidents.find(
                  (i) => i.incidentId === incId && !i.resolved,
                );
                if (incident) {
                  incident.control = Math.min(
                    100,
                    (incident.control ?? 0) + entry.controlBonus,
                  );
                  this.logger.log(
                    `[Quest→Incident] ${factId} → ${incId} control +${entry.controlBonus} (now ${incident.control})`,
                  );
                }
              }
            }
          }
        }

        // Part B: S5_RESOLVE + 5턴 + 최소 턴 수 충족 → 미해결 Incident resolved (엔딩 마킹)
        // MIN_TURNS_FOR_NATURAL 가드를 Part B에도 적용: 15턴 미만에 마킹되면
        // checkEndingConditions가 조기 엔딩을 막아 영구 누락된다.
        {
          const qs = updatedRunState.questState ?? '';
          if (qs === 'S5_RESOLVE') {
            const sinceTurn = (
              updatedRunState as unknown as Record<string, unknown>
            ).questStateSinceTurn as number | undefined;
            const s5Turns = sinceTurn ? turnNo - sinceTurn : 0;
            if (
              s5Turns >= 5 &&
              turnNo >= MIN_TURNS_FOR_NATURAL &&
              updatedRunState.worldState
            ) {
              const activeIncidents = (updatedRunState.worldState
                .activeIncidents ?? []) as Array<{
                incidentId: string;
                control: number;
                resolved?: boolean;
                outcome?: string;
              }>;
              for (const inc of activeIncidents) {
                if (!inc.resolved) {
                  inc.control = 100;
                  inc.resolved = true;
                  inc.outcome = 'CONTAINED';
                  this.logger.log(
                    `[Quest→Ending] S5+${s5Turns}턴: ${inc.incidentId} resolved=CONTAINED (엔딩 트리거)`,
                  );
                }
              }
            }
          }
        }

        // pendingQuestHint: 이번 턴에 발견된 fact의 nextHint를 저장 → 다음 턴 LLM 프롬프트에서 사용
        if (discoveredFactIdsThisTurn.length > 0) {
          // 마지막 발견 fact의 nextHint 사용 (여러 fact 동시 발견 시 가장 최근 것)
          const lastFactId =
            discoveredFactIdsThisTurn[discoveredFactIdsThisTurn.length - 1];
          const nextHint = this.questProgression.getFactNextHint(lastFactId);
          if (nextHint) {
            const HINT_MODES = [
              'OVERHEARD',
              'DOCUMENT',
              'SCENE_CLUE',
              'NPC_BEHAVIOR',
              'RUMOR_ECHO',
            ] as const;
            const hintMode = HINT_MODES[rng.range(0, HINT_MODES.length)];
            updatedRunState.pendingQuestHint = {
              hint: nextHint,
              setAtTurn: turnNo,
              mode: hintMode,
            };
            this.logger.log(
              `[Quest] pendingQuestHint set for fact=${lastFactId} mode=${hintMode} at turn=${turnNo}`,
            );
          }
        }
        // Phase 2: 소문 전파 — fact 발견 시 worldFacts에 소문 추가
        if (
          discoveredFactIdsThisTurn.length > 0 &&
          updatedRunState.worldState
        ) {
          const ws = updatedRunState.worldState;
          if (!ws.worldFacts) ws.worldFacts = [];
          for (const factId of discoveredFactIdsThisTurn) {
            const detail = this.questProgression.getFactDetail(factId);
            if (detail) {
              ws.worldFacts.push({
                id: `rumor_${factId}_t${turnNo}`,
                category: 'DISCOVERY',
                text: `소문: ${detail}`,
                locationId: ws.currentLocationId ?? '',
                involvedNpcs: eventPrimaryNpc ? [eventPrimaryNpc] : [],
                turnCreated: turnNo,
                dayCreated: ws.day ?? 1,
                tags: [factId, 'RUMOR'],
                impact: 'minor',
                permanent: false,
                expiresAtTurn: turnNo + 20,
              } as any);
              this.logger.debug(
                `[Quest] Rumor propagated: ${factId} → worldFacts`,
              );
            }
          }
        }
      } catch (err) {
        this.logger.warn(`[QuestProgression] error (non-fatal): ${err}`);
      }
    }

    // === 대화 주제에 factId 역보충: quest 발견 후 해당 NPC의 recentTopics에 factId 기록 ===
    if (
      discoveredFactIdsThisTurn.length > 0 &&
      eventPrimaryNpc &&
      npcStates[eventPrimaryNpc]?.llmSummary?.recentTopics
    ) {
      const topics = npcStates[eventPrimaryNpc].llmSummary!.recentTopics!;
      const thisTurnTopic = topics.find((t) => t.turnNo === turnNo);
      if (thisTurnTopic && !thisTurnTopic.factId) {
        thisTurnTopic.factId = discoveredFactIdsThisTurn[0];
        // factDetail을 topic에 반영 (더 정확한 주제 정보)
        const questFact = this.questProgression?.getFactDetail(
          discoveredFactIdsThisTurn[0],
        );
        if (questFact) {
          thisTurnTopic.topic = questFact.slice(0, 40);
        }
      }
    }

    // Step 5-7: Turn Orchestration (NPC 주입, 감정 피크, 대화 자세)
    const orchestrationResult = this.orchestration.orchestrate(
      updatedRunState,
      locationId,
      turnNo,
      resolveResult.outcome,
      event.payload.tags ?? [],
      intent.actionType,
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
      const alreadyMetInjected = actionHistory.some(
        (h) => h.primaryNpcId === injectedNpcId,
      );
      if (!alreadyMetInjected) {
        npcStates[injectedNpcId].encounterCount =
          (npcStates[injectedNpcId].encounterCount ?? 0) + 1;
      }
      // 소개 판정 — base posture 기준 (감정 변화로 effective posture가 바뀌어도 소개 임계값은 고정)
      const introPosture = npcStates[injectedNpcId].posture;
      if (shouldIntroduce(npcStates[injectedNpcId], introPosture)) {
        npcStates[injectedNpcId].introduced = true;
        newlyIntroducedNpcIds.push(injectedNpcId);
      }
      updatedRunState.npcStates = npcStates;

      // === 주입된 NPC 개인 기록 축적 ===
      const injBriefNote = (event.payload.sceneFrame ?? rawInput).slice(0, 50);
      npcStates[injectedNpcId] = recordNpcEncounter(
        npcStates[injectedNpcId],
        turnNo,
        locationId,
        intent.actionType,
        resolveResult.outcome,
        injBriefNote,
      );

      // === 주입된 NPC LLM Summary 업데이트 ===
      npcStates[injectedNpcId].llmSummary = buildNpcLlmSummary(
        npcStates[injectedNpcId],
        this.content.getNpc(injectedNpcId),
        turnNo,
        (event.payload.sceneFrame ?? '').slice(0, 40),
        '',
      );

      // === 주입된 NPC 대화 주제 추적 ===
      {
        const topicEntry = buildTopicEntry(
          turnNo,
          null,
          null,
          event.payload.sceneFrame ?? null,
          intent.actionType,
          rawInput,
        );
        npcStates[injectedNpcId] = addRecentTopic(
          npcStates[injectedNpcId],
          topicEntry,
        );
      }
    }

    // 비도전 행위 여부 (MOVE_LOCATION, REST, SHOP, TALK → 주사위 UI 숨김)
    const isNonChallenge = ['MOVE_LOCATION', 'REST', 'SHOP'].includes(
      intent.actionType,
    );

    // 결과 조립 — 선택지 생성 전략:
    // 이벤트 첫 만남 → 이벤트 고유 선택지, 이미 상호작용한 이벤트 → resolve 후속 선택지
    const previousHistory = runState.actionHistory ?? [];
    const eventAlreadyInteracted = previousHistory.some(
      (h) => h.eventId === event.eventId,
    );
    const selectedChoiceIds = newHistory
      .filter((h) => h.choiceId)
      .map((h) => h.choiceId!);

    let choices: ChoiceItem[];
    if (eventAlreadyInteracted) {
      // 이미 상호작용한 이벤트 → resolve 결과 기반 후속 선택지 (sourceEventId 부분 적용 + eventType별 풀)
      choices = this.sceneShellService.buildFollowUpChoices(
        locationId,
        resolveResult.outcome,
        selectedChoiceIds,
        event.eventId,
        event.eventType,
        turnNo,
        resolvedChoices,
      );
    } else {
      // 첫 만남 이벤트 → 이벤트 고유 선택지
      choices = this.sceneShellService.buildLocationChoices(
        locationId,
        event.eventType,
        resolvedChoices,
        selectedChoiceIds,
        event.eventId,
      );
    }
    // NanoEventDirector 선택지 → LLM Worker에서 비동기 생성 후 llmChoices에 저장
    // 턴 응답에서는 서버 기본 선택지 사용

    // === 선택지별 예상 보정치(modifier) 부착 ===
    {
      const pBonuses = presetActionBonuses ?? {};
      for (const c of choices) {
        const aff = c.action.payload.affordance as string | undefined;
        const risk = c.action.payload.riskLevel as number | undefined;
        let mod = 0;
        if (event.matchPolicy === 'SUPPORT') mod += 1;
        if (event.matchPolicy === 'BLOCK') mod -= 1;
        mod -= event.friction;
        if (risk === 3) mod -= 1;
        if (aff && pBonuses[aff]) mod += pBonuses[aff];
        if (mod !== 0) c.modifier = mod;
      }
    }

    // summary.short: "이번 턴의 핵심 한 문장" — 행동 + 판정결과만 (sceneFrame 분리하여 중복 전달 방지)
    const outcomeLabel =
      resolveResult.outcome === 'SUCCESS'
        ? '성공'
        : resolveResult.outcome === 'PARTIAL'
          ? '부분 성공'
          : '실패';
    const actionLabel = this.actionTypeToKorean(intent.actionType);
    const summaryText = isNonChallenge
      ? `플레이어가 ${actionLabel}${korParticle(actionLabel, '을', '를')} 했다.`
      : `플레이어가 "${rawInput}"${korParticle(rawInput, '을', '를')} 시도하여 ${outcomeLabel}했다.`;
    const result = this.buildLocationResult(
      turnNo,
      currentNode,
      summaryText,
      resolveResult.outcome,
      choices,
      ws,
      {
        parsedType: intent.actionType,
        originalInput: rawInput,
        tone: intent.tone,
        escalated: intent.escalated,
        insistenceCount: insistenceCount > 0 ? insistenceCount : undefined,
        eventSceneFrame: resolvedSceneFrame,
        eventMatchPolicy: event.matchPolicy,
        eventId: event.eventId,
        // Player-First: 텍스트 매칭(extractTargetNpcFromInput)이 성공하면 intentV3 오파싱 override
        //   (bug 4624) IntentParserV2가 "하위크의 소매" 같은 구를 NPC_BG_FISHMONGER로
        //   오인식하는 경우 방지. LOCATION 분기의 earlyTargetNpcId는 스코프가 다르므로 재계산.
        primaryNpcId:
          this.extractTargetNpcFromInput(rawInput, body.input.type) ??
          event.payload.primaryNpcId ??
          null,
        goalCategory: intentV3.goalCategory,
        approachVector: intentV3.approachVector,
        goalText: intentV3.goalText,
        targetNpcId:
          this.extractTargetNpcFromInput(rawInput, body.input.type) ??
          intentV3.targetNpcId ??
          undefined,
        turnMode: event.eventId.startsWith('FREE_PLAYER_')
          ? 'PLAYER_DIRECTED'
          : event.eventId.startsWith('FREE_CONV_')
            ? 'CONVERSATION_CONT'
            : 'WORLD_EVENT',
      },
      isNonChallenge,
      totalGoldDelta,
      locationReward.items,
      isNonChallenge
        ? undefined
        : {
            diceRoll: resolveResult.diceRoll!,
            statKey: resolveResult.statKey ?? null,
            statValue: resolveResult.statValue ?? 0,
            statBonus: resolveResult.statBonus ?? 0,
            baseMod: resolveResult.baseMod ?? 0,
            totalScore: resolveResult.score,
          },
      allEquipmentAdded.length > 0 ? allEquipmentAdded : undefined,
    );

    // Posture 변화 이벤트 반영
    for (const pe of pendingPostureEvents) {
      result.events.push(pe);
    }

    // 이벤트 payload.itemRewards 이벤트 반영 (아이템 자체는 이미 locationReward.items 경유)
    for (const ire of pendingItemRewardEvents) {
      result.events.push(ire);
    }

    // 고집 2회째 경고 이벤트 — 다음 반복 시 에스컬레이션 예고
    if (intent.insistenceWarning) {
      const nextType = this.actionTypeToKorean(
        (
          {
            THREATEN: 'FIGHT',
            PERSUADE: 'THREATEN',
            OBSERVE: 'INVESTIGATE',
            TALK: 'PERSUADE',
            BRIBE: 'THREATEN',
            SNEAK: 'STEAL',
          } as Record<string, string>
        )[intent.actionType] ?? intent.actionType,
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

    // NanoEventDirector: nanoCtx를 ui에 저장 → LLM Worker에서 비동기 호출
    if (nanoEventCtx) {
      (result.ui as any).nanoEventCtx = nanoEventCtx;
    }
    // 하위 호환: nanoEventResult가 있으면 기존 방식으로도 전달
    if (nanoEventResult) {
      (result.ui as any).nanoEventHint = nanoEventResult;
    }

    // NPC 반응을 ui에 추가 (LLM 프롬프트 + 클라이언트 알림)
    if (npcReactions.length > 0) {
      (result.ui as any).npcReactions = npcReactions;
      // 반응 이벤트 추가
      for (const r of npcReactions) {
        result.events.push({
          id: `npc_reaction_${r.npcId}_${turnNo}`,
          kind: 'NPC' as any,
          text: r.text,
          tags: ['npc_reaction', r.type],
        });
      }
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
    // Portrait card: 첫 만남(encountered) 또는 첫 소개(introduced)인 NPC에게 초상화 표시
    // bug 4737 — 복합 카드: 한 턴에 여러 NPC 신규 등장 시 모두 한 카드에 표시
    const portraitCandidates = [
      ...new Set([...newlyEncounteredNpcIds, ...newlyIntroducedNpcIds]),
    ];
    if (portraitCandidates.length > 0) {
      const portraitNpcIds = portraitCandidates
        .filter((id) => NPC_PORTRAITS[id])
        .slice(0, 3); // 최대 3명 (과다 방지)
      if (portraitNpcIds.length > 0) {
        const firstId = portraitNpcIds[0];
        (result.ui as any).npcPortrait = {
          // 레거시 호환 (첫 번째 NPC)
          npcId: firstId,
          npcName: npcNames[firstId] ?? firstId,
          imageUrl: NPC_PORTRAITS[firstId],
          isNewlyIntroduced: newlyIntroducedNpcIds.includes(firstId),
          // 확장: 모든 신규 NPC 목록 (복합 카드)
          npcs: portraitNpcIds.map((id) => ({
            npcId: id,
            npcName: npcNames[id] ?? id,
            imageUrl: NPC_PORTRAITS[id],
            isNewlyIntroduced: newlyIntroducedNpcIds.includes(id),
          })),
        };
      }
    }

    // === Speaking NPC: 대사 주체 정보 (클라이언트 DialogueBubble용) ===
    // PROCEDURAL/SIT_ 이벤트에서 injectedNpc가 override한 경우 → 원래 이벤트의 primaryNpcId 사용
    // injectedNpc는 프롬프트 컨텍스트용이지 대사 주체가 아님
    const eventOriginalPrimaryNpc = (event.payload as Record<string, unknown>)
      ?.primaryNpcId as string | undefined;
    const isProcedural =
      event.eventId.startsWith('PROC_') || event.eventId.startsWith('SIT_');
    const primaryNpcIdForSpeaking = isProcedural
      ? (eventOriginalPrimaryNpc ?? null) // PROC/SIT: 원래 이벤트의 NPC만 (injected 무시)
      : (eventPrimaryNpc ?? eventOriginalPrimaryNpc ?? null); // 고정 이벤트: 기존 로직

    if (primaryNpcIdForSpeaking) {
      // NPC 지정 이벤트 — displayName/imageUrl 결정
      const npcStateForSpeaking = npcStates[primaryNpcIdForSpeaking];
      const npcDefForSpeaking = this.content.getNpc(primaryNpcIdForSpeaking);
      // 초상화 표시 조건: 첫 만남(enc>=1) 또는 소개완료(introduced) → 무조건 표시
      const showPortrait = npcStateForSpeaking
        ? (npcStateForSpeaking.encounterCount ?? 0) >= 1 ||
          !!npcStateForSpeaking.introduced
        : true;
      // npcNames에 없으면 content에서 직접 조회 (fallback)
      let displayName = npcNames[primaryNpcIdForSpeaking];
      if (!displayName) {
        const npcDef = this.content.getNpc(primaryNpcIdForSpeaking);
        displayName = npcDef
          ? npcDef.unknownAlias || npcDef.name || '낯선 인물'
          : '낯선 인물';
      }
      (result.ui as any).speakingNpc = {
        npcId: primaryNpcIdForSpeaking,
        displayName,
        imageUrl: showPortrait
          ? (NPC_PORTRAITS[primaryNpcIdForSpeaking] ?? undefined)
          : undefined,
      };
    } else {
      // NPC 미지정 이벤트 (일반 경비병, 행인 등) → 무명 인물 (실루엣 아이콘)
      (result.ui as any).speakingNpc = {
        npcId: null,
        displayName: '무명 인물',
        imageUrl: undefined,
      };
    }

    // === Narrative Engine v1: UI data 추가 ===
    const finalWs = updatedRunState.worldState!;
    // Signal Feed
    const signalFeedUI = (finalWs.signalFeed ?? []).map((s: any) => ({
      id: s.id,
      channel: s.channel,
      severity: s.severity,
      locationId: s.locationId,
      text: s.text,
    })) as SignalFeedItemUI[];
    (result.ui as any).signalFeed = signalFeedUI;

    // 호외 헤드라인: severity 3+ 시그널을 nano로 신문 기사 변환 (비동기, 실패 무시)
    const rawSignals = (finalWs.signalFeed ?? []) as Array<{
      id: string;
      channel: string;
      severity: number;
      text: string;
      sourceIncidentId?: string;
    }>;
    const importantRaw = rawSignals.filter((s) => s.severity >= 3);
    if (importantRaw.length > 0) {
      try {
        const incDefMap = new Map(incidentDefs.map((d) => [d.incidentId, d]));
        const locName =
          this.content.getLocation(locationId)?.name ?? locationId;
        const timePhase =
          (finalWs as any).timePhaseV2 ?? finalWs.timePhase ?? 'DAY';
        const newsContext = importantRaw.map((s) => ({
          text: s.text,
          channel: s.channel,
          severity: s.severity,
          location: locName,
          incidentTitle: s.sourceIncidentId
            ? incDefMap.get(s.sourceIncidentId)?.title
            : undefined,
          timePhase,
        }));
        const headlines = await this.generateNewsHeadlines(newsContext);
        if (headlines.length > 0) {
          (result.ui as any).newsHeadlines = headlines;
        }
      } catch {
        // nano 실패 시 원본 텍스트 사용
      }
    }

    // Active Incidents
    const incidentDefMap = new Map(incidentDefs.map((d) => [d.incidentId, d]));
    (result.ui as any).activeIncidents = (finalWs.activeIncidents ?? []).map(
      (i: IncidentRuntime) => ({
        incidentId: i.incidentId,
        title: incidentDefMap.get(i.incidentId)?.title ?? i.incidentId,
        kind: i.kind,
        stage: i.stage,
        control: i.control,
        pressure: i.pressure,
        deadlineClock: i.deadlineClock,
        resolved: i.resolved,
        outcome: i.outcome,
      }),
    ) as IncidentSummaryUI[];

    // NPC Emotional
    const npcEmotionalUIs: NpcEmotionalUI[] = Object.entries(npcStates).map(
      ([npcId, npc]) => ({
        npcId,
        npcName: npcNames[npcId] ?? npcId,
        trust: npc.emotional.trust,
        fear: npc.emotional.fear,
        respect: npc.emotional.respect,
        suspicion: npc.emotional.suspicion,
        attachment: npc.emotional.attachment,
        posture: npc.posture,
        marks: (finalWs.narrativeMarks ?? [])
          .filter((m: any) => m.npcId === npcId)
          .map((m: any) => m.type),
      }),
    );
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
      targetNpcId:
        intentV3.targetNpcId ??
        (event?.payload as any)?.primaryNpcId ??
        intent.target ??
        null,
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
        const shopDisplays = locShops
          .map((shopDef) => {
            const stock =
              updatedRunState.regionEconomy!.shopStocks[shopDef.shopId];
            return {
              shopId: shopDef.shopId,
              name: shopDef.name,
              items: stock
                ? this.shopService.getDisplayItems(
                    stock,
                    updatedRunState.regionEconomy!.priceIndex,
                  )
                : [],
            };
          })
          .filter((s) => s.items.length > 0);
        if (shopDisplays.length > 0) {
          (result.ui as any).shops = shopDisplays;
          (result.ui as any).priceIndex =
            updatedRunState.regionEconomy.priceIndex;
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
      id: `event_${event.eventId}`,
      kind: 'NPC',
      text: `${actionLabel} — ${event.eventType}`,
      tags: event.payload.tags,
    });

    // Step 10: Off-screen Tick (턴 커밋 전 RunState에 반영)
    const postTickRunState = this.orchestration.offscreenTick(
      updatedRunState,
      turnNo,
      resolveResult.outcome,
      event.payload.tags ?? [],
    );

    // === Narrative Engine v1: NPC passive drift (offscreen) ===
    if (postTickRunState.npcStates) {
      for (const [npcId, npc] of Object.entries(postTickRunState.npcStates)) {
        npc.emotional = this.npcEmotional.applyPassiveDrift(npc.emotional);
        postTickRunState.npcStates[npcId] =
          this.npcEmotional.syncLegacyFields(npc);
      }
    }

    // === Narrative Engine v1: Ending 조건 체크 ===
    const endWs = postTickRunState.worldState!;
    const { shouldEnd, reason: endReason } =
      this.endingGenerator.checkEndingConditions(
        endWs.activeIncidents ?? [],
        endWs.mainArcClock ?? {
          startDay: 1,
          softDeadlineDay: 14,
          triggered: false,
        },
        endWs.day ?? 1,
        turnNo,
      );

    // === Structured Memory v2: 실시간 수집 ===
    try {
      // NPC 감정 변화 delta 계산 (이번 턴에서 변경된 축만)
      let npcEmoDelta:
        | { npcId: string; delta: Record<string, number> }
        | undefined;
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
          eventId: event.eventId,
          sceneFrame: resolvedSceneFrame,
          primaryNpcId: effectiveNpcId ?? undefined,
          intentTargetNpcId: intentV3.targetNpcId ?? undefined,
          eventTags: event.payload.tags ?? [],
          summaryShort: summaryText ?? undefined,
          reputationChanges: resolveResult.reputationChanges,
          goldDelta: totalGoldDelta,
          incidentImpact: relevantIncident
            ? {
                incidentId: relevantIncident.incident.incidentId,
                controlDelta:
                  relevantIncident.incident.control -
                  (priorWsSnapshot.activeIncidents?.find(
                    (i) =>
                      i.incidentId === relevantIncident.incident.incidentId,
                  )?.control ?? 0),
                pressureDelta:
                  relevantIncident.incident.pressure -
                  (priorWsSnapshot.activeIncidents?.find(
                    (i) =>
                      i.incidentId === relevantIncident.incident.incidentId,
                  )?.pressure ?? 0),
              }
            : undefined,
          npcEmotionalDelta: npcEmoDelta as any,
          newMarks: newMarks.map((m) => m.type),
        },
      );
    } catch (err) {
      // 수집 실패는 게임 진행에 영향 없음
      this.logger.warn(
        `[MemoryCollector] collectFromTurn failed: ${(err as Error).message}`,
      );
    }

    // 파이프라인 로그를 serverResult에 포함 (commitTurnRecord 전에 추가해야 DB에 저장됨)
    (result as any)._pipelineLog = {
      intent: {
        rawInput: rawInput.slice(0, 100),
        parsedType: intent.actionType,
        secondaryType: intent.secondaryActionType ?? null,
        targetNpcId: intentV3.targetNpcId ?? null,
        tone: intent.tone,
        confidence: intent.confidence,
        source: intent.source,
      },
      event: {
        eventId: event.eventId,
        matchPolicy: event.matchPolicy,
        friction: event.friction,
        primaryNpcId: event.payload?.primaryNpcId ?? null,
        sceneFrame: (resolvedSceneFrame ?? '').slice(0, 100),
      },
      resolve: {
        outcome: resolveResult.outcome,
        diceRoll: resolveResult.diceRoll,
        statKey: resolveResult.statKey ?? null,
        statBonus: resolveResult.statBonus ?? 0,
        baseMod: resolveResult.baseMod ?? 0,
        totalScore: resolveResult.score ?? 0,
      },
      npc: {
        targetNpcId: intentV3.targetNpcId ?? effectiveNpcId ?? null,
        posture:
          orchestrationResult?.npcPostures?.[effectiveNpcId ?? ''] ?? null,
      },
      orchestration: orchestrationResult
        ? {
            peakMode: orchestrationResult.peakMode,
            pressure: orchestrationResult.pressure,
            npcInjectionId: orchestrationResult.npcInjection?.npcId ?? null,
          }
        : undefined,
    };

    // 엔딩 조건 충족 시 — commitTurnRecord 이전에 endingResult를 result.ui에 주입해야
    // DB에 저장되고 이후 재조회·재접속에서도 EndingScreen 데이터가 복원 가능함.
    if (shouldEnd && endReason) {
      // Fixplan3-P1: RUN_ENDED 전 structuredMemory 통합 (go_hub 없이 런 종료 시 누락 방지)
      try {
        const locMemEnd = await this.memoryIntegration.finalizeVisit(
          run.id,
          currentNode.id,
          postTickRunState,
          turnNo,
        );
        if (locMemEnd) postTickRunState.locationMemories = locMemEnd;
      } catch {
        /* 메모리 통합 실패는 엔딩 생성에 영향 없음 */
      }

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
        postTickRunState.npcStates ?? {},
        endWs.narrativeMarks ?? [],
        endWs as unknown as Record<string, unknown>,
        postTickRunState.arcState ?? null,
        postTickRunState.actionHistory ?? [],
        endingThreads,
      );
      const endingResult = this.endingGenerator.generateEnding(
        endingInput,
        endReason,
        turnNo,
      );

      // 엔딩 결과를 UI + 이벤트에 노출 (commitTurnRecord 이전에 수행)
      (result.ui as any).endingResult = endingResult;
      result.events.push({
        id: `ending_${turnNo}`,
        kind: 'SYSTEM',
        text: `[엔딩] ${endingResult.closingLine}`,
        tags: ['RUN_ENDED'],
        data: { endingResult },
      });

      // Journey Archive Phase 1: EndingSummary 조립 (템플릿 기반, 실패해도 엔딩 진행)
      let endingSummary: ReturnType<
        SummaryBuilderService['buildEndingSummary']
      > | null = null;
      try {
        const now = new Date();
        endingSummary = this.summaryBuilder.buildEndingSummary(
          {
            id: run.id,
            presetId: run.presetId ?? null,
            gender: (run.gender as 'male' | 'female' | null) ?? null,
            updatedAt: now,
            currentTurnNo: turnNo,
          },
          postTickRunState,
          endingResult,
        );
      } catch (e) {
        this.logger.warn(
          `EndingSummary build failed (NATURAL/DEADLINE) runId=${run.id}: ${String(e)}`,
        );
      }

      await this.commitTurnRecord(
        run,
        currentNode,
        turnNo,
        body,
        rawInput,
        result,
        postTickRunState,
        body.options?.skipLlm,
        intent,
      );

      // RUN_ENDED로 상태 변경 + Campaign 저장 (commit 후 side-effect만 남김)
      await this.db
        .update(runSessions)
        .set({
          status: 'RUN_ENDED',
          updatedAt: new Date(),
          ...(endingSummary ? { endingSummary } : {}),
        })
        .where(eq(runSessions.id, run.id));
      await this.saveCampaignResultIfNeeded(run.id);

      return {
        accepted: true,
        turnNo,
        serverResult: result,
        llm: {
          status: (body.options?.skipLlm ? 'SKIPPED' : 'PENDING') as LlmStatus,
          narrative: null,
        },
        meta: { nodeOutcome: 'RUN_ENDED', policyResult: 'ALLOW' },
      };
    }

    // 일반(non-ending) 경로 — commitTurnRecord 호출
    await this.commitTurnRecord(
      run,
      currentNode,
      turnNo,
      body,
      rawInput,
      result,
      postTickRunState,
      body.options?.skipLlm,
      intent,
    );

    return {
      accepted: true,
      turnNo,
      serverResult: result,
      llm: {
        status: (body.options?.skipLlm ? 'SKIPPED' : 'PENDING') as LlmStatus,
        narrative: null,
      },
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
    if (resolveResult.goldDelta)
      updatedRunState.gold += resolveResult.goldDelta;
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
        const existing = updatedRunState.inventory.find(
          (i) => i.itemId === item.itemId,
        );
        if (existing) existing.qty += item.qty;
        else
          updatedRunState.inventory.push({
            itemId: item.itemId,
            qty: item.qty,
          });
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
        await this.saveCampaignResultIfNeeded(run.id);
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
        await this.saveCampaignResultIfNeeded(run.id);

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

    let parsedIntent: ParsedIntent | undefined;
    let actionPlan: ActionPlan | undefined;
    let policyResult: 'ALLOW' | 'TRANSFORM' | 'PARTIAL' | 'DENY' = 'ALLOW';
    let transformedIntent: ParsedIntent | undefined;

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
        return this.commitCombatTurn(
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
      const existing = updatedRunState.inventory.find(
        (i) => i.itemId === added.itemId,
      );
      if (existing) existing.qty += added.qty;
      else
        updatedRunState.inventory.push({
          itemId: added.itemId,
          qty: added.qty,
        });
    }

    // Phase 4a: 전투 승리 시 장비 드랍
    if (resolveResult.combatOutcome === 'VICTORY') {
      const locationId =
        updatedRunState.worldState?.currentLocationId ?? 'LOC_HARBOR';
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
          this.recordItemMemory(
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

      // 패배 시 RUN_ENDED + 엔딩 내러티브 생성
      if (resolveResult.combatOutcome === 'DEFEAT') {
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
            ...(endingSummaryCombat
              ? { endingSummary: endingSummaryCombat }
              : {}),
          })
          .where(eq(runSessions.id, run.id));

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
          await this.saveCampaignResultIfNeeded(run.id);
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
          const locationId = ws.currentLocationId ?? 'LOC_MARKET';

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
  private async commitCombatTurn(
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

  // --- Helper: 일반 턴 레코드 커밋 ---
  private async commitTurnRecord(
    run: any,
    currentNode: any,
    turnNo: number,
    body: SubmitTurnBody,
    rawInput: string,
    serverResult: ServerResultV1,
    runStateUpdate: RunState,
    skipLlm?: boolean,
    intent?: Record<string, unknown> | null,
  ) {
    const llmStatus: LlmStatus = skipLlm ? 'SKIPPED' : 'PENDING';
    await this.db.insert(turns).values({
      runId: run.id,
      turnNo,
      nodeInstanceId: currentNode.id,
      nodeType: currentNode.nodeType as NodeType,
      inputType: body.input.type,
      rawInput,
      idempotencyKey: body.idempotencyKey,
      parsedBy: (intent?.source as any) ?? null,
      confidence: (intent?.confidence as number) ?? null,
      parsedIntent: (intent as any) ?? null,
      policyResult: 'ALLOW',
      transformedIntent: null,
      actionPlan: null,
      serverResult,
      llmStatus,
    });
    await this.db
      .update(runSessions)
      .set({
        currentTurnNo: turnNo,
        runState: runStateUpdate,
        updatedAt: new Date(),
      })
      .where(eq(runSessions.id, run.id));
  }

  // --- Result builders ---
  private buildSystemResult(
    turnNo: number,
    node: any,
    text: string,
  ): ServerResultV1 {
    return {
      version: 'server_result_v1',
      turnNo,
      node: {
        id: node.id,
        type: node.nodeType,
        index: node.nodeIndex,
        state: 'NODE_ACTIVE',
      },
      summary: { short: text, display: text },
      events: [{ id: `sys_${turnNo}`, kind: 'SYSTEM', text, tags: [] }],
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

  private buildHubActionResult(
    turnNo: number,
    node: any,
    text: string,
    choices: ServerResultV1['choices'],
    ws: WorldState,
  ): ServerResultV1 {
    return {
      ...this.buildSystemResult(turnNo, node, text),
      ui: {
        availableActions: ['CHOICE'],
        targetLabels: [],
        actionSlots: { base: 2, bonusAvailable: false, max: 3 },
        toneHint: 'neutral',
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
      const outcome = (sr?.ui as Record<string, unknown>)?.resolveOutcome as
        | string
        | undefined;
      const outcomeText =
        outcome === 'SUCCESS'
          ? '성공'
          : outcome === 'PARTIAL'
            ? '부분 성공'
            : outcome === 'FAIL'
              ? '실패'
              : '';
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
    const npcPart =
      mentionedNpcs.size > 0
        ? ` 만난 인물: ${[...mentionedNpcs].join(', ')}.`
        : '';

    const visitSummary =
      `[${locName} 방문]${npcPart} ${summaryLines.join('; ')}`.slice(0, 600);

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
    run: any,
    currentNode: any,
    turnNo: number,
    body: SubmitTurnBody,
    rawInput: string,
    runState: RunState,
    ws: WorldState,
    arcState: ArcState,
    fromLocationId: string,
    toLocationId: string,
  ) {
    const updatedRunState: RunState = { ...runState };

    // Structured Memory v2: 방문 종료 통합
    const locMemTransition = await this.memoryIntegration.finalizeVisit(
      run.id,
      currentNode.id,
      runState,
      turnNo,
    );
    if (locMemTransition) updatedRunState.locationMemories = locMemTransition;

    // WorldState 업데이트
    const newWs = this.worldStateService.moveToLocation(ws, toLocationId);
    updatedRunState.worldState = newWs;
    updatedRunState.actionHistory = []; // 이동 시 고집 이력 초기화

    // 현재 노드 종료
    await this.db
      .update(nodeInstances)
      .set({ status: 'NODE_ENDED', updatedAt: new Date() })
      .where(eq(nodeInstances.id, currentNode.id));

    // 이동 턴 커밋
    const locationNames: Record<string, string> = {
      LOC_MARKET: '시장 거리',
      LOC_GUARD: '경비대 지구',
      LOC_HARBOR: '항만 부두',
      LOC_SLUMS: '빈민가',
      LOC_NOBLE: '상류 거리',
      LOC_TAVERN: '잠긴 닻 선술집',
      LOC_DOCKS_WAREHOUSE: '항만 창고구',
    };
    const toName = locationNames[toLocationId] ?? toLocationId;
    const moveResult = this.buildSystemResult(
      turnNo,
      currentNode,
      `${toName}(으)로 향한다.`,
    );
    await this.commitTurnRecord(
      run,
      currentNode,
      turnNo,
      body,
      rawInput,
      moveResult,
      updatedRunState,
      body.options?.skipLlm,
    );

    // 새 LOCATION 노드 생성
    const transition = await this.nodeTransition.transitionToLocation(
      run.id,
      currentNode.nodeIndex,
      turnNo + 1,
      toLocationId,
      updatedRunState.worldState,
      updatedRunState,
    );

    // 전환 턴 생성
    transition.enterResult.turnNo = turnNo + 1;
    await this.db.insert(turns).values({
      runId: run.id,
      turnNo: turnNo + 1,
      nodeInstanceId: transition.enterResult.node.id,
      nodeType: 'LOCATION',
      inputType: 'SYSTEM',
      rawInput: '',
      idempotencyKey: `${run.id}_loc_${transition.nextNodeIndex}`,
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

    return {
      accepted: true,
      turnNo,
      serverResult: moveResult,
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
        targetInstance = equipmentBag.find(
          (i) =>
            normalized.includes(i.displayName.toLowerCase()) ||
            normalized.includes(
              (this.content.getItem(i.baseItemId)?.name ?? '').toLowerCase(),
            ),
        );
      }

      if (!targetInstance) {
        // 가방에 장비가 있으면 첫 번째 아이템 자동 선택
        if (equipmentBag.length > 0) {
          targetInstance = equipmentBag[0];
        } else {
          const result = this.buildSystemResult(
            turnNo,
            currentNode,
            '장착할 장비가 가방에 없다.',
          );
          await this.commitTurnRecord(
            run,
            currentNode,
            turnNo,
            body,
            rawInput,
            result,
            runState,
            true,
          );
          return {
            accepted: true,
            turnNo,
            serverResult: result,
            llm: { status: 'SKIPPED' as LlmStatus, narrative: null },
            meta: { nodeOutcome: 'ONGOING', policyResult: 'ALLOW' },
          };
        }
      }

      // 장비 착용
      const { equipped: newEquipped, unequippedInstance } =
        this.equipmentService.equip(equipped, targetInstance);
      const updatedBag = equipmentBag.filter(
        (i) => i.instanceId !== targetInstance.instanceId,
      );
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
        data: {
          equipped: targetInstance.baseItemId,
          unequipped: unequippedInstance?.baseItemId,
        },
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
        if (
          keywords.some((kw) => normalized.includes(kw)) &&
          equipped[slot as keyof typeof equipped]
        ) {
          targetSlot = slot;
          break;
        }
      }

      // 아이템 이름 매칭
      if (!targetSlot) {
        for (const slot of EQUIPMENT_SLOTS) {
          const instance = equipped[slot];
          if (!instance) continue;
          if (
            normalized.includes(instance.displayName.toLowerCase()) ||
            normalized.includes(
              (
                this.content.getItem(instance.baseItemId)?.name ?? ''
              ).toLowerCase(),
            )
          ) {
            targetSlot = slot;
            break;
          }
        }
      }

      if (!targetSlot) {
        const result = this.buildSystemResult(
          turnNo,
          currentNode,
          '해제할 장비를 특정할 수 없다.',
        );
        await this.commitTurnRecord(
          run,
          currentNode,
          turnNo,
          body,
          rawInput,
          result,
          runState,
          true,
        );
        return {
          accepted: true,
          turnNo,
          serverResult: result,
          llm: { status: 'SKIPPED' as LlmStatus, narrative: null },
          meta: { nodeOutcome: 'ONGOING', policyResult: 'ALLOW' },
        };
      }

      const { equipped: newEquipped, unequippedInstance } =
        this.equipmentService.unequip(
          equipped,
          targetSlot as import('../db/types/equipment.js').EquipmentSlot,
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
    await this.commitTurnRecord(
      run,
      currentNode,
      turnNo,
      body,
      rawInput,
      result,
      runState,
      body.options?.skipLlm,
    );
    await this.db
      .update(runSessions)
      .set({ runState, updatedAt: new Date() })
      .where(eq(runSessions.id, run.id));

    return {
      accepted: true,
      turnNo,
      serverResult: result,
      llm: {
        status: (body.options?.skipLlm ? 'SKIPPED' : 'PENDING') as LlmStatus,
        narrative: null,
      },
      meta: { nodeOutcome: 'ONGOING', policyResult: 'ALLOW' },
    };
  }

  /** 자유 텍스트에서 목표 위치 추출 */
  private extractTargetLocation(
    input: string,
    _currentLocationId: string,
  ): string | null {
    const normalized = input.toLowerCase();
    const locationKeywords: Array<{ keywords: string[]; locationId: string }> =
      [
        {
          keywords: [
            '시장',
            '상점가',
            '장터',
            '노점가',
            '노점',
            '좌판거리',
            '상인들이 모인',
            '물건 파는',
          ],
          locationId: 'LOC_MARKET',
        },
        {
          keywords: [
            '경비대',
            '경비',
            '초소',
            '병영',
            '수비대',
            '순찰대',
            '경비병',
            '병사들',
            '관청',
          ],
          locationId: 'LOC_GUARD',
        },
        {
          keywords: [
            '항만',
            '부두',
            '항구',
            '선착장',
            '포구',
            '배터',
            '창고가',
            '선박',
            '정박',
            '바닷가',
          ],
          locationId: 'LOC_HARBOR',
        },
        {
          keywords: [
            '빈민가',
            '빈민',
            '슬럼',
            '뒷골목',
            '하층가',
            '빈민굴',
            '어두운 골목',
            '허름한 골목',
          ],
          locationId: 'LOC_SLUMS',
        },
        {
          keywords: [
            '귀족',
            '상류',
            '저택',
            '귀족가',
            '귀족 거리',
            '정원',
            '의회',
            '노블',
          ],
          locationId: 'LOC_NOBLE',
        },
        {
          keywords: ['선술집', '잠긴 닻', '숙소', '주점', '술집', '거점'],
          locationId: 'LOC_TAVERN',
        },
        {
          keywords: [
            '창고',
            '창고구',
            '창고 지구',
            '물류',
            '하역장',
            '화물 창고',
          ],
          locationId: 'LOC_DOCKS_WAREHOUSE',
        },
        {
          keywords: ['거점', '본거지', '돌아가'],
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
    history: Array<{
      actionType: string;
      suppressedActionType?: string;
      inputText: string;
    }>,
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

  /** 시그널을 신문 호외 기사로 변환 (nano LLM, 컨텍스트 보강) */
  private async generateNewsHeadlines(
    signals: Array<{
      text: string;
      channel: string;
      severity: number;
      location: string;
      incidentTitle?: string;
      timePhase: string;
    }>,
  ): Promise<string[]> {
    if (!this.llmCaller) return signals.map((s) => s.text);

    const CHANNEL_KR: Record<string, string> = {
      RUMOR: '소문',
      SECURITY: '치안',
      NPC_BEHAVIOR: '인물',
      ECONOMY: '경제',
      VISUAL: '목격',
    };
    const TIME_KR: Record<string, string> = {
      DAY: '낮',
      NIGHT: '밤',
      DAWN: '새벽',
      DUSK: '해질녘',
    };

    const joined = signals
      .map((s, i) => {
        const parts = [`${i + 1}. "${s.text}"`];
        parts.push(`장소: ${s.location}`);
        parts.push(`분류: ${CHANNEL_KR[s.channel] ?? s.channel}`);
        parts.push(`시간: ${TIME_KR[s.timePhase] ?? s.timePhase}`);
        if (s.incidentTitle) parts.push(`관련 사건: ${s.incidentTitle}`);
        parts.push(`긴급도: ${s.severity}/5`);
        return parts.join(', ');
      })
      .join('\n');

    const raw = await this.llmCaller.callLight({
      messages: [
        {
          role: 'system',
          content: `당신은 중세 판타지 항구도시 "그레이마르"의 호외 신문 기자이다.
각 소식을 2~3문장의 신문 기사 본문으로 확장하라.

규칙:
- 장소, 시간대, 관련 사건 정보를 자연스럽게 녹여라
- 3인칭 객관적 보도체 ("~것으로 알려졌다", "~정황이 포착되었다", "~것으로 전해진다")
- 구체적 디테일을 추가하라 (목격자 증언, 경비대 반응, 주민 반응 등)
- 번호를 유지하여 출력
- 각 기사는 2~3문장`,
        },
        { role: 'user', content: joined },
      ],
      maxTokens: 400,
      temperature: 0.7,
    });

    if (!raw) return signals.map((s) => s.text);
    return raw
      .split('\n')
      .map((line) => line.replace(/^\d+\.\s*/, '').trim())
      .filter((line) => line.length > 0)
      .slice(0, signals.length);
  }

  /** IntentActionType → 한국어 라벨 (summary.short용) */
  private actionTypeToKorean(actionType: string): string {
    const map: Record<string, string> = {
      INVESTIGATE: '조사',
      PERSUADE: '설득',
      SNEAK: '은밀 행동',
      BRIBE: '뇌물',
      THREATEN: '위협',
      HELP: '도움',
      STEAL: '절도',
      FIGHT: '전투',
      OBSERVE: '관찰',
      TRADE: '거래',
      TALK: '대화',
      SEARCH: '탐색',
      MOVE_LOCATION: '이동',
      REST: '휴식',
      SHOP: '상점 이용',
    };
    return map[actionType] ?? actionType;
  }

  private buildLocationResult(
    turnNo: number,
    node: any,
    text: string,
    outcome: string,
    choices: ServerResultV1['choices'],
    ws: WorldState,
    actionContext?: {
      parsedType: string;
      originalInput: string;
      tone: string;
      escalated?: boolean;
      insistenceCount?: number;
      eventSceneFrame?: string;
      eventMatchPolicy?: string;
      eventId?: string;
      primaryNpcId?: string | null;
      goalCategory?: string;
      approachVector?: string;
      goalText?: string;
      targetNpcId?: string;
      /** Player-First: 턴 모드 (PLAYER_DIRECTED / CONVERSATION_CONT / WORLD_EVENT) */
      turnMode?: string;
    },
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
        availableActions: ['ACTION', 'CHOICE'],
        targetLabels: [],
        actionSlots: { base: 2, bonusAvailable: false, max: 3 },
        toneHint:
          outcome === 'FAIL'
            ? 'danger'
            : outcome === 'SUCCESS'
              ? 'triumph'
              : 'neutral',
        worldState: {
          hubHeat: ws.hubHeat,
          hubSafety: ws.hubSafety,
          timePhase: ws.timePhase,
          currentLocationId: ws.currentLocationId,
          locationDynamicStates: ws.locationDynamicStates ?? {},
          playerGoals: (ws.playerGoals ?? []).filter((g) => !g.completed),
          reputation: ws.reputation ?? {},
        },
        // 비도전 행위는 주사위 UI를 표시하지 않음
        ...(hideResolve ? {} : { resolveOutcome: outcome as any }),
        ...(resolveBreakdown ? { resolveBreakdown } : {}),
        ...(actionContext ? { actionContext } : {}),
      },
      choices,
    };
  }

  private buildDenyResult(
    turnNo: number,
    node: any,
    reason: string,
  ): ServerResultV1 {
    return {
      ...this.buildSystemResult(turnNo, node, reason),
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
  private mapCombatChoiceToActionPlan(choiceId: string): ActionPlan {
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

  private parseComboChoiceToActionPlan(choiceId: string): ActionPlan {
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

  private parseCombatChoiceId(
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
        tokenStats: turn.llmTokenStats ?? null,
        choices: turn.llmChoices ?? null,
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
        llmPrompt: turn.llmPrompt ?? null,
      };
    }

    return response;
  }

  /**
   * LLM 재시도 — FAILED 상태의 턴을 PENDING으로 리셋하여 Worker가 다시 처리하도록 한다.
   */
  async retryLlm(runId: string, turnNo: number, userId: string) {
    const run = await this.db.query.runSessions.findFirst({
      where: eq(runSessions.id, runId),
    });
    if (!run) throw new NotFoundError('Run not found');
    if (run.userId !== userId) throw new ForbiddenError('Not your run');

    const turn = await this.db.query.turns.findFirst({
      where: and(eq(turns.runId, runId), eq(turns.turnNo, turnNo)),
    });
    if (!turn) throw new NotFoundError('Turn not found');

    if (turn.llmStatus !== 'FAILED') {
      throw new InvalidInputError(
        `Cannot retry: current LLM status is ${turn.llmStatus}`,
      );
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
    const run = await this.db.query.runSessions.findFirst({
      where: eq(runSessions.id, runId),
    });
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

  // ── Player-First: 턴 모드 결정 ──
  private determineTurnMode(ctx: {
    earlyTargetNpcId: string | null;
    intentV3TargetNpcId: string | null;
    actionType: string;
    lastPrimaryNpcId: string | null;
    /** 직전 턴의 primaryNpcId (행동 종류 무관 — FIGHT 후에도 유지) */
    contextNpcId: string | null;
    isFirstTurnAtLocation: boolean;
    incidentPressureHigh: boolean;
    questFactTrigger: boolean;
  }): TurnMode {
    const SOCIAL_ACTIONS = new Set([
      'TALK',
      'PERSUADE',
      'BRIBE',
      'THREATEN',
      'HELP',
      'INVESTIGATE',
      'OBSERVE',
      'TRADE',
    ]);

    // 1) 플레이어가 NPC를 명시적으로 지목
    if (ctx.earlyTargetNpcId || ctx.intentV3TargetNpcId) {
      if (ctx.isFirstTurnAtLocation) {
        return TurnMode.WORLD_EVENT;
      }
      return TurnMode.PLAYER_DIRECTED;
    }

    // 2) 대화 연속 (SOCIAL_ACTION + 이전 대화 NPC 존재)
    if (ctx.lastPrimaryNpcId && SOCIAL_ACTIONS.has(ctx.actionType)) {
      if (ctx.isFirstTurnAtLocation) {
        return TurnMode.WORLD_EVENT;
      }
      return TurnMode.CONVERSATION_CONT;
    }

    // 2b) 맥락 NPC 연결 — FIGHT/STEAL 후 TALK 시 직전 NPC를 대화 대상으로 유지
    // "이게 뭔지 대답해" 같이 대상 미명시 + 직전 턴에 NPC가 있었으면 맥락 연결
    if (ctx.contextNpcId && SOCIAL_ACTIONS.has(ctx.actionType)) {
      if (ctx.isFirstTurnAtLocation) {
        return TurnMode.WORLD_EVENT;
      }
      return TurnMode.CONVERSATION_CONT;
    }

    // 3) 강제 세계 이벤트 (축소된 조건)
    if (
      ctx.isFirstTurnAtLocation ||
      ctx.incidentPressureHigh ||
      ctx.questFactTrigger
    ) {
      return TurnMode.WORLD_EVENT;
    }

    // 4) 기본값: 플레이어 주도 (이벤트 강제 없음)
    return TurnMode.PLAYER_DIRECTED;
  }

  // ── Player-First: 입력 텍스트에서 NPC 추출 (turnMode 결정용) ──
  private extractTargetNpcFromInput(
    rawInput: string,
    inputType: string,
  ): string | null {
    if (inputType !== 'ACTION' || !rawInput) return null;

    const inputLower = rawInput.toLowerCase();
    const allNpcs = this.content.getAllNpcs();

    // Pass 1: 실명/unknownAlias/aliases/shortAlias 전체 매칭 (bug 4620)
    //   이전엔 name/unknownAlias만 검사 — aliases/shortAlias 누락으로 "하위크"
    //   같은 단독 별칭 입력 시 타깃 NPC 식별 실패했음.
    for (const npc of allNpcs) {
      if (npc.name && inputLower.includes(npc.name.toLowerCase()))
        return npc.npcId;
      if (
        npc.unknownAlias &&
        inputLower.includes(npc.unknownAlias.toLowerCase())
      )
        return npc.npcId;
      if (
        (npc as Record<string, unknown>).shortAlias &&
        inputLower.includes(
          ((npc as Record<string, unknown>).shortAlias as string).toLowerCase(),
        )
      )
        return npc.npcId;
      const aliases = (npc as Record<string, unknown>).aliases as
        | string[]
        | undefined;
      if (aliases && aliases.length > 0) {
        for (const al of aliases) {
          if (al && al.length >= 2 && inputLower.includes(al.toLowerCase()))
            return npc.npcId;
        }
      }
    }

    // Pass 2: "~에게" 패턴
    const egeMatch = rawInput.match(/(.+?)에게/);
    if (egeMatch) {
      const targetWord = egeMatch[1].trim().toLowerCase();
      for (const npc of allNpcs) {
        if (npc.name && targetWord.includes(npc.name.toLowerCase()))
          return npc.npcId;
        const aliasKw = npc.unknownAlias?.split(/\s+/) ?? [];
        if (
          aliasKw.some(
            (kw: string) =>
              kw.length >= 2 && targetWord.includes(kw.toLowerCase()),
          )
        )
          return npc.npcId;
        // aliases도 "에게" 패턴 타겟 비교
        const aliases = (npc as Record<string, unknown>).aliases as
          | string[]
          | undefined;
        if (aliases && aliases.length > 0) {
          for (const al of aliases) {
            if (al && al.length >= 2 && targetWord.includes(al.toLowerCase()))
              return npc.npcId;
          }
        }
      }
    }

    // Pass 3: 별칭 키워드 부분 매칭 (3자 이상)
    for (const npc of allNpcs) {
      const aliasKw = npc.unknownAlias?.split(/\s+/) ?? [];
      if (
        aliasKw.some(
          (kw: string) =>
            kw.length >= 3 && inputLower.includes(kw.toLowerCase()),
        )
      )
        return npc.npcId;
    }

    return null;
  }
}
