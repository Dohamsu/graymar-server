// 정본: specs/llm_context_system_v1.md — L0~L4 5계층 인터페이스

import { Inject, Injectable } from '@nestjs/common';
import { and, asc, desc, eq, ne } from 'drizzle-orm';
import { DB, type DrizzleDB } from '../db/drizzle.module.js';
import {
  runMemories,
  nodeMemories,
  recentSummaries,
  turns,
} from '../db/schema/index.js';
import type { ServerResultV1, NPCState, Relationship, PlayerBehaviorProfile } from '../db/types/index.js';
import { summarizeRelationship, computeEffectivePosture } from '../db/types/npc-state.js';

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
  npcInjection: { npcName: string; posture: string; dialogueSeed: string; reason: string } | null;
  peakMode: boolean;
  npcPostures: Record<string, string>; // npcId → effective posture
  // Phase 4: Equipment Narrative Tags
  equipmentTags: string[]; // 장비 서술 태그 (최대 6개, LLM 톤 영향)
  activeSetNames: string[]; // 활성 세트 이름 목록
}

@Injectable()
export class ContextBuilderService {
  constructor(@Inject(DB) private readonly db: DrizzleDB) {}

  async build(
    runId: string,
    nodeInstanceId: string,
    serverResult: ServerResultV1,
    runState?: Record<string, unknown> | null,
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

    const locationSessionTurns: RecentTurnEntry[] = locationTurnRows.map((t) => {
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
            const posture = computeEffectivePosture(npc);
            const summary = summarizeRelationship(npcId, rel);
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

    return {
      theme: memory?.theme ?? [],
      storySummary: memory?.storySummary ?? null,
      nodeFacts: nodeMem?.nodeFacts ?? [],
      recentSummaries: recents.map((r) => r.summary),
      recentTurns,
      locationSessionTurns,
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
    };
  }
}
