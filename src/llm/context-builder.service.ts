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
import type { ServerResultV1, NPCState, Relationship, PlayerBehaviorProfile, IncidentRuntime, SignalFeedItem, NarrativeMark } from '../db/types/index.js';
import type { NpcEmotionalState } from '../db/types/npc-state.js';
import { summarizeRelationship, computeEffectivePosture, getNpcDisplayName } from '../db/types/npc-state.js';
import { ContentLoaderService } from '../content/content-loader.service.js';
import type { StructuredMemory } from '../db/types/structured-memory.js';
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
  npcInjection: { npcId?: string; npcName: string; introduced?: boolean; posture: string; dialogueSeed: string; reason: string } | null;
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
  npcEmotionalContext: string | null; // NPC 감정 상태 요약
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

  async build(
    runId: string,
    nodeInstanceId: string,
    serverResult: ServerResultV1,
    runState?: Record<string, unknown> | null,
    gender?: 'male' | 'female',
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
          resolveOutcome: (sr?.ui as Record<string, unknown>)?.resolveOutcome as string | undefined,
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
    const allLocationTurnRows = [...parentLocationTurnRows, ...locationTurnRows];

    const locationSessionTurns: RecentTurnEntry[] = allLocationTurnRows.map((t) => {
      const sr = t.serverResult as ServerResultV1 | null;
      return {
        turnNo: t.turnNo,
        inputType: t.inputType,
        rawInput: t.rawInput,
        resolveOutcome: (sr?.ui as Record<string, unknown>)?.resolveOutcome as string | undefined,
        narrative: t.llmOutput ?? sr?.summary?.short ?? '',
      };
    });

    // HUB 확장: WorldState, Location, Agenda/Arc 컨텍스트 구축
    let worldSnapshot: string | null = null;
    let locationContext: string | null = null;
    let agendaArc: string | null = null;

    if (runState) {
      const ws = runState.worldState as Record<string, unknown> | undefined;
      if (ws) {
        worldSnapshot = `시간: ${ws.timePhase === 'NIGHT' ? '밤' : '낮'}, 경계도: ${ws.hubHeat}/100 (${ws.hubSafety}), 긴장도: ${ws.tension ?? 0}/10`;
        if (ws.currentLocationId) {
          locationContext = `현재 위치: ${ws.currentLocationId}`;
        }
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
          if (route) parts.push(`아크 경로: ${route} (참여도: ${commitment ?? 0}/3)`);
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
      const npcStates = runState.npcStates as Record<string, NPCState> | undefined;
      const relationships = runState.relationships as Record<string, Relationship> | undefined;
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
    const npcInjection = uiAny?.npcInjection as LlmContext['npcInjection'] ?? null;
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
    let narrativeMarkContext: string | null = null;
    let signalContext: string | null = null;

    if (runState) {
      const ws = runState.worldState as Record<string, unknown> | undefined;

      // Incident 요약
      const activeIncidents = (ws?.activeIncidents ?? []) as IncidentRuntime[];
      if (activeIncidents.length > 0) {
        const lines = activeIncidents.map((inc) => {
          const tension = inc.pressure >= 70 ? '위기' : inc.pressure >= 40 ? '긴장' : '잠재';
          return `- ${inc.incidentId} (${inc.kind}): 통제 ${inc.control}/100, 압력 ${inc.pressure}/100 [${tension}], 단계 ${inc.stage}`;
        });
        incidentContext = `활성 사건 ${activeIncidents.length}건:\n${lines.join('\n')}`;
      }

      // NPC 감정 상태 요약 (displayName 사용)
      const npcStates = runState.npcStates as Record<string, NPCState> | undefined;
      if (npcStates) {
        const emotionalLines: string[] = [];
        for (const [npcId, npc] of Object.entries(npcStates)) {
          const em = npc.emotional as NpcEmotionalState | undefined;
          if (em) {
            const npcDef = this.content.getNpc(npcId);
            const displayName = getNpcDisplayName(npc, npcDef);
            const posture = computeEffectivePosture(npc);
            emotionalLines.push(`- ${displayName}: ${posture} (신뢰${em.trust} 공포${em.fear} 존경${em.respect} 의심${em.suspicion} 유대${em.attachment})`);
          }
        }
        if (emotionalLines.length > 0) {
          npcEmotionalContext = `NPC 감정:\n${emotionalLines.join('\n')}`;
        }
      }

      // Narrative Mark 요약
      const marks = (ws?.narrativeMarks ?? []) as NarrativeMark[];
      if (marks.length > 0) {
        const markLines = marks.map((m) => `- [${m.type}] ${m.context} (${m.npcId ?? '전체'})`);
        narrativeMarkContext = `서사 표식 ${marks.length}개:\n${markLines.join('\n')}`;
      }

      // Signal Feed 요약 (severity 3 이상만)
      const signals = (ws?.signalFeed ?? []) as SignalFeedItem[];
      const importantSignals = signals.filter((s) => s.severity >= 3);
      if (importantSignals.length > 0) {
        const sigLines = importantSignals.slice(0, 5).map((s) => `- [${s.channel}/${s.severity}] ${s.text}`);
        signalContext = `주요 시그널:\n${sigLines.join('\n')}`;
      }
    }

    // NPC 소개 시스템: 소개 상태 수집
    const introducedNpcIds: string[] = [];
    if (runState) {
      const allNpcStates = runState.npcStates as Record<string, NPCState> | undefined;
      if (allNpcStates) {
        for (const [npcId, npc] of Object.entries(allNpcStates)) {
          if (npc.introduced) introducedNpcIds.push(npcId);
        }
      }
    }
    const newlyIntroducedNpcIds = (uiAny?.newlyIntroducedNpcIds as string[]) ?? [];
    const newlyEncounteredNpcIds = (uiAny?.newlyEncounteredNpcIds as string[]) ?? [];

    // Structured Memory v2: 렌더링
    let structuredSummary: string | null = null;
    let npcJournalText: string | null = null;
    let incidentChronicleText: string | null = null;
    let milestonesText: string | null = null;
    let llmFactsText: string | null = null;

    const structured = memory?.structuredMemory as StructuredMemory | null | undefined;
    if (structured) {
      structuredSummary = this.memoryRenderer.renderVisitLog(structured.visitLog, 5) || null;
      // 현재 장소의 관련 NPC 우선 표시
      const currentLocationId = (runState?.worldState as Record<string, unknown> | undefined)?.currentLocationId as string | undefined;
      const activeNpcIds = structured.npcJournal
        .filter((e) => e.interactions.some((i) => i.locationId === currentLocationId))
        .map((e) => e.npcId);
      npcJournalText = this.memoryRenderer.renderNpcJournal(structured.npcJournal, activeNpcIds) || null;
      incidentChronicleText = this.memoryRenderer.renderIncidentChronicle(structured.incidentChronicle) || null;
      milestonesText = this.memoryRenderer.renderMilestones(structured.milestones, 5) || null;
      // LLM facts 필터링: 현재 장소 + 현재 NPC
      const encounterNpcIds = structured.npcJournal.map((e) => e.npcId);
      llmFactsText = this.memoryRenderer.renderLlmFacts(structured.llmExtracted, currentLocationId ?? undefined, encounterNpcIds) || null;
    }

    // 장면 연속성: 현재 장면 상태 구축
    let currentSceneContext: string | null = null;
    if (locationSessionTurns.length > 0) {
      const sceneParts: string[] = [];

      // 1. 대화 상대 추출: actionContext에서 primaryNpcId 확인
      const uiData = serverResult.ui as Record<string, unknown>;
      const actionCtx = uiData?.actionContext as Record<string, unknown> | undefined;
      const primaryNpcId = actionCtx?.primaryNpcId as string | null | undefined;
      if (primaryNpcId) {
        const npcStates = runState?.npcStates as Record<string, NPCState> | undefined;
        const npc = npcStates?.[primaryNpcId];
        if (npc) {
          const npcDef = this.content.getNpc(primaryNpcId);
          const displayName = getNpcDisplayName(npc, npcDef);
          const posture = computeEffectivePosture(npc);
          sceneParts.push(`대화/상호작용 상대: ${displayName} (${posture})`);
        }
      } else {
        // 직전 턴들에서 NPC 추적 (최근 3턴 내 actionContext에서 primaryNpcId 검색)
        const recentLocationTurns = allLocationTurnRows.slice(-3);
        for (const t of recentLocationTurns.reverse()) {
          const sr = t.serverResult as ServerResultV1 | null;
          const prevActionCtx = (sr?.ui as Record<string, unknown>)?.actionContext as Record<string, unknown> | undefined;
          const prevNpcId = prevActionCtx?.primaryNpcId as string | null | undefined;
          if (prevNpcId) {
            const npcStates = runState?.npcStates as Record<string, NPCState> | undefined;
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
      const ongoingNarrativeTurns = locationSessionTurns.filter(t => t.narrative && t.narrative.length > 0);
      if (ongoingNarrativeTurns.length >= 2) {
        // 2턴 이상 진행: sceneFrame 완전 무시, 직전 내러티브의 마지막 150자로 장면 파악
        const lastNarrative = ongoingNarrativeTurns[ongoingNarrativeTurns.length - 1].narrative;
        if (lastNarrative) {
          const tail = lastNarrative.length > 150 ? lastNarrative.slice(-150) : lastNarrative;
          sceneParts.push(`직전 장면(이어쓸 지점): ...${tail}`);
        }
      } else {
        // 첫/두번째 턴: sceneFrame 활용
        const sceneFrame = actionCtx?.eventSceneFrame as string | undefined;
        if (sceneFrame) {
          sceneParts.push(`장면 배경: ${sceneFrame}`);
        } else {
          const lastTurn = allLocationTurnRows[allLocationTurnRows.length - 1];
          if (lastTurn) {
            const sr = lastTurn.serverResult as ServerResultV1 | null;
            const prevSceneFrame = ((sr?.ui as Record<string, unknown>)?.actionContext as Record<string, unknown>)?.eventSceneFrame as string | undefined;
            if (prevSceneFrame) {
              sceneParts.push(`장면 배경: ${prevSceneFrame}`);
            }
          }
        }
      }

      // 3. 현재 위치 (locationId → 한국어)
      const ws = runState?.worldState as Record<string, unknown> | undefined;
      const currentLocationId = ws?.currentLocationId as string | undefined;
      if (currentLocationId) {
        const locNames: Record<string, string> = {
          LOC_MARKET: '시장 거리', LOC_GUARD: '경비대 지구',
          LOC_HARBOR: '항만 부두', LOC_SLUMS: '빈민가',
        };
        sceneParts.push(`현재 위치: ${locNames[currentLocationId] ?? currentLocationId}`);
      }

      // 4. 이번 방문 턴 수
      sceneParts.push(`이번 방문 ${locationSessionTurns.length}턴째`);

      // 5. 직전 행동 요약
      const lastSessionTurn = locationSessionTurns[locationSessionTurns.length - 1];
      if (lastSessionTurn) {
        const outcomeText = lastSessionTurn.resolveOutcome === 'SUCCESS' ? '성공'
          : lastSessionTurn.resolveOutcome === 'PARTIAL' ? '부분 성공'
          : lastSessionTurn.resolveOutcome === 'FAIL' ? '실패' : '';
        const outcomePart = outcomeText ? ` → ${outcomeText}` : '';
        sceneParts.push(`직전 행동: "${lastSessionTurn.rawInput}"${outcomePart}`);
      }

      if (sceneParts.length > 0) {
        currentSceneContext = sceneParts.join('\n');
      }
    }

    // PR2: Mid Summary — locationSessionTurns > 6 → 초기 턴 압축
    let midSummary: string | null = null;
    let finalLocationSessionTurns = locationSessionTurns;
    if (locationSessionTurns.length > 6) {
      const earlyTurns = locationSessionTurns.slice(0, -6);
      midSummary = this.midSummaryService.generate(earlyTurns, runState);
      finalLocationSessionTurns = locationSessionTurns.slice(-6);
    }

    // PR3: Intent Memory — actionHistory에서 패턴 감지
    let intentMemory: string | null = null;
    if (runState) {
      const actionHistory = (runState.actionHistory as Array<{ actionType: string }>) ?? [];
      const patterns = this.intentMemoryService.analyze(actionHistory);
      if (patterns) {
        intentMemory = this.intentMemoryService.renderForContext(patterns);
      }
    }

    // PR4: Active Clues — StructuredMemory에서 유효 단서 추출
    let activeClues: string | null = null;
    if (structured) {
      activeClues = this.memoryRenderer.renderActiveClues(structured, runState?.worldState as Record<string, unknown> | undefined) || null;
    }

    return {
      theme: memory?.theme ?? [],
      storySummary: memory?.storySummary ?? null,
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
      npcInjection,
      peakMode,
      npcPostures,
      equipmentTags,
      activeSetNames,
      gender: gender ?? 'male',
      narrativeThread,
      incidentContext,
      npcEmotionalContext,
      narrativeMarkContext,
      signalContext,
      // NPC 소개 시스템
      introducedNpcIds,
      newlyIntroducedNpcIds,
      newlyEncounteredNpcIds,
      // Structured Memory v2
      structuredSummary,
      npcJournalText,
      incidentChronicleText,
      milestonesText,
      llmFactsText,
      // 장면 연속성
      currentSceneContext,
      // PR2/3/4: 신규 컨텍스트
      midSummary,
      intentMemory,
      activeClues,
    };
  }
}
