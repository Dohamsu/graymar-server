// 정본: specs/HUB_system.md — HUB 기반 런 생성

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
import type { ServerResultV1, RunState, IncidentDef, NPCState } from '../db/types/index.js';
import { initNPCState } from '../db/types/npc-state.js';
import { IncidentManagementService } from '../engine/hub/incident-management.service.js';
import { RngService } from '../engine/rng/rng.service.js';

@Injectable()
export class RunsService {
  constructor(
    @Inject(DB) private readonly db: DrizzleDB,
    private readonly content: ContentLoaderService,
    private readonly worldStateService: WorldStateService,
    private readonly agendaService: AgendaService,
    private readonly arcService: ArcService,
    private readonly sceneShellService: SceneShellService,
    private readonly incidentMgmt: IncidentManagementService,
    private readonly rngService: RngService,
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

    // Narrative Engine v1: 초기 Incident spawn
    const incidentDefs = this.content.getIncidentsData() as IncidentDef[];
    const initRng = this.rngService.create(seed, 0);
    const initialIncidents = this.incidentMgmt.initIncidents(incidentDefs, worldState, initRng);
    worldState.activeIncidents = initialIncidents;

    // Narrative Engine v1: NPC State 초기화
    const npcStates: Record<string, NPCState> = {};
    const allNpcs = this.content.getAllNpcs();
    for (const npcDef of allNpcs) {
      npcStates[npcDef.npcId] = initNPCState({
        npcId: npcDef.npcId,
        basePosture: npcDef.basePosture,
        initialTrust: npcDef.initialTrust ?? npcRelations[npcDef.npcId] ?? 0,
        agenda: npcDef.agenda,
      });
    }

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
      equipped: {},
      equipmentBag: [],
      npcStates,
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
            `[주인공] ${preset.protagonistTheme} 일거리를 찾아 며칠 전 그레이마르에 도착했다. 이 도시에서 아직 이름이 알려지지 않은 떠돌이 용병.`,
            '[NPC] 서기관 로넨 — 항만 노동 길드 말단 서기관. 장부 관리 책임자였으나 도난 당해 쫓기는 처지. 초조하고 겁에 질려 있다. ⚠️ 말투: 중세 하급 관리 특유의 공손하지만 딱딱한 경어체. "~하오", "~이오", "~소"체를 사용. 예: "실례하겠소", "장부가 사라졌소", "찾아주시오". 현대 존댓말("~합니다", "~입니다", "~세요")은 절대 사용하지 마세요.',
            '',
            '[대화 흐름 — 반드시 이 순서대로 전개]',
            '1단계(자기소개): 로넨이 조심스럽게 다가와 자신이 누구인지 밝힌다. "항만 노동 길드 서기관 로넨이오" 식으로 소속과 직함을 말한다.',
            `2단계(접근 이유): 왜 당신에게 왔는지 설명한다. 로넨의 대사: "${(preset as any).prologueHook ?? '부두에서 당신이 일하는 것을 봤소. 길드 안 사람은 아무도 믿을 수가 없어서… 외부 사람이 필요했소.'}" 이 대사를 자연스럽게 녹여 넣되, 길드 내부 인물은 믿을 수 없어서 외부인이 필요하다는 점을 강조한다.`,
            '3단계(문제 고백): 장부가 사라진 사실을 털어놓는다. 처음에는 "장부가 사라졌다"만 말하고, 당신의 반응 후에 뒷거래 기록이 포함되어 있다는 핵심을 밝힌다.',
            '4단계(제안): 장부를 찾아달라는 의뢰를 명확히 제안한다. 보수를 언급하거나 긴박함을 호소한다.',
            '',
            '[서술 지시] 400~700자, 프롤로그.',
            '- 1막(분위기 ~40%): 선술집의 퇴폐한 분위기(소리, 냄새, 빛)로 장면을 연다. NPC 미등장.',
            '- 2막(대화 ~40%): 위 1~3단계. NPC가 말함 → 당신의 반응(행동/시선, 대사 아님) → NPC가 더 밝힘.',
            '- 3막(제안 ~20%): 4단계. 로넨의 절박한 부탁으로 끝낸다.',
            '- 당신의 내면 심리 금지. 행동/시선/표정으로만 반응.',
          ].join('\n'),
          display: [
            '짙은 안개가 항만을 감싸는 밤이었다. 선술집 \'잠긴 닻\'의 구석 자리에서 당신은 싸구려 에일을 홀짝이고 있었다. 기름때 묻은 등잔이 흔들릴 때마다 주변의 그림자가 일렁였다.',
            '',
            '"실례하겠소. 항만 노동 길드 서기관 로넨이라 하오." 초라한 행색의 사내가 테이블 건너편에 조심스럽게 앉았다. 끊임없이 문 쪽을 훔쳐보는 눈동자가 불안을 감추지 못했다.',
            '',
            '당신은 잔을 내려놓고 사내를 살폈다. 길드 서기라기엔 너무 핏기 없는 얼굴이었다.',
            '',
            `"${(preset as any).prologueHook ?? '부두에서 당신이 일하는 것을 봤소. 길드 안 사람은 아무도 믿을 수가 없어서… 외부 사람이 필요했소.'}" 로넨이 목소리를 한층 낮췄다. "장부가 사라졌소. 이틀 전 밤에 사무실을 털렸는데… 공물 내역만이 아니오. 뒷거래 기록이 전부 들어 있소."`,
            '',
            '당신의 눈이 좁아졌다.',
            '',
            '"길드 간부들이 해관청에 흘린 뇌물 목록이오." 로넨의 손이 잔 위에서 미세하게 떨렸다. "그 장부를 찾아주시오. 보수는… 넉넉히 치르겠소."',
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
        choices: [
          {
            id: 'accept_quest',
            label: '의뢰를 받아들인다',
            hint: '로넨의 부탁을 수락하고 장부를 찾기로 한다',
            action: { type: 'CHOICE' as const, payload: {} },
          },
        ],
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
