// 정본: design/server_api_system.md §5 — GET /v1/runs/:runId

import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, lt } from 'drizzle-orm';
import { randomUUID } from 'crypto';
import { DB, type DrizzleDB } from '../db/drizzle.module.js';
import {
  runSessions,
  nodeInstances,
  battleStates,
  turns,
  runMemories,
} from '../db/schema/index.js';
import { users } from '../db/schema/users.js';
import { playerProfiles } from '../db/schema/player-profiles.js';
import {
  BadRequestError,
  ForbiddenError,
  NotFoundError,
} from '../common/errors/game-errors.js';
import type { GetRunQuery } from './dto/get-run.dto.js';
import { RunPlannerService } from '../engine/planner/run-planner.service.js';
import { ContentLoaderService } from '../content/content-loader.service.js';
import type { ServerResultV1, RunState } from '../db/types/index.js';

@Injectable()
export class RunsService {
  constructor(
    @Inject(DB) private readonly db: DrizzleDB,
    private readonly planner: RunPlannerService,
    private readonly content: ContentLoaderService,
  ) {}

  async createRun(userId: string, presetId: string) {
    // 0. 프리셋 검증
    const preset = this.content.getPreset(presetId);
    if (!preset) {
      throw new BadRequestError(`Unknown presetId: ${presetId}`);
    }

    // 1. User upsert
    const existingUser = await this.db.query.users.findFirst({
      where: eq(users.id, userId),
    });
    if (!existingUser) {
      await this.db.insert(users).values({
        id: userId,
        email: `${userId}@placeholder.local`,
      });
    }

    // 2. PlayerProfile upsert — 매 런마다 프리셋 스탯으로 갱신
    const presetStats = {
      maxHP: preset.stats.MaxHP,
      maxStamina: preset.stats.MaxStamina,
      atk: preset.stats.ATK,
      def: preset.stats.DEF,
      acc: preset.stats.ACC,
      eva: preset.stats.EVA,
      crit: preset.stats.CRIT,
      critDmg: Math.round(preset.stats.CRIT_DMG * 100),
      resist: preset.stats.RESIST,
      speed: preset.stats.SPEED,
    };

    let profile = await this.db.query.playerProfiles.findFirst({
      where: eq(playerProfiles.userId, userId),
    });
    if (!profile) {
      const [created] = await this.db
        .insert(playerProfiles)
        .values({
          userId,
          permanentStats: presetStats,
          storyProgress: { actLevel: 1, cluePoints: 0, revealedTruths: [] },
        })
        .returning();
      profile = created;
    } else {
      await this.db
        .update(playerProfiles)
        .set({ permanentStats: presetStats })
        .where(eq(playerProfiles.userId, userId));
    }

    const seed = randomUUID();

    // DAG 그래프에서 시작 노드 조회
    const startNodeId = this.planner.getStartNodeId();
    const startNodeDef = this.planner.findNode(startNodeId);
    if (!startNodeDef) {
      throw new Error(`Start node not found: ${startNodeId}`);
    }

    // 초기 RunState — 프리셋 기반
    const initialRunState: RunState = {
      gold: preset.startingGold,
      hp: preset.stats.MaxHP,
      maxHp: preset.stats.MaxHP,
      stamina: preset.stats.MaxStamina,
      maxStamina: preset.stats.MaxStamina,
      inventory: preset.startingItems.map((si) => ({
        itemId: si.itemId,
        qty: si.qty,
      })),
    };

    // 3~6. 트랜잭션: run + nodes + memory + 첫 턴
    const result = await this.db.transaction(async (tx) => {
      // 3. run_sessions INSERT (runState + graphNodeId 포함)
      const [run] = await tx
        .insert(runSessions)
        .values({
          userId,
          status: 'RUN_ACTIVE',
          runType: 'CAPITAL',
          actLevel: 1,
          chapterIndex: 0,
          currentNodeIndex: 0,
          currentTurnNo: 0,
          seed,
          runState: initialRunState,
          currentGraphNodeId: startNodeId,
          presetId,
          routeTag: null,
        })
        .returning();

      // 4. 첫 노드만 INSERT (이후 노드는 lazy 생성)
      const startEventId =
        (startNodeDef.nodeMeta.eventId as string) ?? 'default';
      await tx.insert(nodeInstances).values({
        runId: run.id,
        nodeIndex: 0,
        graphNodeId: startNodeId,
        nodeType: startNodeDef.nodeType,
        nodeMeta: startNodeDef.nodeMeta,
        environmentTags: startNodeDef.environmentTags,
        edges: startNodeDef.edges,
        status: 'NODE_ACTIVE',
        nodeState: {
          eventId: startEventId,
          stage: 0,
          maxStage: 2,
          choicesMade: [],
        },
      });

      // 5. run_memories INSERT
      await tx.insert(runMemories).values({
        runId: run.id,
        theme: [
          {
            key: 'location',
            value:
              '그레이마르 항만 — 왕국 남서부 최대 무역항. 세 세력(항만 노동 길드, 해관청, 밀수 조직)이 이권을 다툰다.',
            importance: 1.0,
            tags: ['LOCATION', 'THEME'],
          },
          {
            key: 'quest',
            value:
              '사라진 공물 장부 — 길드가 해관청에 바친 공물 내역이 담긴 장부가 도난당했다. 장부에는 뒷거래 기록도 포함되어 있어, 공개되면 길드 간부 다수가 처형당할 수 있다.',
            importance: 1.0,
            tags: ['QUEST', 'THEME'],
          },
          {
            key: 'npc_client',
            value:
              '의뢰인 로넨 — 항만 노동 길드의 말단 서기관. 장부 관리 책임자였으나 도난 사실을 상부에 보고하지 못해 쫓기는 처지. 용병에게 의뢰하는 이유: 길드 내부에 배신자가 있어 동료를 믿을 수 없다.',
            importance: 0.9,
            tags: ['NPC', 'THEME'],
          },
          {
            key: 'time',
            value: '한밤중 — 항만 순찰이 교대하는 시각',
            importance: 0.5,
            tags: ['TIME', 'THEME'],
          },
          {
            key: 'protagonist',
            value: `이름 없는 용병 — ${preset.protagonistTheme} 그레이마르에는 일거리를 찾아 며칠 전 도착했다.`,
            importance: 0.8,
            tags: ['PROTAGONIST', 'THEME'],
          },
        ],
        storySummary: null,
      });

      // 6. 첫 EVENT 노드 진입 — turnNo=0 SYSTEM 턴
      const firstNode = await tx.query.nodeInstances.findFirst({
        where: and(
          eq(nodeInstances.runId, run.id),
          eq(nodeInstances.nodeIndex, 0),
        ),
      });

      const enterResult: ServerResultV1 = {
        version: 'server_result_v1',
        turnNo: 0,
        node: {
          id: firstNode!.id,
          type: 'EVENT',
          index: 0,
          state: 'NODE_ACTIVE',
        },
        summary: {
          short: [
            '[배경] 그레이마르 항만 — 왕국 남서부 최대 무역항. 밤안개가 부두를 뒤덮고, 정박한 화물선들의 삭구가 바람에 삐걱댄다. 부두 끝 등대만이 희미한 불빛을 던지고, 순찰 교대 시각이라 인적이 드물다. 소금과 생선 냄새, 축축한 밧줄 냄새가 뒤섞인 공기.',
            `[주인공] ${preset.protagonistTheme} 일거리를 찾아 며칠 전 그레이마르에 도착했으나 아직 마땅한 의뢰를 잡지 못했다. 허름한 선술집에서 나와 부두를 걷고 있다.`,
            '[사건] 어둠 속에서 한 남자가 주인공에게 다가온다. 낡은 외투에 잉크 얼룩이 묻은 서기관 로넨 — 항만 노동 길드의 장부 관리 책임자. 초조한 눈빛으로 주변을 살피며, 낮고 급한 목소리로 말한다:',
            '"용병을 찾고 있었소. 당신이 변경에서 싸운 자라는 소문을 들었소."',
            '"길드의 공물 장부가 사라졌소. 해관청에 바친 상납금 내역이 전부 적힌 장부요. 그런데 그 안에는… 공식 기록에 없는 뒷거래 내역도 있소. 밀수 조직과의 거래, 간부들의 횡령. 이게 해관청 손에 들어가면 길드 간부 절반이 교수대에 서게 되오."',
            '"길드 안에 배신자가 있소. 내부 사람은 믿을 수 없소. 그래서 외부 사람이 필요한 거요." 로넨이 금화가 든 주머니를 내밀며 말했다. "이건 선불이오. 장부를 되찾아주면 나머지를 치르겠소. 하지만 서두르시오 — 이 도시엔 그 장부를 원하는 자들이 너무 많소."',
          ].join('\n'),
          display:
            '밤의 그레이마르 항만. 서기관 로넨이 사라진 공물 장부의 추적을 의뢰한다.',
        },
        events: [
          {
            id: 'enter_0',
            kind: 'SYSTEM',
            text: '그레이마르 항만 — 밤안개가 부두를 감싸고 있다.',
            tags: ['RUN_START', 'NODE_ENTER'],
          },
          {
            id: 'enter_npc_0',
            kind: 'NPC',
            text: '서기관 로넨이 주인공에게 접근하여 공물 장부 추적을 의뢰한다. 길드 내부에 배신자가 있어 외부 용병이 필요하다고 설명한다.',
            tags: ['NPC', 'QUEST_OFFER'],
          },
          {
            id: 'enter_quest_0',
            kind: 'QUEST',
            text: '[의뢰] 사라진 공물 장부 — 해관청 상납 기록과 뒷거래 내역이 담긴 장부를 되찾아라. 장부가 유출되면 길드 간부 다수가 처형된다.',
            tags: ['QUEST', 'QUEST_START'],
          },
          {
            id: 'enter_ctx_0',
            kind: 'NPC',
            text: '로넨의 동기: 장부 관리 책임자로서 도난을 상부에 보고하지 못한 상태. 장부가 돌아오지 않으면 본인도 처벌을 면할 수 없다.',
            tags: ['NPC', 'CONTEXT'],
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
          meta: {
            battle: { phase: 'NONE' },
            position: { env: ['HARBOR', 'NIGHT', 'FOG'] },
          },
        },
        ui: {
          availableActions: ['CHOICE'],
          targetLabels: [],
          actionSlots: { base: 2, bonusAvailable: false, max: 3 },
          toneHint: 'mysterious',
        },
        choices: [
          {
            id: 'choice_0_a',
            label: '선불금을 받고 의뢰를 수락한다',
            action: { type: 'CHOICE', payload: { choiceId: 'choice_0_a' } },
          },
          {
            id: 'choice_0_b',
            label: '장부에 정확히 무엇이 적혀 있는지 묻는다',
            action: { type: 'CHOICE', payload: { choiceId: 'choice_0_b' } },
          },
          {
            id: 'choice_0_c',
            label: '의뢰를 보류하고 부두 주변을 먼저 살핀다',
            action: { type: 'CHOICE', payload: { choiceId: 'choice_0_c' } },
          },
        ],
        flags: { bonusSlot: false, downed: false, battleEnded: false },
      };

      await tx.insert(turns).values({
        runId: run.id,
        turnNo: 0,
        nodeInstanceId: firstNode!.id,
        nodeType: 'EVENT',
        inputType: 'SYSTEM',
        rawInput: '',
        idempotencyKey: `${run.id}_init`,
        parsedBy: null,
        confidence: null,
        parsedIntent: null,
        policyResult: 'ALLOW',
        transformedIntent: null,
        actionPlan: null,
        serverResult: enterResult,
        llmStatus: 'PENDING',
      });

      return { run, enterResult, firstNode: firstNode! };
    });

    return {
      run: {
        id: result.run.id,
        status: result.run.status,
        runType: result.run.runType,
        actLevel: result.run.actLevel,
        chapterIndex: result.run.chapterIndex,
        currentNodeIndex: result.run.currentNodeIndex,
        currentTurnNo: result.run.currentTurnNo,
        seed: result.run.seed,
        startedAt: result.run.startedAt,
      },
      currentNode: {
        id: result.firstNode.id,
        nodeType: result.firstNode.nodeType,
        nodeIndex: result.firstNode.nodeIndex,
        status: result.firstNode.status,
        nodeMeta: result.firstNode.nodeMeta,
        environmentTags: result.firstNode.environmentTags,
      },
      lastResult: result.enterResult,
      battleState: null,
      runState: result.run.runState ?? initialRunState,
      memory: {
        theme: [
          {
            key: 'location',
            value: '그레이마르 항만 도시',
            importance: 1.0,
            tags: ['LOCATION', 'THEME'],
          },
        ],
        storySummary: null,
      },
      turns: [],
      page: { hasMore: false, nextCursor: undefined },
    };
  }

  async getRun(runId: string, userId: string, query: GetRunQuery) {
    // run 조회
    const run = await this.db.query.runSessions.findFirst({
      where: eq(runSessions.id, runId),
    });
    if (!run) throw new NotFoundError('Run not found');
    if (run.userId !== userId) throw new ForbiddenError('Not your run');

    // 현재 노드 조회
    const currentNode = await this.db.query.nodeInstances.findFirst({
      where: and(
        eq(nodeInstances.runId, runId),
        eq(nodeInstances.nodeIndex, run.currentNodeIndex),
      ),
    });

    // battleState (전투 중인 경우)
    let battleState: unknown = null;
    if (currentNode && currentNode.nodeType === 'COMBAT') {
      const bs = await this.db.query.battleStates.findFirst({
        where: and(
          eq(battleStates.runId, runId),
          eq(battleStates.nodeInstanceId, currentNode.id),
        ),
      });
      battleState = bs?.state ?? null;
    }

    // 최근 턴 조회 (커서 페이징)
    const turnsQuery = this.db
      .select()
      .from(turns)
      .where(
        query.turnsBefore
          ? and(eq(turns.runId, runId), lt(turns.turnNo, query.turnsBefore))
          : eq(turns.runId, runId),
      )
      .orderBy(desc(turns.turnNo))
      .limit(query.turnsLimit);

    const recentTurns = await turnsQuery;

    // 마지막 결과
    const lastTurn = recentTurns[0] ?? null;
    const lastResult = lastTurn?.serverResult ?? null;

    // 메모리
    const memory = await this.db.query.runMemories.findFirst({
      where: eq(runMemories.runId, runId),
    });

    // 페이지 정보
    const hasMore = recentTurns.length === query.turnsLimit;
    const nextCursor = hasMore
      ? recentTurns[recentTurns.length - 1]?.turnNo
      : undefined;

    return {
      run: {
        id: run.id,
        status: run.status,
        runType: run.runType,
        actLevel: run.actLevel,
        chapterIndex: run.chapterIndex,
        currentNodeIndex: run.currentNodeIndex,
        currentTurnNo: run.currentTurnNo,
        seed: run.seed,
        startedAt: run.startedAt,
      },
      currentNode: currentNode
        ? {
            id: currentNode.id,
            nodeType: currentNode.nodeType,
            nodeIndex: currentNode.nodeIndex,
            status: currentNode.status,
            nodeMeta: currentNode.nodeMeta,
            environmentTags: currentNode.environmentTags,
          }
        : null,
      lastResult,
      battleState,
      runState: run.runState ?? null,
      memory: memory
        ? {
            theme: memory.theme,
            storySummary: memory.storySummary,
          }
        : null,
      turns: recentTurns.map((t) => ({
        turnNo: t.turnNo,
        nodeType: t.nodeType,
        inputType: t.inputType,
        rawInput: t.rawInput,
        summary: t.serverResult?.summary?.short ?? '',
        llmStatus: t.llmStatus,
        createdAt: t.createdAt,
      })),
      page: {
        hasMore,
        nextCursor,
      },
    };
  }
}
