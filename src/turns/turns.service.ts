// 정본: design/HUB_system.md — Action-First 턴 파이프라인

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
} from '../db/types/index.js';
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
import type { SubmitTurnBody, GetTurnQuery } from './dto/submit-turn.dto.js';

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
      // 장기기억 저장: 현재 LOCATION 방문 대화를 요약하여 run_memories.storySummary에 추가
      await this.saveLocationVisitSummary(run.id, currentNode.id, locationId);

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

    // 고집(insistence) 카운트 계산: 이전 행동 이력에서 동일 패턴 반복 횟수
    const actionHistory = runState.actionHistory ?? [];
    const insistenceCount = this.calculateInsistenceCount(actionHistory, rawInput);
    const intent = this.intentParser.parseWithInsistence(rawInput, source, choicePayload, insistenceCount);

    // EventMatcherService로 이벤트 매칭
    const allEvents = this.content.getAllEventsV2();
    const rng = this.rngService.create(run.seed, turnNo);
    const recentEventIds = actionHistory
      .filter((h) => h.eventId)
      .map((h) => h.eventId!);
    const matchedEvent = this.eventMatcher.match(
      allEvents, locationId, intent, ws, arcState, agenda, cooldowns, turnNo, rng, recentEventIds,
    );

    if (!matchedEvent) {
      // fallback 결과
      const choices = this.sceneShellService.buildLocationChoices(locationId);
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

    // 행동 이력 업데이트 (고집 시스템 + FALLBACK 페널티)
    const newHistory = [...actionHistory, {
      turnNo,
      actionType: intent.actionType,
      suppressedActionType: intent.suppressedActionType,
      inputText: rawInput,
      eventId: matchedEvent.eventId,
    }].slice(-10); // 최대 10개 유지

    // RunState 반영
    updatedRunState.worldState = ws;
    updatedRunState.agenda = agenda;
    updatedRunState.arcState = newArcState;
    updatedRunState.npcRelations = relations;
    updatedRunState.eventCooldowns = newCooldowns;
    updatedRunState.actionHistory = newHistory;

    // 결과 조립
    const choices = this.sceneShellService.buildLocationChoices(locationId, matchedEvent.eventType, matchedEvent.payload.choices);
    const summaryText = `${matchedEvent.payload.sceneFrame}`;
    const result = this.buildLocationResult(turnNo, currentNode, summaryText, resolveResult.outcome, choices, ws, {
      parsedType: intent.actionType,
      originalInput: rawInput,
      tone: intent.tone,
      escalated: intent.escalated,
      insistenceCount: insistenceCount > 0 ? insistenceCount : undefined,
    });

    // 이벤트 추가
    result.events.push({
      id: `event_${matchedEvent.eventId}`,
      kind: 'NPC',
      text: matchedEvent.payload.sceneFrame,
      tags: matchedEvent.payload.tags,
    });

    await this.commitTurnRecord(run, currentNode, turnNo, body, rawInput, result, updatedRunState, body.options?.skipLlm);

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
      rewardSeed: run.seed,
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

        // Heat 반영
        const newWs = this.heatService.applyHeatDelta(ws, 3);
        updatedRunState.worldState = this.worldStateService.updateHubSafety({
          ...newWs, combatWindowCount: newWs.combatWindowCount + 1,
        });

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
    const summaryLines = visitTurns.map((t) => {
      const sr = t.serverResult as ServerResultV1 | null;
      const outcome = (sr?.ui as Record<string, unknown>)?.resolveOutcome as string | undefined;
      const outcomeText = outcome === 'SUCCESS' ? '성공' : outcome === 'PARTIAL' ? '부분 성공' : outcome === 'FAIL' ? '실패' : '';
      const outcomePart = outcomeText ? `(${outcomeText})` : '';
      // LLM 서술이 있으면 첫 100자를 핵심 결과로 사용
      const narrativeHint = t.llmOutput ? ` — ${t.llmOutput.slice(0, 100)}` : '';
      return `- "${t.rawInput}"${outcomePart}${narrativeHint}`;
    });

    const visitSummary = `[${locName} 방문] ${summaryLines.join('; ')}`.slice(0, 500);

    // run_memories.storySummary에 추가
    const existing = await this.db.query.runMemories.findFirst({
      where: eq(runMemories.runId, runId),
    });

    if (existing) {
      const currentSummary = existing.storySummary ?? '';
      // 기존 요약에 방문 기록 추가 (최대 2000자 유지)
      let newSummary = currentSummary
        ? `${currentSummary}\n${visitSummary}`
        : visitSummary;
      if (newSummary.length > 2000) {
        // 오래된 방문 기록부터 잘라냄 (앞부분 삭제)
        newSummary = '...' + newSummary.slice(newSummary.length - 1997);
      }
      await this.db
        .update(runMemories)
        .set({ storySummary: newSummary, updatedAt: new Date() })
        .where(eq(runMemories.runId, runId));
    }
    // run_memories가 없으면 LLM Worker가 아직 생성 전 — 스킵 (다음 방문 시 저장)
  }

  /** 고집(insistence) 카운트: suppressedActionType이 동일한 연속 행동 횟수 */
  private calculateInsistenceCount(
    history: Array<{ actionType: string; suppressedActionType?: string; inputText: string }>,
    currentInput: string,
  ): number {
    if (history.length === 0) return 0;
    // 최근 이력에서 suppressedActionType이 있는 연속 항목 카운트
    let count = 0;
    for (let i = history.length - 1; i >= 0; i--) {
      if (history[i].suppressedActionType) {
        count++;
      } else {
        break; // 연속성 끊김
      }
    }
    return count;
  }

  private buildLocationResult(
    turnNo: number, node: any, text: string, outcome: string,
    choices: ServerResultV1['choices'], ws: WorldState,
    actionContext?: { parsedType: string; originalInput: string; tone: string; escalated?: boolean; insistenceCount?: number },
  ): ServerResultV1 {
    return {
      ...this.buildSystemResult(turnNo, node, text),
      // 내러티브 텍스트는 summary(NARRATOR)에만 — SYSTEM 이벤트로 표시하지 않음
      events: [],
      ui: {
        availableActions: ['ACTION', 'CHOICE'], targetLabels: [],
        actionSlots: { base: 2, bonusAvailable: false, max: 3 },
        toneHint: outcome === 'FAIL' ? 'danger' : outcome === 'SUCCESS' ? 'triumph' : 'neutral',
        worldState: { hubHeat: ws.hubHeat, hubSafety: ws.hubSafety, timePhase: ws.timePhase, currentLocationId: ws.currentLocationId },
        resolveOutcome: outcome as any,
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
      llm: { status: turn.llmStatus, output: turn.llmOutput, modelUsed: turn.llmModelUsed, completedAt: turn.llmCompletedAt, error: turn.llmError },
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
