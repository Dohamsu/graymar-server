/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument */
// [arch/77 §5 후속 — turns.service 파일 분할 4단계, 2026-08-07]
//   HUB 턴(거점 순환·아크 커밋·장소 이동 선택). buildHubActionResult 를 함께
//   가져와 그룹 전용 헬퍼를 이 파일에 가둔다.
import { korParticleRo } from '../common/korean.js';
import { TRAVEL_LEG_TIME_COST } from './time-cost.js';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { DB, type DrizzleDB } from '../db/drizzle.module.js';
import { runSessions, nodeInstances, turns } from '../db/schema/index.js';
import type {
  ServerResultV1,
  PermanentStats,
  RunState,
  WorldState,
} from '../db/types/index.js';
import type { LlmStatus } from '../db/types/index.js';
import { InvalidInputError } from '../common/errors/game-errors.js';
import { NodeTransitionService } from '../engine/nodes/node-transition.service.js';
import { ContentLoaderService } from '../content/content-loader.service.js';
import { QUEST_BALANCE } from '../engine/hub/quest-balance.config.js';
import { WorldStateService } from '../engine/hub/world-state.service.js';
import { HeatService } from '../engine/hub/heat.service.js';
import { AgendaService } from '../engine/hub/agenda.service.js';
import { ArcService } from '../engine/hub/arc.service.js';
import { SceneShellService } from '../engine/hub/scene-shell.service.js';
import { WorldTickService } from '../engine/hub/world-tick.service.js';
import { buildPackMetersUI } from '../engine/hub/pack-meter.js';
import type { SubmitTurnBody } from './dto/submit-turn.dto.js';
import { TurnSharedService } from './turn-shared.service.js';

@Injectable()
export class HubTurnService {
  private readonly logger = new Logger(HubTurnService.name);

  constructor(
    @Inject(DB) private readonly db: DrizzleDB,
    private readonly content: ContentLoaderService,
    private readonly nodeTransition: NodeTransitionService,
    private readonly worldStateService: WorldStateService,
    private readonly heatService: HeatService,
    private readonly agendaService: AgendaService,
    private readonly arcService: ArcService,
    private readonly sceneShellService: SceneShellService,
    private readonly worldTick: WorldTickService,
    private readonly turnShared: TurnSharedService,
  ) {}

  // --- HUB 턴 ---
  async handleHubTurn(
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

    // pendingQuestHint 만료 정리 (HUB 턴): 이월 창(arch/60 P2)을 존중해
    // 창 초과분만 정리. HUB 방문이 발견↔다음 LOCATION 턴 사이에 끼어도
    // [단서 방향] 힌트가 살아남아 복귀 턴에 발화된다 (리뷰 발견 반영).
    if (
      updatedRunState.pendingQuestHint &&
      updatedRunState.pendingQuestHint.setAtTurn <
        turnNo - QUEST_BALANCE.DIRECTION_HINT_CARRY_MAX_TURNS
    ) {
      updatedRunState.pendingQuestHint = null;
    }

    const choiceId = body.input.choiceId;

    // 아크 루트 커밋 (1-A, arch/68 부록 F) — HUB 노출 arc_commit_* 선택.
    // 정적 이벤트(arcRouteTag) 운에 의존하던 route 진입을 명시 분기로 보강.
    if (choiceId.startsWith('arc_commit_')) {
      const commit = this.content
        .getArcRouteCommitChoices()
        .find((rc) => `arc_commit_${rc.route.toLowerCase()}` === choiceId);
      if (!commit) {
        throw new InvalidInputError(`Unknown arc commit choice: ${choiceId}`);
      }
      let newArc = this.arcService.switchRoute(
        arcState,
        commit.route as import('../db/types/index.js').ArcRoute,
      );
      // 명시 선택은 강한 의지 — 초기 결의 +2 (잠금 3 직전, 배신 여지는 유지)
      newArc = this.arcService.progressCommitment(newArc, 2);
      updatedRunState.arcState = newArc;

      const hubChoices = this.sceneShellService.buildHubChoices(
        ws,
        newArc,
        updatedRunState.questState,
      );
      const result = this.buildHubActionResult(
        turnNo,
        currentNode,
        `마음을 정했다 — ${commit.label}`,
        hubChoices,
        ws,
        updatedRunState,
      );
      result.events.push({
        id: `arc_commit_${turnNo}`,
        kind: 'SYSTEM',
        text: `[노선] ${commit.label}`,
        tags: ['ARC_COMMIT', commit.route],
      });

      await this.turnShared.commitTurnRecord(
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

    // LOCATION 이동 — architecture/63: locations.json hubAccessible 파생
    // (go_ choiceId 규약, HUB 노출 장소만 — 구 locationMap 4곳과 동일 범위)
    const hubChoiceLoc = this.content.getHubChoiceLocation(choiceId);

    if (hubChoiceLoc) {
      const locationId = hubChoiceLoc.locationId;
      const locName = hubChoiceLoc.name;
      // 이동 = 시간 소요 (arch/81 2차) — HUB 경유 편도 1tick (왕복 합 = 직행 2)
      const newWs = this.worldTick.advanceClockForTravel(
        this.worldStateService.moveToLocation(ws, locationId),
        TRAVEL_LEG_TIME_COST,
      );
      updatedRunState.worldState = newWs;
      updatedRunState.actionHistory = []; // LOCATION 이동 시 고집 이력 초기화

      // Arc unlock 체크 — [73 §11 B2] 팩 선언 언락 조건(scenario.json arcRoutes)
      const newUnlocks = this.arcService.checkUnlockConditions(
        newWs,
        this.content.getScenarioMeta()?.arcRoutes ?? [],
      );
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
      const hubResult = this.turnShared.buildSystemResult(
        turnNo,
        currentNode,
        `${locName}${korParticleRo(locName)} 향한다.`,
      );
      // [arch/99] 이동 턴에도 퀘스트탭 번들 부착 — 이동 시간 소요(day 변동)의
      // 시한 표시 지연 방지 (newWs = 이동 tick 반영분)
      this.turnShared.attachQuestUiBundle(
        hubResult,
        updatedRunState,
        updatedRunState.worldState,
      );
      await this.turnShared.commitTurnRecord(
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
        updatedRunState.questState,
      );
      const result = this.buildHubActionResult(
        turnNo,
        currentNode,
        '협력자에게 연락하여 열기를 식혔다.',
        hubChoices,
        updatedRunState.worldState!,
        updatedRunState,
      );

      await this.turnShared.commitTurnRecord(
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
        updatedRunState.questState,
      );
      const result = this.buildHubActionResult(
        turnNo,
        currentNode,
        `금화 ${cost}으로 열기를 해소했다.`,
        hubChoices,
        updatedRunState.worldState!,
        updatedRunState,
      );

      await this.turnShared.commitTurnRecord(
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
      const hubChoices = this.sceneShellService.buildHubChoices(
        ws,
        arcState,
        updatedRunState.questState,
      );
      const result: ServerResultV1 = {
        ...this.turnShared.buildSystemResult(
          turnNo,
          currentNode,
          '의뢰를 수락했다.',
        ),
        // architecture/63: scenario.json prologue.accept 스크립트
        summary: (() => {
          const accept = this.content.getPrologueMeta().accept;
          return {
            short: (accept?.instructionLines ?? ['의뢰를 수락했다.']).join(
              '\n',
            ),
            display: accept?.display ?? '당신은 의뢰를 수락했다.',
          };
        })(),
        ui: {
          availableActions: ['CHOICE'],
          targetLabels: [],
          actionSlots: { base: 2, bonusAvailable: false, max: 3 },
          toneHint: 'calm',
          worldState: {
            hubHeat: ws.hubHeat,
            hubSafety: ws.hubSafety,
            timePhase: ws.timePhase,
            phaseV2: ws.phaseV2,
            day: ws.day,
            currentLocationId: null,
            locationDynamicStates: ws.locationDynamicStates ?? {},
            playerGoals: (ws.playerGoals ?? []).filter((g) => !g.completed),
            reputation: ws.reputation ?? {},
            packMeters: buildPackMetersUI(
              ws.packMeters,
              this.content.getScenarioMeta()?.meters,
            ),
          },
        },
        choices: hubChoices,
      };

      // HUB accept_quest: speakingNpc를 프롤로그 화자로 고정 (LLM이 다른 NPC로 마킹 방지)
      // architecture/63: scenario.json prologue 필드
      // arch/80: 이미지는 에셋 풀 리졸버 우선 — 콘텐츠 하드코딩(실루엣)은 풀 미배정 시 fallback
      const prologueMeta = this.content.getPrologueMeta();
      (result.ui as any).speakingNpc = {
        npcId: prologueMeta.npcId,
        displayName: prologueMeta.displayName,
        imageUrl:
          this.content.getNpcPortraitUrl(prologueMeta.npcId) ||
          prologueMeta.imageUrl,
      };

      // [arch/99] 의뢰 수락 턴부터 퀘스트탭 현황판 노출
      this.turnShared.attachQuestUiBundle(result, updatedRunState, ws);

      await this.turnShared.commitTurnRecord(
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

  buildHubActionResult(
    turnNo: number,
    node: any,
    text: string,
    choices: ServerResultV1['choices'],
    ws: WorldState,
    runState?: RunState,
  ): ServerResultV1 {
    const result: ServerResultV1 = {
      ...this.turnShared.buildSystemResult(turnNo, node, text),
      ui: {
        availableActions: ['CHOICE'],
        targetLabels: [],
        actionSlots: { base: 2, bonusAvailable: false, max: 3 },
        toneHint: 'neutral',
        worldState: {
          hubHeat: ws.hubHeat,
          hubSafety: ws.hubSafety,
          timePhase: ws.timePhase,
          phaseV2: ws.phaseV2,
          day: ws.day,
          currentLocationId: null,
          locationDynamicStates: ws.locationDynamicStates ?? {},
          playerGoals: (ws.playerGoals ?? []).filter((g) => !g.completed),
          reputation: ws.reputation ?? {},
          packMeters: buildPackMetersUI(
            ws.packMeters,
            this.content.getScenarioMeta()?.meters,
          ),
        },
      },
      choices,
    };
    // [arch/99] HUB 턴에도 퀘스트탭 번들 부착 — arc_commit 직후 노선 스테일 방지
    if (runState) {
      this.turnShared.attachQuestUiBundle(result, runState, ws);
    }
    return result;
  }
}
