/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument */
// [arch/77 §5 후속 — turns.service 파일 분할 1단계, 2026-08-07]
//   진입점 4종(location·hub·dag·combat)이 공통으로 쓰던 헬퍼를 모았다. 도메인
//   서브서비스를 분리하려면 이들이 먼저 공용이어야 한다 —
//   turns.service → 도메인 서브서비스 → 이 모듈의 단방향이라 순환이 없다.
//   상태 없음: 원본 TurnsService 는 가변 인스턴스 필드가 0개였고 그 성질을 유지한다.
import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { eq, sql } from 'drizzle-orm';
import { DB, type DrizzleDB } from '../db/drizzle.module.js';
import { runSessions, turns } from '../db/schema/index.js';
import type {
  ServerResultV1,
  RunState,
  WorldState,
} from '../db/types/index.js';
import type { NodeType, LlmStatus } from '../db/types/index.js';
import { ContentLoaderService } from '../content/content-loader.service.js';
import { LlmWorkerService } from '../llm/llm-worker.service.js';
import { QuestProgressionService } from '../engine/hub/quest-progression.service.js';
import { CampaignsService } from '../campaigns/campaigns.service.js';
import type { SubmitTurnBody } from './dto/submit-turn.dto.js';

@Injectable()
export class TurnSharedService {
  private readonly logger = new Logger(TurnSharedService.name);

  constructor(
    @Inject(DB) private readonly db: DrizzleDB,
    private readonly content: ContentLoaderService,
    private readonly campaignsService: CampaignsService,
    @Optional() private readonly questProgression?: QuestProgressionService,
    // 레이턴시 #3 — 커밋 직후 워커 즉시 킥 (1초 폴링 대기 제거)
    @Optional() private readonly llmWorker?: LlmWorkerService,
  ) {}

  /** RUN_ENDED 시 캠페인 시나리오 결과 저장 (캠페인 모드일 때만) */
  async saveCampaignResultIfNeeded(runId: string): Promise<void> {
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

  /**
   * [arch/99] 퀘스트탭 UI 번들 부착 — LOCATION 턴(assembleResultUi)뿐 아니라
   * HUB 턴(arc_commit·accept_quest·contact_ally·pay_cost·장소 이동)에서도 호출한다.
   * 노선 확정이 정작 HUB에서 일어나는데 번들이 LOCATION 턴 전용이라 커밋 직후
   * ~다음 LOCATION 행동까지 탭이 스테일하던 결함의 수정.
   */
  attachQuestUiBundle(
    result: ServerResultV1,
    runState: RunState,
    ws: WorldState,
  ): void {
    // PlayerThread UI 번들에 포함
    if (ws.playerThreads && ws.playerThreads.length > 0) {
      (result.ui as any).playerThreads = ws.playerThreads;
    }

    // Quest UI 번들: arcState, narrativeMarks, mainArcClock, day
    (result.ui as any).arcState = runState.arcState ?? null;
    (result.ui as any).narrativeMarks = ws.narrativeMarks ?? [];
    (result.ui as any).mainArcClock = ws.mainArcClock ?? null;
    (result.ui as any).day = ws.day ?? 1;
    // 퀘스트탭 현황판 (2026-07-23) — 의뢰 단계·발견 단서·다음 지역 이정표
    if (this.questProgression) {
      (result.ui as any).questStatus =
        this.questProgression.buildQuestStatus(runState);
    }
  }

  // --- Helper: 일반 턴 레코드 커밋 ---
  async commitTurnRecord(
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
      chargeKey: body.idempotencyKey, // arch/85 — D5 환불 키
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
    // [P8 실측 수정 — arch/75 §19.4] AUTONOMOUS 런: 전체 되쓰기가 워커 소유
    // 필드를 클로버하는 레이스 차단. 동기 커밋의 runState는 제출 시점 스냅샷이라,
    // 그 사이 워커가 쓴 nextBeatCandidates(비트 선계산)·plotSeed(비동기 동결)를
    // 낡은 값으로 되돌린다 (빠른 페이스에서 거의 매 턴 — beatAge 고착 실측).
    // DB 수준 병합: 두 필드는 DB 현재값을 보존한다. 예외 — 이번 턴에 비트를
    // 채택(소비)했으면 nextBeatCandidates는 payload(null)가 정본.
    const isAutonomousCommit = this.content.getNarrativeMode() === 'AUTONOMOUS';
    if (isAutonomousCommit) {
      const beatConsumedThisTurn =
        runStateUpdate.plotProgress?.lastAdoptedBeatTurn === turnNo;
      const payloadJson = JSON.stringify(runStateUpdate);
      const seedMerged = sql`jsonb_set(${payloadJson}::jsonb, '{plotSeed}', COALESCE(${runSessions.runState}->'plotSeed', (${payloadJson}::jsonb)->'plotSeed', 'null'::jsonb), true)`;
      const runStateExpr = beatConsumedThisTurn
        ? seedMerged
        : sql`jsonb_set(${seedMerged}, '{nextBeatCandidates}', COALESCE(${runSessions.runState}->'nextBeatCandidates', (${payloadJson}::jsonb)->'nextBeatCandidates', 'null'::jsonb), true)`;
      await this.db
        .update(runSessions)
        .set({
          currentTurnNo: turnNo,
          runState: runStateExpr as never,
          updatedAt: new Date(),
        })
        .where(eq(runSessions.id, run.id));
    } else {
      await this.db
        .update(runSessions)
        .set({
          currentTurnNo: turnNo,
          runState: runStateUpdate,
          updatedAt: new Date(),
        })
        .where(eq(runSessions.id, run.id));
    }
    // 레이턴시 #3 — PENDING 턴 커밋 직후 워커 즉시 킥 (평균 ~0.5초 폴링 대기 제거)
    if (llmStatus === 'PENDING') {
      this.llmWorker?.wake();
    }
  }

  // --- Result builders ---
  buildSystemResult(turnNo: number, node: any, text: string): ServerResultV1 {
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

  /**
   * Phase 3: ItemMemory — RARE 이상 장비 획득 시 아이템 기록 생성.
   * COMMON 아이템은 기록하지 않음.
   */
  recordItemMemory(
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
}
