// 정본: specs/llm_context_system_v1.md — L0~L4 5계층 인터페이스

import { Inject, Injectable } from '@nestjs/common';
import { and, asc, desc, eq, ne } from 'drizzle-orm';
import { DB, type DrizzleDB } from '../db/drizzle.module.js';
import {
  runMemories,
  nodeMemories,
  nodeInstances,
  recentSummaries,
  turns,
} from '../db/schema/index.js';
import type {
  ServerResultV1,
  NPCState,
  Relationship,
  PlayerBehaviorProfile,
  IncidentRuntime,
  SignalFeedItem,
  NarrativeMark,
} from '../db/types/index.js';
import type {
  NpcEmotionalState,
  NpcPersonalMemory,
} from '../db/types/npc-state.js';
import {
  summarizeRelationship,
  computeEffectivePosture,
  getNpcDisplayName,
  generateRelationSummary,
} from '../db/types/npc-state.js';
import { ContentLoaderService } from '../content/content-loader.service.js';
import type { StructuredMemory } from '../db/types/structured-memory.js';
import type { NpcKnowledgeLedger } from '../db/types/npc-knowledge.js';
import { MemoryRendererService } from './memory-renderer.service.js';
import { MidSummaryService } from './mid-summary.service.js';
import { IntentMemoryService } from '../engine/hub/intent-memory.service.js';

export interface RecentTurnEntry {
  turnNo: number;
  inputType: string;
  rawInput: string;
  resolveOutcome?: string;
  narrative: string;
}

export interface LlmContext {
  theme: unknown[]; // L0: 절대 삭제 금지
  storySummary: string | null; // L1
  nodeFacts: unknown[]; // L2
  recentSummaries: string[]; // L3
  recentTurns: RecentTurnEntry[]; // L3 확장: 플레이어 행동 포함 이력
  locationSessionTurns: RecentTurnEntry[]; // L3 확장: 현재 지역 방문 전체 대화
  currentEvents: unknown[]; // L4: 이번 턴 events
  summary: string; // 이번 턴 summary.short
  // HUB 확장
  worldSnapshot: string | null; // L0 확장: WorldState 요약
  locationContext: string | null; // L1 확장: 현재 LOCATION + 이벤트 컨텍스트
  agendaArc: string | null; // L4 확장: Agenda/Arc 진행도
  // Phase 2: NPC/PBP 확장
  npcRelationFacts: string[]; // L2 확장: NPC 관계 서술 요약
  playerProfile: string | null; // L4 확장: 플레이어 행동 프로필 요약
  // Phase 3: Turn Orchestration
  npcInjection: {
    npcId?: string;
    npcName: string;
    introduced?: boolean;
    posture: string;
    dialogueSeed: string;
    reason: string;
  } | null;
  peakMode: boolean;
  npcPostures: Record<string, string>; // npcId → effective posture
  // Phase 4: Equipment Narrative Tags
  equipmentTags: string[]; // 장비 서술 태그 (최대 6개, LLM 톤 영향)
  activeSetNames: string[]; // 활성 세트 이름 목록
  // P2: 캐릭터 성별
  gender: 'male' | 'female';
  // Narrative Thread Cache
  narrativeThread: string | null; // 장면 흐름 캐시
  // Narrative Engine v1
  incidentContext: string | null; // 활성 Incident 요약
  npcEmotionalContext: string | null; // NPC 감정 상태 요약 (deprecated — prompt-builder에서 직접 빌드)
  npcStates: Record<string, any> | null; // NPC 상태 (prompt-builder에서 감정 블록 빌드용)
  npcDeltaHint: string | null; // 이번 턴 NPC 감정 변화 delta
  hubHeat: number; // HUB Heat 수치 (NPC 감정 블록 mood 계산용)
  hubSafety: string; // HUB 안전도 (NPC 감정 블록 mood 계산용)
  narrativeMarkContext: string | null; // Narrative Mark 요약
  signalContext: string | null; // Signal Feed 요약
  // NPC 소개 시스템
  introducedNpcIds: string[]; // 이미 소개된 NPC
  newlyIntroducedNpcIds: string[]; // 이번 턴 이름 공개되는 NPC
  newlyEncounteredNpcIds: string[]; // 이번 턴 처음 만나는 NPC
  // Structured Memory v2
  structuredSummary: string | null; // visitLog 기반 이야기 요약
  npcJournalText: string | null; // NPC 관계 일지
  incidentChronicleText: string | null; // 사건 연대기
  milestonesText: string | null; // 서사 이정표
  llmFactsText: string | null; // LLM 추출 사실
  // 장면 연속성: 현재 장면 상태
  currentSceneContext: string | null; // 대화 상대, 세부 위치, 진행 중인 상황
  // PR2: Mid Summary (설계문서 18)
  midSummary: string | null;
  // PR3: Intent Memory (설계문서 18)
  intentMemory: string | null;
  // PR4: Active Clues (설계문서 18)
  activeClues: string | null;
  // Phase 2: NPC Knowledge
  npcKnowledge: NpcKnowledgeLedger | null;
  // Phase 4: 장소별 재방문 기억
  locationRevisitContext: string | null;
  // LocationMemory: 장소별 개인 기록 (방문 횟수, 사건, 비밀, 평판)
  locationMemoryText: string | null;
  // Fixplan v1: 직전 장소 이탈 요약
  previousVisitContext: string | null;
  // 프리셋 배경 강화: 주인공 배경 리마인드
  protagonistBackground: string | null;
  // NPC 개인 기록: 현재 턴 관련 NPC만 선별하여 상세 기록
  relevantNpcMemoryText: string | null;
  // Phase 2: IncidentMemory — 관련 사건의 개인 기록 (선별 주입)
  relevantIncidentMemoryText: string | null;
  // Phase 3: ItemMemory — 관련 아이템 기록 (장착 중 + 신규 획득 + LEGENDARY/UNIQUE)
  relevantItemMemoryText: string | null;
  // NPC knownFacts: SUCCESS/PARTIAL 판정 시 NPC가 공개할 정보
  npcRevealableFact: {
    npcDisplayName: string;
    factId: string;
    detail: string;
    resolveOutcome: 'SUCCESS' | 'PARTIAL';
    trust: number;
    posture: string;
    revealMode: 'direct' | 'indirect' | 'observe' | 'refuse';
  } | null;
  // NPC가 이미 플레이어에게 공개한 정보 리스트 (반복 방지용)
  npcAlreadyRevealedFacts: { npcDisplayName: string; facts: string[] } | null;
  // P5: FREE 턴에서 미발견 단서가 있음을 암시하는 힌트
  questFactHint: string | null;
  // Quest nextHint: fact 발견 다음 턴에 방향 힌트 전달
  questDirectionHint: { hint: string; mode: string } | null;
  // 장소 기반 NPC 필터링용
  currentLocationId: string | null;
  currentTimePhase: string | null;
}

@Injectable()
export class ContextBuilderService {
  constructor(
    @Inject(DB) private readonly db: DrizzleDB,
    private readonly memoryRenderer: MemoryRendererService,
    private readonly content: ContentLoaderService,
    private readonly midSummaryService: MidSummaryService,
    private readonly intentMemoryService: IntentMemoryService,
  ) {}

  /** 텍스트에 포함된 NPC 실명을 introduced 상태에 따라 displayName으로 치환 */
  private sanitizeNpcNames(
    text: string,
    runState: Record<string, unknown> | null | undefined,
  ): string {
    if (!text || !runState) return text;
    const npcStates = runState.npcStates as
      | Record<string, NPCState>
      | undefined;
    if (!npcStates) return text;
    let result = text;
    for (const [npcId, state] of Object.entries(npcStates)) {
      if (state.introduced) continue; // 소개 완료된 NPC는 실명 OK
      const npcDef = this.content.getNpc(npcId);
      if (!npcDef || !npcDef.name) continue;
      const alias = npcDef.unknownAlias || '누군가';
      // 실명이 텍스트에 포함되어 있으면 alias로 치환
      if (result.includes(npcDef.name)) {
        result = result.replaceAll(npcDef.name, alias);
      }
      // aliases 배열도 치환
      if (npcDef.aliases) {
        for (const a of npcDef.aliases) {
          if (result.includes(a)) {
            result = result.replaceAll(a, alias);
          }
        }
      }
    }
    return result;
  }

  async build(
    runId: string,
    nodeInstanceId: string,
    serverResult: ServerResultV1,
    runState?: Record<string, unknown> | null,
    gender?: 'male' | 'female',
    presetId?: string | null,
  ): Promise<LlmContext> {
    // L0 + L1: run_memories
    const memory = await this.db.query.runMemories.findFirst({
      where: eq(runMemories.runId, runId),
    });

    // L2: node_memories
    const nodeMem = await this.db.query.nodeMemories.findFirst({
      where: and(
        eq(nodeMemories.runId, runId),
        eq(nodeMemories.nodeInstanceId, nodeInstanceId),
      ),
    });

    // L3: recent_summaries (최근 5개)
    const recents = await this.db
      .select()
      .from(recentSummaries)
      .where(eq(recentSummaries.runId, runId))
      .orderBy(desc(recentSummaries.turnNo))
      .limit(5);

    // L3 확장: 최근 턴의 플레이어 행동 + 결과 조회 (LLM 대화 연속성)
    const recentTurnRows = await this.db
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
          ne(turns.inputType, 'SYSTEM'), // SYSTEM 입력 제외
        ),
      )
      .orderBy(desc(turns.turnNo))
      .limit(5);

    const recentTurns: RecentTurnEntry[] = recentTurnRows
      .reverse() // 시간순 정렬
      .map((t) => {
        const sr = t.serverResult as ServerResultV1 | null;
        return {
          turnNo: t.turnNo,
          inputType: t.inputType,
          rawInput: t.rawInput,
          resolveOutcome: (sr?.ui as Record<string, unknown>)
            ?.resolveOutcome as string | undefined,
          narrative: t.llmOutput ?? sr?.summary?.short ?? '',
        };
      });

    // L3 확장: 현재 LOCATION 방문 전체 대화 (단기 기억)
    // COMBAT 노드인 경우 부모 LOCATION의 대화 이력도 포함 (내러티브 연속성)
    const currentNodeRow = await this.db.query.nodeInstances.findFirst({
      where: eq(nodeInstances.id, nodeInstanceId),
    });
    const parentNodeId = currentNodeRow?.parentNodeInstanceId;

    let parentLocationTurnRows: typeof locationTurnRows = [];
    if (parentNodeId) {
      parentLocationTurnRows = await this.db
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
            eq(turns.nodeInstanceId, parentNodeId),
            ne(turns.inputType, 'SYSTEM'),
          ),
        )
        .orderBy(asc(turns.turnNo))
        .limit(10); // 부모 노드 최근 10턴
    }

    const locationTurnRows = await this.db
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
      .orderBy(asc(turns.turnNo))
      .limit(20); // 최대 20턴 (토큰 제한 고려)

    // 부모 LOCATION 턴 + 현재 노드 턴 병합 (시간순 유지)
    const allLocationTurnRows = [
      ...parentLocationTurnRows,
      ...locationTurnRows,
    ];

    const locationSessionTurns: RecentTurnEntry[] = allLocationTurnRows.map(
      (t) => {
        const sr = t.serverResult as ServerResultV1 | null;
        return {
          turnNo: t.turnNo,
          inputType: t.inputType,
          rawInput: t.rawInput,
          resolveOutcome: (sr?.ui as Record<string, unknown>)
            ?.resolveOutcome as string | undefined,
          narrative: t.llmOutput ?? sr?.summary?.short ?? '',
        };
      },
    );

    // HUB 확장: WorldState, Location, Agenda/Arc 컨텍스트 구축
    let worldSnapshot: string | null = null;
    let locationContext: string | null = null;
    let agendaArc: string | null = null;

    if (runState) {
      const ws = runState.worldState as Record<string, unknown> | undefined;
      if (ws) {
        const snapshotParts = [
          `시간: ${ws.timePhase === 'NIGHT' ? '밤' : '낮'}, 경계도: ${ws.hubHeat}/100 (${ws.hubSafety}), 긴장도: ${ws.tension ?? 0}/10`,
        ];
        if (ws.currentLocationId) {
          locationContext = `현재 위치: ${ws.currentLocationId}`;

          // Living World v2: 장소에 있는 NPC 목록
          const locDynamic = ws.locationDynamicStates as
            | Record<string, { presentNpcs?: string[] }>
            | undefined;
          const presentNpcs =
            locDynamic?.[ws.currentLocationId as string]?.presentNpcs;
          if (presentNpcs && presentNpcs.length > 0) {
            const npcNames = presentNpcs.map((id: string) => {
              const npcDef = this.content.getNpc(id);
              return npcDef?.name ?? id;
            });
            locationContext += ` (이 장소에 있는 인물: ${npcNames.join(', ')})`;
          }
        }

        // Living World v2: 최근 WorldFacts 요약
        const worldFacts = ws.worldFacts as Array<{ text: string }> | undefined;
        if (worldFacts && worldFacts.length > 0) {
          const recentFacts = worldFacts.slice(-5).map((f) => f.text);
          snapshotParts.push(`최근 사실: ${recentFacts.join('; ')}`);
        }

        // Living World v2: 활성 목표
        const playerGoals = (runState.playerGoals ?? runState.playerGoals) as
          | Array<{ description: string; completed: boolean; progress: number }>
          | undefined;
        if (playerGoals) {
          const activeGoals = playerGoals.filter((g) => !g.completed);
          if (activeGoals.length > 0) {
            snapshotParts.push(
              `플레이어 목표: ${activeGoals.map((g) => `${g.description} (${g.progress}%)`).join('; ')}`,
            );
          }
        }

        worldSnapshot = snapshotParts.join('\n');
      }

      const agenda = runState.agenda as Record<string, unknown> | undefined;
      const arcState = runState.arcState as Record<string, unknown> | undefined;
      if (agenda || arcState) {
        const parts: string[] = [];
        if (agenda) {
          const dominant = (agenda as { dominant?: string }).dominant;
          if (dominant) parts.push(`주요 성향: ${dominant}`);
        }
        if (arcState) {
          const route = (arcState as { currentRoute?: string }).currentRoute;
          const commitment = (arcState as { commitment?: number }).commitment;
          if (route)
            parts.push(`아크 경로: ${route} (참여도: ${commitment ?? 0}/3)`);
        }
        if (parts.length > 0) agendaArc = parts.join(', ');
      }
    }

    // resolveOutcome 컨텍스트
    const resolveOutcome = serverResult.ui?.resolveOutcome;
    const resolveCtx = resolveOutcome
      ? `\n[행동 결과] ${resolveOutcome === 'SUCCESS' ? '성공' : resolveOutcome === 'PARTIAL' ? '부분 성공' : '실패'}`
      : '';

    // Phase 2: NPC 관계 서술 요약 (L2 확장)
    const npcRelationFacts: string[] = [];
    if (runState) {
      const npcStates = runState.npcStates as
        | Record<string, NPCState>
        | undefined;
      const relationships = runState.relationships as
        | Record<string, Relationship>
        | undefined;
      if (npcStates && relationships) {
        for (const [npcId, rel] of Object.entries(relationships)) {
          const npc = npcStates[npcId];
          if (npc) {
            const npcDef = this.content.getNpc(npcId);
            const displayName = getNpcDisplayName(npc, npcDef);
            const posture = computeEffectivePosture(npc);
            const summary = summarizeRelationship(displayName, rel);
            npcRelationFacts.push(`${summary} (자세: ${posture})`);
          }
        }
      }
    }

    // Phase 2: 플레이어 행동 프로필 요약 (L4 확장)
    let playerProfile: string | null = null;
    if (runState) {
      const pbp = runState.pbp as PlayerBehaviorProfile | undefined;
      if (pbp && pbp.scores) {
        const s = pbp.scores as unknown as Record<string, number>;
        const nonZero = Object.entries(s).filter(([, v]) => v > 0);
        if (nonZero.length > 0) {
          playerProfile = `플레이어 성향: ${pbp.dominant}/${pbp.secondary} (${nonZero.map(([k, v]) => `${k}=${v}`).join(', ')})`;
        }
      }
    }

    // Phase 3: Orchestration 컨텍스트 (serverResult.ui에서 추출)
    const uiAny = serverResult.ui as Record<string, unknown>;
    const npcInjection =
      (uiAny?.npcInjection as LlmContext['npcInjection']) ?? null;
    const peakMode = (uiAny?.peakMode as boolean) ?? false;
    const npcPostures = (uiAny?.npcPostures as Record<string, string>) ?? {};

    // Phase 4: Equipment narrative tags (serverResult.ui에서 추출)
    const equipmentTags = (uiAny?.equipmentTags as string[]) ?? [];
    const activeSetNames = (uiAny?.activeSetNames as string[]) ?? [];

    // Narrative Thread Cache: node_memories에서 읽기
    const narrativeThread = nodeMem?.narrativeThread ?? null;

    // Narrative Engine v1: Incident / NPC Emotional / Marks / Signals 컨텍스트
    let incidentContext: string | null = null;
    let npcEmotionalContext: string | null = null;
    let npcDeltaHint: string | null = null;
    let narrativeMarkContext: string | null = null;
    let signalContext: string | null = null;

    if (runState) {
      const ws = runState.worldState as Record<string, unknown> | undefined;

      // Incident 요약
      const activeIncidents = (ws?.activeIncidents ?? []) as IncidentRuntime[];
      if (activeIncidents.length > 0) {
        const lines = activeIncidents.map((inc) => {
          const tension =
            inc.pressure >= 70 ? '위기' : inc.pressure >= 40 ? '긴장' : '잠재';
          return `- ${inc.incidentId} (${inc.kind}): 통제 ${inc.control}/100, 압력 ${inc.pressure}/100 [${tension}], 단계 ${inc.stage}`;
        });
        incidentContext = `활성 사건 ${activeIncidents.length}건:\n${lines.join('\n')}`;
      }

      // NPC 감정 상태 → prompt-builder에서 targetNpcIds 기반으로 빌드
      // 여기서는 npcDeltaHint(이번 턴 감정 변화 delta)만 추출
      const npcStates = runState.npcStates as
        | Record<string, NPCState>
        | undefined;
      if (npcStates) {
        const lastDelta = (runState as any).lastNpcDelta as
          | {
              npcId: string;
              delta: Record<string, number>;
              actionType: string;
              outcome: string;
            }
          | undefined;
        if (lastDelta && Object.keys(lastDelta.delta).length > 0) {
          const axisNames: Record<string, string> = {
            trust: '신뢰',
            fear: '공포',
            respect: '존경',
            suspicion: '의심',
            attachment: '유대',
          };
          const deltaDesc = Object.entries(lastDelta.delta)
            .map(([k, v]) => `${axisNames[k] ?? k}${v > 0 ? '+' : ''}${v}`)
            .join(', ');
          const npcDef = this.content.getNpc(lastDelta.npcId);
          const npcState = npcStates[lastDelta.npcId];
          const dName = npcState
            ? getNpcDisplayName(npcState, npcDef)
            : (npcDef?.unknownAlias ?? '관련 인물');
          npcDeltaHint = `⚡ 이번 턴 변화: ${dName}의 감정이 변했다 (${deltaDesc}). 이 변화를 NPC의 표정, 목소리, 행동에 반영하세요.`;
        }
      }
      npcEmotionalContext = null; // deprecated — prompt-builder에서 빌드

      // Narrative Mark 요약 (npcId 대신 displayName 사용)
      const marks = (ws?.narrativeMarks ?? []) as NarrativeMark[];
      if (marks.length > 0) {
        const markLines = marks.map((m) => {
          if (!m.npcId) return `- [${m.type}] ${m.context} (전체)`;
          const markNpcDef = this.content.getNpc(m.npcId);
          const markNpcState = npcStates?.[m.npcId];
          const markNpcName =
            markNpcDef && markNpcState
              ? getNpcDisplayName(markNpcState, markNpcDef)
              : (markNpcDef?.unknownAlias ?? '관련 인물');
          return `- [${m.type}] ${m.context} (${markNpcName})`;
        });
        narrativeMarkContext = `서사 표식 ${marks.length}개:\n${markLines.join('\n')}`;
      }

      // Signal Feed 요약 (severity 3 이상만)
      const signals = (ws?.signalFeed ?? []) as SignalFeedItem[];
      const importantSignals = signals.filter((s) => s.severity >= 3);
      if (importantSignals.length > 0) {
        const sigLines = importantSignals
          .slice(0, 5)
          .map((s) => `- [${s.channel}/${s.severity}] ${s.text}`);
        signalContext = `주요 시그널:\n${sigLines.join('\n')}`;
      }
    }

    // NPC 소개 시스템: 소개 상태 수집
    // ⚠️ newlyIntroducedNpcIds(이번 턴에 처음 소개되는 NPC)는 제외해야 함.
    // turns.service에서 introduced=true를 먼저 설정한 후 DB에 커밋하므로,
    // 비동기 LLM Worker가 읽는 runState에는 이미 introduced=true가 반영되어 있다.
    // 이들을 introducedNpcIds에 포함하면 sanitizeNpcNames()가 실명을 통과시키고,
    // prompt-builder가 실명을 사용해서 "이름 공개 전에 실명이 노출"되는 버그가 발생한다.
    const newlyIntroducedNpcIds =
      (uiAny?.newlyIntroducedNpcIds as string[]) ?? [];
    const newlyEncounteredNpcIds =
      (uiAny?.newlyEncounteredNpcIds as string[]) ?? [];
    const introducedNpcIds: string[] = [];
    if (runState) {
      const allNpcStates = runState.npcStates as
        | Record<string, NPCState>
        | undefined;
      if (allNpcStates) {
        for (const [npcId, npc] of Object.entries(allNpcStates)) {
          if (npc.introduced && !newlyIntroducedNpcIds.includes(npcId)) {
            introducedNpcIds.push(npcId);
          }
        }
      }
    }

    // Structured Memory v2: 렌더링
    let structuredSummary: string | null = null;
    let npcJournalText: string | null = null;
    let incidentChronicleText: string | null = null;
    let milestonesText: string | null = null;
    let llmFactsText: string | null = null;

    const structured = memory?.structuredMemory;
    if (structured) {
      structuredSummary =
        this.memoryRenderer.renderVisitLog(structured.visitLog, 5) || null;
      // 현재 장소의 관련 NPC 우선 표시
      const currentLocationId = (
        runState?.worldState as Record<string, unknown> | undefined
      )?.currentLocationId as string | undefined;
      const activeNpcIds = structured.npcJournal
        .filter((e) =>
          e.interactions.some((i) => i.locationId === currentLocationId),
        )
        .map((e) => e.npcId);
      npcJournalText =
        this.memoryRenderer.renderNpcJournal(
          structured.npcJournal,
          activeNpcIds,
        ) || null;
      incidentChronicleText =
        this.memoryRenderer.renderIncidentChronicle(
          structured.incidentChronicle,
        ) || null;
      milestonesText =
        this.memoryRenderer.renderMilestones(structured.milestones, 5) || null;
      // LLM facts 필터링: 현재 장소 + 현재 NPC
      const encounterNpcIds = structured.npcJournal.map((e) => e.npcId);
      llmFactsText =
        this.memoryRenderer.renderLlmFacts(
          structured.llmExtracted,
          currentLocationId ?? undefined,
          encounterNpcIds,
        ) || null;
    }

    // 장면 연속성: 현재 장면 상태 구축
    let currentSceneContext: string | null = null;
    if (locationSessionTurns.length > 0) {
      const sceneParts: string[] = [];

      // 1. 대화 상대 추출: actionContext에서 primaryNpcId 확인
      const uiData = serverResult.ui as Record<string, unknown>;
      const actionCtx = uiData?.actionContext as
        | Record<string, unknown>
        | undefined;
      const primaryNpcId = actionCtx?.primaryNpcId as string | null | undefined;

      // 1a. 플레이어 입력(rawInput)에서 NPC 이름 감지 → 서술 중심 NPC 지정
      const rawInput =
        ((
          (serverResult as Record<string, unknown>)?.summary as Record<
            string,
            unknown
          >
        )?.short as string) ?? '';
      const npcStatesAll = runState?.npcStates as
        | Record<string, NPCState>
        | undefined;
      let choiceTargetNpcName: string | null = null;
      if (rawInput && npcStatesAll) {
        for (const [npcId, npcState] of Object.entries(npcStatesAll)) {
          const npcDef = this.content.getNpc(npcId);
          if (!npcDef) continue;
          const displayName = getNpcDisplayName(npcState, npcDef);
          if (rawInput.includes(displayName)) {
            choiceTargetNpcName = displayName;
            break;
          }
        }
      }
      if (choiceTargetNpcName) {
        sceneParts.push(
          `⚠️ 플레이어가 선택한 대화/행동 대상: ${choiceTargetNpcName} — 이 NPC가 서술의 중심이어야 합니다`,
        );
      }

      if (primaryNpcId) {
        const npcStates = runState?.npcStates as
          | Record<string, NPCState>
          | undefined;
        const npc = npcStates?.[primaryNpcId];
        if (npc) {
          const npcDef = this.content.getNpc(primaryNpcId);
          const displayName = getNpcDisplayName(npc, npcDef);
          const posture = computeEffectivePosture(npc);
          const isChoiceTarget = choiceTargetNpcName === displayName;
          sceneParts.push(
            `이벤트 NPC: ${displayName} (${posture})${isChoiceTarget ? '' : ' — 배경에만 등장, 대화 주도하지 말 것'}`,
          );
        }
      } else {
        // 직전 턴들에서 NPC 추적 (최근 3턴 내 actionContext에서 primaryNpcId 검색)
        const recentLocationTurns = allLocationTurnRows.slice(-3);
        for (const t of recentLocationTurns.reverse()) {
          const sr = t.serverResult as ServerResultV1 | null;
          const prevActionCtx = (sr?.ui as Record<string, unknown>)
            ?.actionContext as Record<string, unknown> | undefined;
          const prevNpcId = prevActionCtx?.primaryNpcId as
            | string
            | null
            | undefined;
          if (prevNpcId) {
            const npcStates = runState?.npcStates as
              | Record<string, NPCState>
              | undefined;
            const npc = npcStates?.[prevNpcId];
            if (npc) {
              const npcDef = this.content.getNpc(prevNpcId);
              const displayName = getNpcDisplayName(npc, npcDef);
              sceneParts.push(`최근 상호작용 상대: ${displayName}`);
            }
            break;
          }
        }
      }

      // 2. 세부 위치: 진행 중인 장면에서는 sceneFrame 대신 직전 내러티브 마지막 문장 활용
      const ongoingNarrativeTurns = locationSessionTurns.filter(
        (t) => t.narrative && t.narrative.length > 0,
      );
      if (ongoingNarrativeTurns.length >= 2) {
        // 2턴 이상 진행: sceneFrame 완전 무시, 직전 내러티브의 마지막 150자로 장면 파악
        const lastNarrative =
          ongoingNarrativeTurns[ongoingNarrativeTurns.length - 1].narrative;
        if (lastNarrative) {
          const tail =
            lastNarrative.length > 150
              ? lastNarrative.slice(-150)
              : lastNarrative;
          sceneParts.push(`직전 장면(이어쓸 지점): ...${tail}`);
        }
      } else {
        // 첫/두번째 턴: sceneFrame 활용
        const sceneFrame = actionCtx?.eventSceneFrame as string | undefined;
        if (sceneFrame) {
          sceneParts.push(
            `장면 배경(참고용, NPC가 직접 정보를 전달하지 말 것): ${sceneFrame}`,
          );
        } else {
          const lastTurn = allLocationTurnRows[allLocationTurnRows.length - 1];
          if (lastTurn) {
            const sr = lastTurn.serverResult as ServerResultV1 | null;
            const prevSceneFrame = (
              (sr?.ui as Record<string, unknown>)?.actionContext as Record<
                string,
                unknown
              >
            )?.eventSceneFrame as string | undefined;
            if (prevSceneFrame) {
              sceneParts.push(
                `장면 배경(참고용, NPC가 직접 정보를 전달하지 말 것): ${prevSceneFrame}`,
              );
            }
          }
        }
      }

      // 3. 현재 위치 (locationId → 한국어)
      const ws = runState?.worldState as Record<string, unknown> | undefined;
      const currentLocationId = ws?.currentLocationId as string | undefined;
      if (currentLocationId) {
        const locNames: Record<string, string> = {
          LOC_MARKET: '시장 거리',
          LOC_GUARD: '경비대 지구',
          LOC_HARBOR: '항만 부두',
          LOC_SLUMS: '빈민가',
        };
        sceneParts.push(
          `현재 위치: ${locNames[currentLocationId] ?? currentLocationId}`,
        );
      }

      // 4. 이번 방문 턴 수
      sceneParts.push(`이번 방문 ${locationSessionTurns.length}턴째`);

      // 4a. 대화 연속 감지: 직전 턴의 NPC와 이번 턴의 NPC가 같으면 "대화 연속 중" 지시
      const currentTargetNpcId =
        (actionCtx?.targetNpcId as string | undefined) ?? primaryNpcId ?? null;
      if (currentTargetNpcId && allLocationTurnRows.length >= 1) {
        const prevTurn = allLocationTurnRows[allLocationTurnRows.length - 1];
        const prevSr = prevTurn?.serverResult as ServerResultV1 | null;
        const prevAc = (prevSr?.ui as Record<string, unknown>)
          ?.actionContext as Record<string, unknown> | undefined;
        const prevTargetNpcId =
          (prevAc?.targetNpcId as string | undefined) ??
          (prevAc?.primaryNpcId as string | undefined) ??
          null;
        if (prevTargetNpcId === currentTargetNpcId) {
          const npcDef = this.content.getNpc(currentTargetNpcId);
          const npcState = npcStatesAll?.[currentTargetNpcId];
          const displayName =
            npcDef && npcState
              ? getNpcDisplayName(npcState, npcDef)
              : (npcDef?.unknownAlias ?? '상대 인물');
          sceneParts.push(
            `⚠️ 대화 연속 중: ${displayName}와(과) 대화가 이어지고 있습니다. 이 NPC가 떠나거나 장면이 종료되지 않아야 합니다. 대화가 자연스럽게 계속될 수 있는 열린 상태로 서술을 마무리하세요.`,
          );
        }
      }

      // 5. 직전 행동 요약
      const lastSessionTurn =
        locationSessionTurns[locationSessionTurns.length - 1];
      if (lastSessionTurn) {
        const outcomeText =
          lastSessionTurn.resolveOutcome === 'SUCCESS'
            ? '성공'
            : lastSessionTurn.resolveOutcome === 'PARTIAL'
              ? '부분 성공'
              : lastSessionTurn.resolveOutcome === 'FAIL'
                ? '실패'
                : '';
        const outcomePart = outcomeText ? ` → ${outcomeText}` : '';
        sceneParts.push(
          `직전 행동: "${lastSessionTurn.rawInput}"${outcomePart}`,
        );
      }

      if (sceneParts.length > 0) {
        currentSceneContext = sceneParts.join('\n');
      }
    }

    // PR3: Intent Memory — actionHistory에서 패턴 감지 (midSummary보다 먼저 계산)
    let intentMemory: string | null = null;
    if (runState) {
      const actionHistory =
        (runState.actionHistory as Array<{ actionType: string }>) ?? [];
      const patterns = this.intentMemoryService.analyze(actionHistory);
      if (patterns) {
        intentMemory = this.intentMemoryService.renderForContext(patterns);
      }
    }

    // PR2: Mid Summary — locationSessionTurns > 4 → 초기 턴 압축 (async 2-pass)
    let midSummary: string | null = null;
    let finalLocationSessionTurns = locationSessionTurns;
    if (locationSessionTurns.length > 4) {
      const earlyTurns = locationSessionTurns.slice(0, -4);
      // intentMemory + activeIncidents를 Mid Summary에 전달하여 맥락 유지
      const activeIncidentNames: string[] = [];
      if (runState) {
        const ws = runState.worldState as Record<string, unknown> | undefined;
        const incidents = (ws?.activeIncidents ?? []) as Array<{
          incidentId: string;
          kind?: string;
        }>;
        for (const inc of incidents) {
          activeIncidentNames.push(inc.incidentId);
        }
      }
      midSummary = await this.midSummaryService.generate(
        earlyTurns,
        runState,
        structured?.llmExtracted,
        structured?.npcKnowledge ?? undefined,
        intentMemory,
        activeIncidentNames.length > 0 ? activeIncidentNames : undefined,
      );
      finalLocationSessionTurns = locationSessionTurns.slice(-4);
    }

    // PR4: Active Clues — StructuredMemory에서 유효 단서 추출
    let activeClues: string | null = null;
    if (structured) {
      activeClues =
        this.memoryRenderer.renderActiveClues(
          structured,
          runState?.worldState as Record<string, unknown> | undefined,
        ) || null;
    }

    // Fixplan v1: 직전 장소 이탈 요약 — currentLocationId와 다른 장소에서 온 경우
    let previousVisitContext: string | null = null;
    if (structured?.lastExitSummary) {
      const currentLocationId = (
        runState?.worldState as Record<string, unknown> | undefined
      )?.currentLocationId as string | undefined;
      const exit = structured.lastExitSummary;
      if (currentLocationId && exit.locationId !== currentLocationId) {
        const parts: string[] = [];
        parts.push(
          `직전 장소: ${exit.locationName} (${exit.turnCount}턴 체류)`,
        );
        if (exit.keyActions.length > 0) {
          parts.push(`주요 행동: ${exit.keyActions.join('; ')}`);
        }
        if (exit.keyDialogues.length > 0) {
          parts.push(`주요 대화: ${exit.keyDialogues.join('; ')}`);
        }
        if (exit.unresolvedLeads.length > 0) {
          parts.push(`미해결 단서: ${exit.unresolvedLeads.join('; ')}`);
        }
        previousVisitContext = parts.join('\n');
      }
    }

    // 프리셋 배경 강화: 주인공 배경 리마인드 블록 구축
    let protagonistBackground: string | null = null;
    if (presetId) {
      const presetDef = this.content.getPreset(presetId);
      if (presetDef) {
        const bgParts: string[] = [];
        bgParts.push(`직업: ${presetDef.name} (${presetDef.subtitle})`);
        bgParts.push(`배경: ${presetDef.protagonistTheme}`);
        // runState.actionBonuses 우선 (프리셋+특성 합산), 없으면 프리셋 fallback
        const effectiveBonuses =
          runState?.actionBonuses ?? presetDef.actionBonuses;
        if (effectiveBonuses) {
          const bonusDesc = Object.entries(effectiveBonuses)
            .map(([action, bonus]) => `${action} +${bonus}`)
            .join(', ');
          bgParts.push(`특기: ${bonusDesc}`);
        }
        // 프리셋별 행동 묘사 키워드 — LLM이 행동 서술에 자연스럽게 반영
        const PRESET_MANNERISMS: Record<string, string> = {
          DOCKWORKER: '행동 특징: 거친 손, 무거운 것에 익숙한 어깨, 투박하지만 믿음직한 몸짓, 부두 노동자 특유의 직선적 화법',
          DESERTER: '행동 특징: 군인 특유의 절도 있는 움직임, 본능적으로 퇴로를 확인하는 습관, 전장의 긴장감이 배어있는 자세',
          SMUGGLER: '행동 특징: 어둠에 익숙한 눈, 은밀하고 재빠른 손놀림, 상대를 살피는 날카로운 시선, 뒷골목을 잘 아는 발걸음',
          HERBALIST: '행동 특징: 풀과 약초 냄새가 배어있는 손, 식물을 다루듯 섬세한 손길, 관찰력 있는 시선, 차분하고 신중한 태도',
          FALLEN_NOBLE: '행동 특징: 무의식적인 귀족 예법, 교양이 묻어나는 말투, 격식 있는 자세, 과거의 품격이 남아있는 행동거지',
          GLADIATOR: '행동 특징: 투기장에서 단련된 본능, 위험을 두려워하지 않는 당당한 자세, 전투적 시선, 거칠고 직접적인 행동',
        };
        const mannerism = PRESET_MANNERISMS[presetId];
        if (mannerism) bgParts.push(mannerism);
        protagonistBackground = bgParts.join('\n');
      }
    }

    // === NPC 개인 기록: 현재 턴 관련 NPC만 선별 ===
    let relevantNpcMemoryText: string | null = null;
    if (runState) {
      const allNpcStates = runState.npcStates as
        | Record<string, NPCState>
        | undefined;
      if (allNpcStates) {
        const relevantNpcIds = new Set<string>();

        // 1. 현재 이벤트의 primaryNpcId
        const uiForNpc = serverResult.ui as Record<string, unknown>;
        const acForNpc = uiForNpc?.actionContext as
          | Record<string, unknown>
          | undefined;
        const primaryNpc = acForNpc?.primaryNpcId as string | null | undefined;
        if (primaryNpc) relevantNpcIds.add(primaryNpc);

        // 2. 현재 장소에 present하는 NPC
        const wsForNpc = runState.worldState as
          | Record<string, unknown>
          | undefined;
        const currentLocForNpc = wsForNpc?.currentLocationId as
          | string
          | undefined;
        const locDynForNpc = wsForNpc?.locationDynamicStates as
          | Record<string, { presentNpcs?: string[] }>
          | undefined;
        if (currentLocForNpc && locDynForNpc?.[currentLocForNpc]?.presentNpcs) {
          for (const nid of locDynForNpc[currentLocForNpc].presentNpcs) {
            relevantNpcIds.add(nid);
          }
        }

        // 3. npcInjection의 NPC
        const injNpc = (uiForNpc?.npcInjection as { npcId?: string } | null)
          ?.npcId;
        if (injNpc) relevantNpcIds.add(injNpc);

        // 4. 이벤트 sceneFrame/태그에 언급된 NPC (이름 매칭)
        const sceneFrameForNpc = acForNpc?.eventSceneFrame as
          | string
          | undefined;
        if (sceneFrameForNpc) {
          for (const [npcId] of Object.entries(allNpcStates)) {
            const npcDef = this.content.getNpc(npcId);
            if (npcDef?.name && sceneFrameForNpc.includes(npcDef.name)) {
              relevantNpcIds.add(npcId);
            }
          }
        }

        // 선별된 NPC의 personalMemory 렌더링
        if (relevantNpcIds.size > 0) {
          relevantNpcMemoryText = this.renderRelevantNpcMemory(
            allNpcStates,
            relevantNpcIds,
          );
        }
      }
    }

    // === NPC knownFacts: SUCCESS/PARTIAL 판정 시 NPC가 공개할 단서 선택 ===
    let npcRevealableFact: LlmContext['npcRevealableFact'] = null;
    {
      const outcome = resolveOutcome as string | undefined;
      if (outcome === 'SUCCESS' || outcome === 'PARTIAL') {
        // primaryNpcId 추출 (actionContext에서)
        const uiForFact = serverResult.ui as Record<string, unknown>;
        const acForFact = uiForFact?.actionContext as
          | Record<string, unknown>
          | undefined;
        const factNpcId = acForFact?.primaryNpcId as string | null | undefined;

        if (factNpcId) {
          const npcDef = this.content.getNpc(factNpcId);
          if (npcDef?.knownFacts && npcDef.knownFacts.length > 0) {
            // 이미 공개된 factId 집합: npcKnowledge 레저에서 확인
            const knowledgeEntries =
              structured?.npcKnowledge?.[factNpcId] ?? [];
            const revealedFactIds = new Set(
              knowledgeEntries.map((e) => e.factId),
            );

            // 첫 번째 미공개 fact 선택 (순서대로 점진적 공개)
            const unrevealed = npcDef.knownFacts.find(
              (f) => !revealedFactIds.has(f.factId),
            );
            if (unrevealed) {
              const npcStatesForFact = runState?.npcStates as
                | Record<string, NPCState>
                | undefined;
              const npcState = npcStatesForFact?.[factNpcId];
              const displayName = npcState
                ? getNpcDisplayName(npcState, npcDef)
                : npcDef.unknownAlias || npcDef.name;

              // fact detail에서 미소개 NPC 실명을 별칭으로 치환
              const sanitizedDetail = this.sanitizeNpcNames(
                unrevealed.detail,
                runState,
              );
              npcRevealableFact = {
                npcDisplayName: displayName,
                factId: unrevealed.factId,
                detail: sanitizedDetail,
                resolveOutcome: outcome,
                trust: npcState?.emotional?.trust ?? 0,
                posture: npcState?.posture ?? 'CAUTIOUS',
                revealMode:
                  ((runState as Record<string, unknown>)?._npcRevealMode as
                    | 'direct'
                    | 'indirect'
                    | 'observe') ?? 'indirect',
              };
            }
          }
        }
      }
    }

    // === NPC 이미 공개한 정보 리스트 (LLM 반복 방지용) ===
    let npcAlreadyRevealedFacts: LlmContext['npcAlreadyRevealedFacts'] = null;
    {
      const uiForRev = serverResult.ui as Record<string, unknown>;
      const acForRev = uiForRev?.actionContext as
        | Record<string, unknown>
        | undefined;
      const revNpcId =
        (acForRev?.targetNpcId as string | undefined) ??
        (acForRev?.primaryNpcId as string | undefined);
      if (revNpcId && structured?.npcKnowledge) {
        const entries = structured.npcKnowledge[revNpcId] ?? [];
        if (entries.length > 0) {
          const npcDef = this.content.getNpc(revNpcId);
          const npcStatesForRev = runState?.npcStates as
            | Record<string, NPCState>
            | undefined;
          const npcState = npcStatesForRev?.[revNpcId];
          const displayName =
            npcDef && npcState ? getNpcDisplayName(npcState, npcDef) : revNpcId;
          npcAlreadyRevealedFacts = {
            npcDisplayName: displayName,
            facts: entries
              .map((e) => this.sanitizeNpcNames(e.text, runState))
              .slice(0, 5),
          };
        }
      }
    }

    // NPC 실명 누출 방지: npcInjection 및 주요 텍스트 필드 sanitize
    const sanitize = (text: string | null) =>
      text ? this.sanitizeNpcNames(text, runState) : text;
    const sanitizedNpcInjection = npcInjection
      ? {
          ...npcInjection,
          dialogueSeed: this.sanitizeNpcNames(
            npcInjection.dialogueSeed,
            runState,
          ),
          reason: this.sanitizeNpcNames(npcInjection.reason, runState),
        }
      : null;

    return {
      theme: memory?.theme ?? [],
      storySummary: sanitize(memory?.storySummary ?? null),
      nodeFacts: nodeMem?.nodeFacts ?? [],
      recentSummaries: recents.map((r) => r.summary),
      recentTurns,
      locationSessionTurns: finalLocationSessionTurns,
      currentEvents: serverResult.events,
      summary: serverResult.summary.short + resolveCtx,
      worldSnapshot,
      locationContext,
      agendaArc,
      npcRelationFacts,
      playerProfile,
      npcInjection: sanitizedNpcInjection,
      peakMode,
      npcPostures,
      equipmentTags,
      activeSetNames,
      gender: gender ?? 'male',
      narrativeThread,
      incidentContext: sanitize(incidentContext),
      npcEmotionalContext: sanitize(npcEmotionalContext),
      npcStates: (runState?.npcStates as Record<string, any>) ?? null,
      npcDeltaHint: sanitize(npcDeltaHint),
      hubHeat:
        ((runState?.worldState as Record<string, unknown> | undefined)
          ?.hubHeat as number) ?? 0,
      hubSafety:
        ((runState?.worldState as Record<string, unknown> | undefined)
          ?.hubSafety as string) ?? 'SAFE',
      narrativeMarkContext: sanitize(narrativeMarkContext),
      signalContext: sanitize(signalContext),
      // NPC 소개 시스템
      introducedNpcIds,
      newlyIntroducedNpcIds,
      newlyEncounteredNpcIds,
      // Structured Memory v2
      structuredSummary: sanitize(structuredSummary),
      npcJournalText: sanitize(npcJournalText),
      incidentChronicleText: sanitize(incidentChronicleText),
      milestonesText: sanitize(milestonesText),
      llmFactsText: sanitize(llmFactsText),
      // 장면 연속성
      currentSceneContext: sanitize(currentSceneContext),
      // PR2/3/4: 신규 컨텍스트
      midSummary,
      intentMemory,
      activeClues,
      // Phase 2: NPC Knowledge
      npcKnowledge: structured?.npcKnowledge ?? null,
      // Fixplan v1: 직전 장소 이탈 요약
      previousVisitContext,
      // Phase 4: 장소별 재방문 기억
      locationRevisitContext: sanitize(
        structured
          ? this.memoryRenderer.renderLocationRevisitContext(
              ((runState?.worldState as Record<string, unknown> | undefined)
                ?.currentLocationId as string | undefined) ?? '',
              structured.visitLog,
              structured.npcJournal,
              structured.npcKnowledge ?? {},
            )
          : null,
      ),
      // LocationMemory: 장소별 개인 기록
      locationMemoryText: sanitize(this.buildLocationMemoryText(runState)),
      // 프리셋 배경 강화
      protagonistBackground,
      // NPC 개인 기록
      relevantNpcMemoryText: sanitize(relevantNpcMemoryText),
      // Phase 2: IncidentMemory — 관련 사건 선별 주입
      relevantIncidentMemoryText: sanitize(
        this.buildRelevantIncidentMemoryText(runState, serverResult),
      ),
      // Phase 3: ItemMemory — 관련 아이템 기록 선별 주입
      relevantItemMemoryText: this.buildRelevantItemMemoryText(
        runState,
        serverResult,
      ),
      // NPC knownFacts: SUCCESS/PARTIAL 판정 시 공개할 단서
      npcRevealableFact,
      // NPC가 이미 공개한 정보 (반복 방지)
      npcAlreadyRevealedFacts,
      // P5: FREE 턴 단서 힌트
      questFactHint: this.buildQuestFactHint(serverResult, runState),
      // Quest nextHint: fact 발견 다음 턴에 방향 힌트 전달
      questDirectionHint: this.buildQuestDirectionHint(serverResult, runState),
      // 장소 기반 NPC 필터링
      currentLocationId:
        (runState?.worldState as any)?.currentLocationId ?? null,
      currentTimePhase:
        (runState?.worldState as any)?.phaseV2 ??
        (runState?.worldState as any)?.timePhase ??
        null,
    };
  }

  /**
   * LocationMemory: 현재 장소의 개인 기록을 LLM 컨텍스트 텍스트로 변환.
   * 첫 방문이면 "처음 방문하는 장소" 표시, 재방문이면 상세 기록.
   */
  private buildLocationMemoryText(
    runState?: Record<string, unknown> | null,
  ): string | null {
    if (!runState) return null;

    const ws = runState.worldState as Record<string, unknown> | undefined;
    const currentLocationId = ws?.currentLocationId as string | undefined;
    if (!currentLocationId) return null;

    const locationMemories = runState.locationMemories as
      | Record<
          string,
          import('../db/types/permanent-stats.js').LocationPersonalMemory
        >
      | undefined;
    const mem = locationMemories?.[currentLocationId];

    const LOCATION_NAMES: Record<string, string> = {
      LOC_MARKET: '그레이마르 시장',
      LOC_GUARD: '경비대 지구',
      LOC_HARBOR: '항만 부두',
      LOC_SLUMS: '빈민가',
      LOC_NOBLE: '상류 거리',
      LOC_TAVERN: '잠긴 닻 선술집',
      LOC_DOCKS_WAREHOUSE: '항만 창고구',
    };
    const locName = LOCATION_NAMES[currentLocationId] ?? currentLocationId;

    if (!mem || mem.visitCount === 0) {
      return `[장소 기억: ${locName}]\n처음 방문하는 장소입니다.`;
    }

    const lines: string[] = [];
    lines.push(`[장소 기억: ${locName}]`);
    lines.push(
      `방문 ${mem.visitCount}회 (총 ${mem.totalTurnsSpent}턴 체류), 최근 T${mem.lastVisitTurn}`,
    );

    if (mem.significantEvents.length > 0) {
      lines.push('주요 사건:');
      for (const evt of mem.significantEvents.slice(-5)) {
        const outcomeKr =
          evt.outcome === 'SUCCESS'
            ? '성공'
            : evt.outcome === 'PARTIAL'
              ? '부분성공'
              : '실패';
        lines.push(`- T${evt.turnNo}: ${evt.eventSummary} (${outcomeKr})`);
      }
    }

    if (mem.discoveredSecrets.length > 0) {
      lines.push(`발견한 비밀: ${mem.discoveredSecrets.join(', ')}`);
    }

    if (mem.reputationNote) {
      lines.push(`장소 평판: ${mem.reputationNote}`);
    }

    return lines.join('\n');
  }

  /**
   * Phase 2: IncidentMemory — 관련 사건만 선별하여 LLM 컨텍스트용 텍스트 생성.
   *
   * 선별 기준:
   * 1. 현재 이벤트가 incident와 매칭된 경우 (routingResult)
   * 2. 현재 장소에서 활성 incident가 있는 경우
   * 3. 관련 NPC가 등장하는 경우
   */
  private buildRelevantIncidentMemoryText(
    runState?: Record<string, unknown> | null,
    serverResult?: ServerResultV1,
  ): string | null {
    if (!runState) return null;

    const incidentMemories = runState.incidentMemories as
      | Record<
          string,
          import('../db/types/permanent-stats.js').IncidentPersonalMemory
        >
      | undefined;
    if (!incidentMemories || Object.keys(incidentMemories).length === 0)
      return null;

    const ws = runState.worldState as Record<string, unknown> | undefined;
    const currentLocationId = ws?.currentLocationId as string | undefined;
    const activeIncidents =
      (ws?.activeIncidents as Array<{
        incidentId: string;
        resolved?: boolean;
        control?: number;
        pressure?: number;
      }>) ?? [];

    // ServerResult에서 routingResult 관련 incidentId 추출
    const uiAny = serverResult?.ui as Record<string, unknown> | undefined;
    const actionCtx = uiAny?.actionContext as
      | Record<string, unknown>
      | undefined;
    const relatedIncidentId = actionCtx?.relatedIncidentId as
      | string
      | undefined;
    const primaryNpcId = actionCtx?.primaryNpcId as string | undefined;

    // 관련 사건 ID 수집
    const relevantIncidentIds = new Set<string>();

    // 1. 현재 이벤트가 incident와 매칭된 경우
    if (relatedIncidentId && incidentMemories[relatedIncidentId]) {
      relevantIncidentIds.add(relatedIncidentId);
    }

    // 2. 현재 장소에서 활성 incident가 있는 경우
    if (currentLocationId) {
      for (const inc of activeIncidents) {
        if (inc.resolved) continue;
        const def = this.content.getIncident(inc.incidentId);
        if (def && incidentMemories[inc.incidentId]) {
          relevantIncidentIds.add(inc.incidentId);
        }
      }
    }

    // 3. 관련 NPC가 등장하는 경우
    if (primaryNpcId) {
      for (const [incId, mem] of Object.entries(incidentMemories)) {
        if (mem.relatedNpcIds.includes(primaryNpcId)) {
          relevantIncidentIds.add(incId);
        }
      }
    }

    if (relevantIncidentIds.size === 0) return null;

    const LOCATION_NAMES: Record<string, string> = {
      LOC_MARKET: '시장',
      LOC_GUARD: '경비대',
      LOC_HARBOR: '항만',
      LOC_SLUMS: '빈민가',
      LOC_NOBLE: '상류 거리',
      LOC_TAVERN: '선술집',
      LOC_DOCKS_WAREHOUSE: '항만 창고구',
    };

    const blocks: string[] = [];

    for (const incId of relevantIncidentIds) {
      const mem = incidentMemories[incId];
      if (!mem) continue;

      const incDef = this.content.getIncident(incId);
      const title = incDef?.title ?? incId;

      // 현재 control 합산
      const activeInc = activeIncidents.find((i) => i.incidentId === incId);
      const controlInfo = activeInc
        ? ` (control ${activeInc.control ?? 0})`
        : '';

      const lines: string[] = [];
      lines.push(`[관련 사건: ${title}]`);
      lines.push(`플레이어 입장: ${mem.playerStance}${controlInfo}`);

      if (mem.playerInvolvements.length > 0) {
        lines.push('관여 이력:');
        for (const inv of mem.playerInvolvements.slice(-5)) {
          const locName = LOCATION_NAMES[inv.locationId] ?? inv.locationId;
          lines.push(
            `- T${inv.turnNo} ${locName}: ${inv.action} -> ${inv.impact}`,
          );
        }
      }

      if (mem.knownClues.length > 0) {
        lines.push(`확보한 단서: ${mem.knownClues.join(', ')}`);
      }

      if (mem.relatedNpcIds.length > 0) {
        const allNpcStatesForInc = runState?.npcStates as
          | Record<string, NPCState>
          | undefined;
        const npcNames = mem.relatedNpcIds.map((nid) => {
          const npcDef = this.content.getNpc(nid);
          if (!npcDef) return '알 수 없는 인물';
          const npcState = allNpcStatesForInc?.[nid];
          if (npcState) return getNpcDisplayName(npcState, npcDef);
          return npcDef.unknownAlias || '알 수 없는 인물';
        });
        lines.push(`관련 NPC: ${npcNames.join(', ')}`);
      }

      blocks.push(lines.join('\n'));
    }

    return blocks.length > 0 ? blocks.join('\n\n') : null;
  }

  /**
   * Phase 3: ItemMemory — 관련 아이템만 선별하여 LLM 컨텍스트 텍스트 생성.
   * 선별 기준:
   *   1. 현재 장착 중인 장비 (equipped)
   *   2. 이번 턴에 새로 획득한 아이템 (LOOT+EQUIPMENT_DROP 이벤트)
   *   3. LEGENDARY/UNIQUE 아이템은 항상 포함
   */
  private buildRelevantItemMemoryText(
    runState?: Record<string, unknown> | null,
    serverResult?: ServerResultV1,
  ): string | null {
    if (!runState) return null;

    const itemMemories = runState.itemMemories as
      | Record<
          string,
          import('../db/types/permanent-stats.js').ItemPersonalMemory
        >
      | undefined;
    if (!itemMemories || Object.keys(itemMemories).length === 0) return null;

    const equipped = runState.equipped as
      | Record<string, import('../db/types/equipment.js').ItemInstance>
      | undefined;

    // 이번 턴 새로 획득한 아이템 instanceId 추출
    const newlyAcquiredIds = new Set<string>();
    if (serverResult?.events) {
      for (const ev of serverResult.events) {
        if (ev.tags?.includes('EQUIPMENT_DROP') && ev.data) {
          const data = ev.data;
          if (data.instanceId) newlyAcquiredIds.add(data.instanceId as string);
        }
      }
    }

    // 장착 중 장비의 instanceId
    const equippedIds = new Set<string>();
    if (equipped) {
      for (const inst of Object.values(equipped)) {
        if (inst?.instanceId) equippedIds.add(inst.instanceId);
      }
    }

    const equippedLines: string[] = [];
    const newlyAcquiredLines: string[] = [];
    const legendaryLines: string[] = [];

    for (const [instanceId, mem] of Object.entries(itemMemories)) {
      // 아이템 정보 조회
      const allEquipment = [
        ...Object.values(equipped ?? {}),
        ...((runState.equipmentBag as import('../db/types/equipment.js').ItemInstance[]) ??
          []),
      ].filter(Boolean);
      const inst = allEquipment.find((i) => i?.instanceId === instanceId);
      if (!inst) continue; // 이미 버린 아이템은 스킵

      const itemDef = this.content.getItem(inst.baseItemId);
      const rarity = itemDef?.rarity ?? 'RARE';
      const name = inst.displayName;
      const isLegendaryOrUnique = rarity === 'LEGENDARY' || rarity === 'UNIQUE';
      const noteText =
        isLegendaryOrUnique && mem.narrativeNote
          ? `, "${mem.narrativeNote}"`
          : '';

      if (equippedIds.has(instanceId)) {
        equippedLines.push(
          `${name} (T${mem.acquiredTurn} ${mem.acquiredFrom}${noteText})`,
        );
      } else if (newlyAcquiredIds.has(instanceId)) {
        newlyAcquiredLines.push(`${name} (이번 턴 ${mem.acquiredFrom})`);
      } else if (isLegendaryOrUnique) {
        legendaryLines.push(
          `${name} (T${mem.acquiredTurn} ${mem.acquiredFrom}${noteText})`,
        );
      }
    }

    if (
      equippedLines.length === 0 &&
      newlyAcquiredLines.length === 0 &&
      legendaryLines.length === 0
    ) {
      return null;
    }

    const parts: string[] = ['[장비 서술 참조]'];
    if (equippedLines.length > 0) {
      parts.push(`장착 중: ${equippedLines.join('; ')}`);
    }
    if (newlyAcquiredLines.length > 0) {
      parts.push(`신규 획득: ${newlyAcquiredLines.join('; ')}`);
    }
    if (legendaryLines.length > 0) {
      parts.push(`보유 전설/유니크: ${legendaryLines.join('; ')}`);
    }

    return parts.join('\n');
  }

  /**
   * 선별된 NPC의 personalMemory를 LLM 컨텍스트용 텍스트로 렌더링.
   * personalMemory가 없는 NPC는 기본 관계 정보만 출력.
   */
  private renderRelevantNpcMemory(
    allNpcStates: Record<string, NPCState>,
    relevantNpcIds: Set<string>,
  ): string | null {
    const LOCATION_NAMES: Record<string, string> = {
      LOC_MARKET: '시장',
      LOC_GUARD: '경비대',
      LOC_HARBOR: '항만',
      LOC_SLUMS: '빈민가',
    };
    const blocks: string[] = [];

    for (const npcId of relevantNpcIds) {
      const npc = allNpcStates[npcId];
      if (!npc) continue;

      const npcDef = this.content.getNpc(npcId);
      const displayName = getNpcDisplayName(npc, npcDef);
      const posture = computeEffectivePosture(npc);
      const pm = npc.personalMemory;

      if (pm && pm.encounters.length > 0) {
        // 상세 기록 있음
        const lines: string[] = [];
        lines.push(`[NPC: ${displayName}]`);
        lines.push(
          `관계: ${pm.relationSummary || generateRelationSummary(posture, npc.emotional.trust)} (trust: ${npc.emotional.trust})`,
        );

        // 과거 만남 (최근 5개만 렌더링하여 토큰 절약)
        const recentEnc = pm.encounters.slice(-5);
        if (recentEnc.length > 0) {
          lines.push('과거 만남:');
          for (const enc of recentEnc) {
            const locName = LOCATION_NAMES[enc.locationId] ?? enc.locationId;
            const outcomeKr =
              enc.outcome === 'SUCCESS'
                ? '성공'
                : enc.outcome === 'PARTIAL'
                  ? '부분성공'
                  : '실패';
            lines.push(
              `- T${enc.turnNo} ${locName}: ${enc.playerAction} -> ${outcomeKr} "${enc.briefNote}"`,
            );
          }
        }

        // 알려진 사실
        if (pm.knownFacts.length > 0) {
          lines.push(`알려진 사실: ${pm.knownFacts.join('; ')}`);
        }

        blocks.push(lines.join('\n'));
      } else {
        // personalMemory 없음 — 기본 정보만
        const relSummary = generateRelationSummary(
          posture,
          npc.emotional.trust,
        );
        blocks.push(
          `[NPC: ${displayName}]\n관계: ${relSummary} (trust: ${npc.emotional.trust})`,
        );
      }
    }

    return blocks.length > 0 ? blocks.join('\n\n') : null;
  }

  /** P5: FREE 턴에서 미발견 단서가 있음을 암시하는 힌트 */
  private buildQuestFactHint(
    serverResult: Record<string, unknown> | null,
    runState: Record<string, unknown> | null | undefined,
  ): string | null {
    if (!serverResult || !runState) return null;
    // FREE 이벤트인 경우에만 (이벤트가 매칭된 턴은 이미 fact 경로가 작동)
    const eventId = (serverResult as any)?.ui?.eventId as string | undefined;
    if (!eventId || !eventId.startsWith('FREE_')) return null;

    const locationId = (runState as any)?.worldState?.currentLocationId;
    if (!locationId) return null;

    const discovered = new Set((runState as any)?.discoveredQuestFacts ?? []);
    const allEvents = this.content.getAllEventsV2?.() ?? [];
    const undiscoveredFacts = allEvents
      .filter(
        (e: any) =>
          e.locationId === locationId &&
          e.discoverableFact &&
          !discovered.has(e.discoverableFact),
      )
      .map((e: any) => e.discoverableFact);

    if (undiscoveredFacts.length === 0) return null;

    return '이 장소에는 아직 발견하지 못한 단서가 숨어 있다. 주의 깊게 살펴보거나, 이곳 사람들에게 이야기를 건네면 무언가를 알아낼 수 있을 것 같은 기운이 감돈다.';
  }

  /**
   * Quest nextHint: fact 발견 다음 턴에 방향 힌트를 LLM 프롬프트에 전달.
   * pendingQuestHint.setAtTurn < 현재 turnNo 일 때만 포함 (발견 턴이 아닌 다음 턴).
   */
  private buildQuestDirectionHint(
    serverResult: Record<string, unknown> | null,
    runState: Record<string, unknown> | null | undefined,
  ): { hint: string; mode: string } | null {
    if (!serverResult || !runState) return null;

    const pending = (runState as any)?.pendingQuestHint as
      | { hint: string; setAtTurn: number; mode?: string }
      | null
      | undefined;
    if (!pending?.hint) return null;

    const currentTurnNo = (serverResult as any)?.turnNo as number | undefined;
    if (currentTurnNo == null) return null;

    // 발견 턴(setAtTurn)이 아닌 다음 턴에서만 전달
    if (pending.setAtTurn >= currentTurnNo) return null;

    // sanitizeNpcNames 적용 (미소개 NPC 실명 제거)
    const sanitizedHint = this.sanitizeNpcNames(pending.hint, runState);
    return { hint: sanitizedHint, mode: pending.mode ?? 'OVERHEARD' };
  }
}
