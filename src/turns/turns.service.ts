// 정본: specs/HUB_system.md — Action-First 턴 파이프라인

import { Inject, Injectable } from '@nestjs/common';
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
import { DEFAULT_PERMANENT_STATS } from '../db/types/index.js';
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
import { TurnOrchestrationService } from '../engine/hub/turn-orchestration.service.js';
// Narrative Engine v1
import { WorldTickService } from '../engine/hub/world-tick.service.js';
import { IncidentManagementService } from '../engine/hub/incident-management.service.js';
import { NpcEmotionalService } from '../engine/hub/npc-emotional.service.js';
import { NarrativeMarkService } from '../engine/hub/narrative-mark.service.js';
import { EndingGeneratorService } from '../engine/hub/ending-generator.service.js';
import { MemoryCollectorService } from '../engine/hub/memory-collector.service.js';
import { MemoryIntegrationService } from '../engine/hub/memory-integration.service.js';
import { initNPCState } from '../db/types/npc-state.js';
import type { IncidentDef, IncidentRuntime, NarrativeMarkCondition, NPCState, NpcEmotionalState } from '../db/types/index.js';
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
    // Narrative Engine v1
    private readonly worldTick: WorldTickService,
    private readonly incidentMgmt: IncidentManagementService,
    private readonly npcEmotional: NpcEmotionalService,
    private readonly narrativeMarkService: NarrativeMarkService,
    private readonly endingGenerator: EndingGeneratorService,
    // Structured Memory v2
    private readonly memoryCollector: MemoryCollectorService,
    private readonly memoryIntegration: MemoryIntegrationService,
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
    const playerStats = profile?.permanentStats ?? DEFAULT_PERMANENT_STATS;

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
    let ws = runState.worldState ?? this.worldStateService.initWorldState();
    const arcState = runState.arcState ?? this.arcService.initArcState();
    let agenda = runState.agenda ?? this.agendaService.initAgenda();
    const cooldowns = runState.eventCooldowns ?? {};
    const locationId = ws.currentLocationId ?? (currentNode.nodeMeta as any)?.locationId ?? 'LOC_MARKET';
    const updatedRunState: RunState = { ...runState };

    // go_hub 선택 시 → HUB 복귀
    if (body.input.type === 'CHOICE' && body.input.choiceId === 'go_hub') {
      // Structured Memory v2: 방문 종료 통합 (기존 saveLocationVisitSummary 역할 포함)
      await this.memoryIntegration.finalizeVisit(run.id, currentNode.id, runState, turnNo);

      ws = this.worldStateService.returnToHub(ws);
      updatedRunState.worldState = ws;
      updatedRunState.actionHistory = []; // HUB 복귀 시 고집 이력 초기화

      await this.db.update(nodeInstances)
        .set({ status: 'NODE_ENDED', updatedAt: new Date() })
        .where(eq(nodeInstances.id, currentNode.id));

      const result = this.buildSystemResult(turnNo, currentNode, '거점으로 돌아간다.');
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
        columns: { serverResult: true },
      });
      const prevChoices = (prevTurn?.serverResult as ServerResultV1 | null)?.choices;
      const matched = prevChoices?.find((c) => c.id === body.input.choiceId);
      if (matched) {
        rawInput = matched.label;
        choicePayload = matched.action.payload;
      }
    }

    // 고집(insistence) 카운트 계산: 같은 actionType 연속 반복 횟수
    const actionHistory = runState.actionHistory ?? [];
    const { count: insistenceCount, repeatedType } = this.calculateInsistenceCount(actionHistory);
    const intent = await this.llmIntentParser.parseWithInsistence(rawInput, source, choicePayload, insistenceCount, repeatedType, locationId);

    // MOVE_LOCATION: 자유 텍스트로 다른 LOCATION 이동 요청 시 실제 전환
    if (intent.actionType === 'MOVE_LOCATION' && body.input.type === 'ACTION') {
      const targetLocationId = this.extractTargetLocation(rawInput, locationId);
      if (targetLocationId && targetLocationId !== locationId) {
        return this.performLocationTransition(
          run, currentNode, turnNo, body, rawInput, runState, ws, arcState, locationId, targetLocationId,
        );
      }
    }

    // 이벤트 연속성: 의도 기반 씬 연속성 판단 (3단계)
    const sourceEventId = choicePayload?.sourceEventId as string | undefined;
    const rng = this.rngService.create(run.seed, turnNo);
    let matchedEvent: ReturnType<typeof this.eventMatcher.match> = null;

    // Step 1: CHOICE의 sourceEventId → 명시적 씬 유지 (플레이어의 선택)
    if (sourceEventId) {
      matchedEvent = this.content.getEventById(sourceEventId) ?? null;
    }

    // Step 2: ACTION(자유 텍스트) → 현재 씬 유지 (플레이어가 씬과 능동적으로 대화 중)
    //   예외: MOVE_LOCATION 의도, FALLBACK 이벤트(placeholder라 유지 의미 없음)
    //   예외: 같은 이벤트가 연속 2턴 이상 사용 시 새 이벤트로 전환 (반복 방지)
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
          // 연속 2턴 이하만 씬 유지, 3턴째부터는 새 이벤트 매칭으로 전환
          if (consecutiveCount < 2) {
            matchedEvent = lastEvent;
          }
        }
      }
    }

    // Step 3: 새 이벤트 매칭 (전환 CHOICE, 첫 턴, FALLBACK 탈출, MOVE_LOCATION)
    if (!matchedEvent) {
      const allEvents = this.content.getAllEventsV2();
      const recentEventIds = actionHistory
        .filter((h) => h.eventId)
        .map((h) => h.eventId!);
      matchedEvent = this.eventMatcher.match(
        allEvents, locationId, intent, ws, arcState, agenda, cooldowns, turnNo, rng, recentEventIds,
      );
    }

    if (!matchedEvent) {
      // fallback 결과
      const selectedChoiceIds = actionHistory
        .filter((h) => h.choiceId)
        .map((h) => h.choiceId!);
      const choices = this.sceneShellService.buildLocationChoices(locationId, undefined, undefined, selectedChoiceIds);
      const result = this.buildLocationResult(turnNo, currentNode, '특별한 일이 일어나지 않았다.', 'PARTIAL', choices, ws);
      await this.commitTurnRecord(run, currentNode, turnNo, body, rawInput, result, updatedRunState, body.options?.skipLlm);
      return { accepted: true, turnNo, serverResult: result, llm: { status: 'PENDING' as LlmStatus, narrative: null }, meta: { nodeOutcome: 'ONGOING', policyResult: 'ALLOW' } };
    }

    // ResolveService 판정
    const resolveResult = this.resolveService.resolve(matchedEvent, intent, ws, playerStats, rng);

    // 전투 트리거?
    if (resolveResult.triggerCombat && resolveResult.combatEncounterId) {
      // LOCATION 노드 유지, COMBAT 서브노드 삽입
      ws = this.heatService.applyHeatDelta(ws, resolveResult.heatDelta);
      ws = this.worldStateService.advanceTime(ws);
      ws = this.worldStateService.updateHubSafety(ws);
      ws = { ...ws, combatWindowCount: ws.combatWindowCount + 1 };
      updatedRunState.worldState = ws;

      const preResult = this.buildLocationResult(
        turnNo, currentNode,
        `${matchedEvent.payload.sceneFrame} — 전투가 시작된다!`,
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
      ws, locationId, intent.actionType, incidentDefs,
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

    // === Narrative Engine v1: postStepTick (impact patches, safety, signal expire) ===
    ws = this.worldTick.postStepTick(ws, resolvedPatches);

    // === Narrative Engine v1: NPC Emotional 업데이트 ===
    const npcStates = { ...(runState.npcStates ?? {}) } as Record<string, NPCState>;
    // 현재 location의 관련 NPC에게 감정 영향 적용
    if (matchedEvent.payload.primaryNpcId) {
      const npcId = matchedEvent.payload.primaryNpcId;
      if (!npcStates[npcId]) {
        const npcDef = this.content.getNpc(npcId);
        npcStates[npcId] = initNPCState({
          npcId,
          basePosture: npcDef?.basePosture,
          initialTrust: npcDef?.initialTrust ?? relations[npcId] ?? 0,
          agenda: npcDef?.agenda,
        });
      }
      const npc = npcStates[npcId];
      npc.emotional = this.npcEmotional.applyActionImpact(
        npc.emotional, intent.actionType, resolveResult.outcome, true,
      );
      npcStates[npcId] = this.npcEmotional.syncLegacyFields(npc);
    }

    // === Narrative Engine v1: Narrative Marks 체크 ===
    const markConditions = this.content.getNarrativeMarkConditions();
    const npcEmotionals: Record<string, NpcEmotionalState> = {};
    for (const [npcId, npc] of Object.entries(npcStates)) {
      npcEmotionals[npcId] = npc.emotional;
    }
    const npcNames: Record<string, string> = {};
    for (const [npcId] of Object.entries(npcStates)) {
      const npcDef = this.content.getNpc(npcId);
      npcNames[npcId] = npcDef?.name ?? npcId;
    }
    // resolve outcome 횟수 집계
    const resolveOutcomeCounts: Record<string, number> = {};
    for (const h of [...actionHistory, { actionType: intent.actionType }]) {
      // 간단히 현재 결과만 카운트
    }
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
    const newHistory = [...actionHistory, {
      turnNo,
      actionType: intent.actionType,
      suppressedActionType: intent.suppressedActionType,
      inputText: rawInput,
      eventId: matchedEvent.eventId,
      choiceId: body.input.type === 'CHOICE' ? body.input.choiceId : undefined,
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

    // 비도전 행위 여부 (MOVE_LOCATION, REST, SHOP, TALK → 주사위 UI 숨김)
    const isNonChallenge = ['MOVE_LOCATION', 'REST', 'SHOP', 'TALK'].includes(intent.actionType);

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
      choices = this.sceneShellService.buildFollowUpChoices(locationId, resolveResult.outcome, selectedChoiceIds, matchedEvent.eventId, matchedEvent.eventType, turnNo, matchedEvent.payload.choices);
    } else {
      // 첫 만남 이벤트 → 이벤트 고유 선택지
      choices = this.sceneShellService.buildLocationChoices(locationId, matchedEvent.eventType, matchedEvent.payload.choices, selectedChoiceIds, matchedEvent.eventId);
    }
    // summary.short: "이번 턴의 핵심 한 문장" — 행동 + 판정결과 + 배경 포함 (LLM 맥락 유지용)
    const outcomeLabel = resolveResult.outcome === 'SUCCESS' ? '성공' : resolveResult.outcome === 'PARTIAL' ? '부분 성공' : '실패';
    const actionLabel = this.actionTypeToKorean(intent.actionType);
    const summaryText = isNonChallenge
      ? `[상황] ${matchedEvent.payload.sceneFrame} [행동] 플레이어가 ${actionLabel}${korParticle(actionLabel, '을', '를')} 했다.`
      : `[상황] ${matchedEvent.payload.sceneFrame} [행동] 플레이어가 "${rawInput}"${korParticle(rawInput, '을', '를')} 시도하여 ${outcomeLabel}했다.`;
    const result = this.buildLocationResult(turnNo, currentNode, summaryText, resolveResult.outcome, choices, ws, {
      parsedType: intent.actionType,
      originalInput: rawInput,
      tone: intent.tone,
      escalated: intent.escalated,
      insistenceCount: insistenceCount > 0 ? insistenceCount : undefined,
      eventSceneFrame: matchedEvent.payload.sceneFrame,
      eventMatchPolicy: matchedEvent.matchPolicy,
    }, isNonChallenge, totalGoldDelta, locationReward.items);

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

    // 이벤트 추가
    result.events.push({
      id: `event_${matchedEvent.eventId}`,
      kind: 'NPC',
      text: matchedEvent.payload.sceneFrame,
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
    );

    // === Structured Memory v2: 실시간 수집 ===
    try {
      // NPC 감정 변화 delta 계산 (이번 턴에서 변경된 축만)
      let npcEmoDelta: { npcId: string; delta: Record<string, number> } | undefined;
      if (matchedEvent.payload.primaryNpcId) {
        const npcId = matchedEvent.payload.primaryNpcId;
        const npc = npcStates[npcId];
        if (npc?.emotional) {
          // 대략적인 delta — applyActionImpact에서 변경된 값 (정확한 before 없으므로 간략화)
          npcEmoDelta = { npcId, delta: {} };
        }
      }
      await this.memoryCollector.collectFromTurn(
        run.id,
        currentNode.id,
        locationId,
        turnNo,
        {
          actionType: intent.actionType,
          rawInput: rawInput.slice(0, 30),
          outcome: resolveResult.outcome,
          eventId: matchedEvent.eventId,
          sceneFrame: matchedEvent.payload.sceneFrame,
          primaryNpcId: matchedEvent.payload.primaryNpcId,
          eventTags: matchedEvent.payload.tags ?? [],
          reputationChanges: resolveResult.reputationChanges,
          goldDelta: totalGoldDelta,
          incidentImpact: relevantIncident
            ? {
                incidentId: relevantIncident.incident.incidentId,
                controlDelta: relevantIncident.incident.control - (ws.activeIncidents?.find((i) => i.incidentId === relevantIncident.incident.incidentId)?.control ?? 0),
                pressureDelta: relevantIncident.incident.pressure - (ws.activeIncidents?.find((i) => i.incidentId === relevantIncident.incident.incidentId)?.pressure ?? 0),
              }
            : undefined,
          npcEmotionalDelta: npcEmoDelta as any,
          newMarks: newMarks.map((m) => m.type),
        },
      );
    } catch (err) {
      // 수집 실패는 게임 진행에 영향 없음
    }

    await this.commitTurnRecord(run, currentNode, turnNo, body, rawInput, result, postTickRunState, body.options?.skipLlm);

    if (shouldEnd && endReason) {
      // 엔딩 생성
      const endingInput = this.endingGenerator.gatherEndingInputs(
        endWs.activeIncidents ?? [],
        (postTickRunState.npcStates ?? {}) as Record<string, NPCState>,
        endWs.narrativeMarks ?? [],
        endWs as unknown as Record<string, unknown>,
        postTickRunState.arcState ?? null,
      );
      const endingResult = this.endingGenerator.generateEnding(endingInput, endReason, turnNo);

      // RUN_ENDED로 상태 변경
      await this.db.update(runSessions).set({
        status: 'RUN_ENDED',
        updatedAt: new Date(),
      }).where(eq(runSessions.id, run.id));

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
        enemyStats[e.id] = {
          maxHP: def.hp, maxStamina: 5, atk: def.stats.ATK, def: def.stats.DEF,
          acc: def.stats.ACC, eva: def.stats.EVA, crit: def.stats.CRIT,
          critDmg: Math.round(def.stats.CRIT_DMG * 100), resist: def.stats.RESIST, speed: def.stats.SPEED,
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

      // 패배 시 RUN_ENDED
      if (resolveResult.combatOutcome === 'DEFEAT') {
        await this.db.update(runSessions).set({ status: 'RUN_ENDED', updatedAt: new Date() }).where(eq(runSessions.id, run.id));
        (response as any).meta.nodeOutcome = 'RUN_ENDED';
        return response;
      }

      // 승리/도주 → 부모 LOCATION 복귀
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
        worldState: { hubHeat: ws.hubHeat, hubSafety: ws.hubSafety, timePhase: ws.timePhase, currentLocationId: null },
      },
      choices,
    };
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
    await this.memoryIntegration.finalizeVisit(run.id, currentNode.id, runState, turnNo);

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

  /** 자유 텍스트에서 목표 위치 추출 */
  private extractTargetLocation(input: string, currentLocationId: string): string | null {
    const normalized = input.toLowerCase();
    const locationKeywords: Array<{ keywords: string[]; locationId: string }> = [
      { keywords: ['시장', '상점가', '장터'], locationId: 'LOC_MARKET' },
      { keywords: ['경비대', '경비', '초소', '병영'], locationId: 'LOC_GUARD' },
      { keywords: ['항만', '부두', '항구', '선착장'], locationId: 'LOC_HARBOR' },
      { keywords: ['빈민가', '빈민', '슬럼', '뒷골목'], locationId: 'LOC_SLUMS' },
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
    actionContext?: { parsedType: string; originalInput: string; tone: string; escalated?: boolean; insistenceCount?: number; eventSceneFrame?: string; eventMatchPolicy?: string },
    hideResolve?: boolean,
    goldDelta?: number,
    itemsAdded?: import('../db/types/index.js').ItemStack[],
  ): ServerResultV1 {
    const base = this.buildSystemResult(turnNo, node, text);
    if (goldDelta && goldDelta !== 0) {
      base.diff.inventory.goldDelta = goldDelta;
    }
    if (itemsAdded && itemsAdded.length > 0) {
      base.diff.inventory.itemsAdded = itemsAdded;
    }
    return {
      ...base,
      // 내러티브 텍스트는 summary(NARRATOR)에만 — SYSTEM 이벤트로 표시하지 않음
      events: [],
      ui: {
        availableActions: ['ACTION', 'CHOICE'], targetLabels: [],
        actionSlots: { base: 2, bonusAvailable: false, max: 3 },
        toneHint: outcome === 'FAIL' ? 'danger' : outcome === 'SUCCESS' ? 'triumph' : 'neutral',
        worldState: { hubHeat: ws.hubHeat, hubSafety: ws.hubSafety, timePhase: ws.timePhase, currentLocationId: ws.currentLocationId },
        // 비도전 행위는 주사위 UI를 표시하지 않음
        ...(hideResolve ? {} : { resolveOutcome: outcome as any }),
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
      llm: { status: turn.llmStatus, output: turn.llmOutput, modelUsed: turn.llmModelUsed, completedAt: turn.llmCompletedAt, error: turn.llmError, tokenStats: turn.llmTokenStats ?? null },
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
}
