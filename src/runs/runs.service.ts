// 정본: design/HUB_system.md — HUB 기반 런 생성

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
import { ContentLoaderService } from '../content/content-loader.service.js';
import { WorldStateService } from '../engine/hub/world-state.service.js';
import { AgendaService } from '../engine/hub/agenda.service.js';
import { ArcService } from '../engine/hub/arc.service.js';
import { SceneShellService } from '../engine/hub/scene-shell.service.js';
import type { ServerResultV1, RunState } from '../db/types/index.js';

@Injectable()
export class RunsService {
  constructor(
    @Inject(DB) private readonly db: DrizzleDB,
    private readonly content: ContentLoaderService,
    private readonly worldStateService: WorldStateService,
    private readonly agendaService: AgendaService,
    private readonly arcService: ArcService,
    private readonly sceneShellService: SceneShellService,
  ) {}

  async createRun(userId: string, presetId: string, gender: 'male' | 'female' = 'male') {
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

    // 3. HUB 시스템 초기화
    const worldState = this.worldStateService.initWorldState();
    const agenda = this.agendaService.initAgenda();
    const arcState = this.arcService.initArcState();

    // NPC relations 초기화
    const npcRelations: Record<string, number> = {};
    // npcs.json이 있으면 기본 관계도 설정
    const locations = this.content.getAllLocations();
    for (const loc of locations) {
      // 기본 NPC 관계 50 (중립)
    }
    npcRelations['NPC_RONEN'] = 30; // 의뢰인
    npcRelations['NPC_GUARD_CAPTAIN'] = 20;
    npcRelations['NPC_MERCHANT_ELDER'] = 25;
    npcRelations['NPC_HARBOR_BOSS'] = 15;
    npcRelations['NPC_SLUM_LEADER'] = 10;

    // 초기 RunState — 프리셋 기반 + HUB 확장
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
      worldState,
      agenda,
      arcState,
      npcRelations,
      eventCooldowns: {},
    };

    // 4. HUB 선택지 생성
    const hubChoices = this.sceneShellService.buildHubChoices(worldState, arcState);

    // 5. 트랜잭션: run + HUB 노드 + memory + 첫 턴
    const result = await this.db.transaction(async (tx) => {
      // run_sessions INSERT
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
          currentGraphNodeId: null,
          currentLocationId: null, // HUB
          presetId,
          gender,
          routeTag: null,
        })
        .returning();

      // 첫 노드: HUB 타입
      await tx.insert(nodeInstances).values({
        runId: run.id,
        nodeIndex: 0,
        graphNodeId: null,
        nodeType: 'HUB',
        nodeMeta: { hubEntry: true },
        environmentTags: ['HUB', 'GRAYMAR'],
        edges: null,
        status: 'NODE_ACTIVE',
        nodeState: { phase: 'HUB' },
      });

      // run_memories INSERT
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
              '의뢰인 로넨 — 항만 노동 길드의 말단 서기관. 장부 관리 책임자였으나 도난 사실을 상부에 보고하지 못해 쫓기는 처지.',
            importance: 0.9,
            tags: ['NPC', 'THEME'],
          },
          {
            key: 'hub_system',
            value:
              'HUB 거점 — 그레이마르 항만의 허름한 선술집. 이곳에서 시장/경비대/항만/빈민가로 이동하며 임무를 수행한다.',
            importance: 0.8,
            tags: ['HUB', 'THEME'],
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

      // 첫 HUB 노드 진입 — turnNo=0 SYSTEM 턴
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
          type: 'HUB',
          index: 0,
          state: 'NODE_ACTIVE',
        },
        summary: {
          short: [
            '[배경] 그레이마르 항만 — 왕국 남서부 최대 무역항. 안개 낀 밤, 허름한 선술집 \'잠긴 닻\'.',
            `[주인공] ${preset.protagonistTheme} 일거리를 찾아 며칠 전 그레이마르에 도착했다.`,
            '[NPC] 서기관 로넨 — 항만 노동 길드 말단 서기관. 장부 관리 책임자였으나 도난 당해 쫓기는 처지. 초조하고 겁에 질려 있다.',
            '[상황] 로넨이 당신을 찾아와 의뢰한다. 공물 장부가 사라졌다. 장부에는 뒷거래 기록이 포함되어 있어 공개되면 길드 간부들이 처형당한다.',
            '[서술 지시] 400~700자, 프롤로그.',
            '- 선술집의 퇴폐한 분위기(소리, 냄새, 빛)로 장면을 연다.',
            '- 로넨과의 대화를 3~4차례 주고받기로 구성한다. 한 번에 모든 정보를 쏟지 말고 점진적으로 사정을 밝힌다.',
            '- 대화 흐름: 로넨이 조심스럽게 말을 꺼냄 → 당신이 반응/질문 → 로넨이 핵심(뒷거래 기록)을 털어놓음 → 당신이 수락 여부를 저울질.',
            '- 당신이 의뢰를 수락하는 이유를 행동이나 반응으로 간접 암시한다.',
          ].join('\n'),
          display: [
            '짙은 안개가 항만을 감싸는 밤이었다. 선술집 \'잠긴 닻\'의 구석 자리에서 당신은 싸구려 에일을 홀짝이고 있었다. 기름때 묻은 등잔이 흔들릴 때마다 주변의 그림자가 일렁였다.',
            '',
            '"당신이… 일을 해결해준다는 분이오?" 테이블 건너편에 앉은 사내의 목소리가 떨렸다. 서기관 로넨 — 길드 서기라기엔 행색이 너무 초라했다.',
            '',
            '당신은 잔을 내려놓고 사내를 살폈다. 핏기 없는 얼굴, 끊임없이 문 쪽을 훔쳐보는 눈동자.',
            '',
            '"장부가 사라졌소." 로넨이 목소리를 한층 낮췄다. "이틀 전 밤에 사무실을 털렸는데… 공물 내역만이 아니오. 뒷거래 기록이 전부 들어 있소."',
            '',
            '"뒷거래?"',
            '',
            '"길드 간부들이 해관청에 흘린 뇌물 목록이오." 로넨의 손이 잔 위에서 미세하게 떨렸다. "공개되면 간부 다수가 목이 달아나고… 나도 무사하지 못하오."',
            '',
            '당신은 등잔 너머로 사내의 눈을 들여다보았다. 거짓은 아닌 것 같았다. 선술집 안쪽에서 취객의 웃음소리가 터져 나왔다.',
          ].join('\n'),
        },
        events: [
          {
            id: 'enter_quest_0',
            kind: 'QUEST',
            text: '[의뢰] 사라진 공물 장부 — 도시의 네 구역을 탐색하여 단서를 모으고 장부의 행방을 추적하라.',
            tags: ['QUEST', 'QUEST_START'],
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
            position: { env: ['HUB', 'GRAYMAR'] },
          },
        },
        ui: {
          availableActions: ['CHOICE'],
          targetLabels: [],
          actionSlots: { base: 2, bonusAvailable: false, max: 3 },
          toneHint: 'mysterious',
          worldState: {
            hubHeat: worldState.hubHeat,
            hubSafety: worldState.hubSafety,
            timePhase: worldState.timePhase,
            currentLocationId: null,
          },
        },
        choices: hubChoices,
        flags: { bonusSlot: false, downed: false, battleEnded: false },
      };

      await tx.insert(turns).values({
        runId: run.id,
        turnNo: 0,
        nodeInstanceId: firstNode!.id,
        nodeType: 'HUB',
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

  async getActiveRun(userId: string) {
    const run = await this.db.query.runSessions.findFirst({
      where: and(
        eq(runSessions.userId, userId),
        eq(runSessions.status, 'RUN_ACTIVE'),
      ),
      orderBy: desc(runSessions.updatedAt),
    });
    if (!run) return null;
    return {
      runId: run.id,
      presetId: run.presetId,
      gender: run.gender ?? 'male',
      currentTurnNo: run.currentTurnNo,
      currentNodeIndex: run.currentNodeIndex,
      startedAt: run.startedAt,
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
        presetId: run.presetId,
        gender: run.gender ?? 'male',
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
        llmOutput: t.llmOutput,
        createdAt: t.createdAt,
      })),
      page: {
        hasMore,
        nextCursor,
      },
    };
  }
}
