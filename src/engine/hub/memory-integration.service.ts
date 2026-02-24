// 방문 종료 시 visitContext → StructuredMemory 통합 + 압축

import { Inject, Injectable, Logger } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { DB, type DrizzleDB } from '../../db/drizzle.module.js';
import { runMemories, nodeMemories } from '../../db/schema/index.js';
import type { RunState, WorldState } from '../../db/types/index.js';
import type { NPCState, NpcPosture } from '../../db/types/npc-state.js';
import { computeEffectivePosture } from '../../db/types/npc-state.js';
import type { IncidentKind } from '../../db/types/incident.js';
import type {
  StructuredMemory,
  VisitContextCache,
  VisitLogEntry,
  NpcJournalEntry,
  NpcInteraction,
  IncidentChronicleEntry,
  IncidentInvolvement,
  MilestoneEntry,
  WorldMemorySnapshot,
  LlmExtractedFact,
  LlmFactCategory,
} from '../../db/types/structured-memory.js';
import { createEmptyStructuredMemory } from '../../db/types/structured-memory.js';
import { ContentLoaderService } from '../../content/content-loader.service.js';

const LOCATION_NAMES: Record<string, string> = {
  LOC_MARKET: '시장 거리',
  LOC_GUARD: '경비대 지구',
  LOC_HARBOR: '항만 부두',
  LOC_SLUMS: '빈민가',
};

const FACTION_NAMES: Record<string, string> = {
  CITY_GUARD: '경비대',
  MERCHANT_CONSORTIUM: '상인 길드',
  LABOR_GUILD: '노동 길드',
};

const MAX_VISIT_LOG = 15;
const MAX_NPC_INTERACTIONS = 5;
const MAX_INCIDENT_INVOLVEMENTS = 5;
const MAX_MILESTONES = 20;
const MAX_LLM_FACTS = 15;
const MAX_JSON_SIZE = 10 * 1024; // 10KB

@Injectable()
export class MemoryIntegrationService {
  private readonly logger = new Logger(MemoryIntegrationService.name);

  constructor(
    @Inject(DB) private readonly db: DrizzleDB,
    private readonly content: ContentLoaderService,
  ) {}

  async finalizeVisit(
    runId: string,
    nodeInstanceId: string,
    runState: RunState,
    turnNo: number,
  ): Promise<void> {
    // 1. visitContext 로드
    const nodeMemory = await this.db.query.nodeMemories.findFirst({
      where: eq(nodeMemories.nodeInstanceId, nodeInstanceId),
    });
    const ctx = nodeMemory?.visitContext as VisitContextCache | null;
    if (!ctx || ctx.actions.length === 0) {
      // visitContext 없으면 기존 saveLocationVisitSummary 와 동일하게 처리
      return;
    }

    // 2. 기존 structuredMemory 로드 (없으면 생성)
    const memRow = await this.db.query.runMemories.findFirst({
      where: eq(runMemories.runId, runId),
    });
    if (!memRow) {
      this.logger.warn(`run_memories not found for run ${runId} — skip structured memory update`);
      return;
    }

    let memory: StructuredMemory =
      (memRow.structuredMemory as StructuredMemory | null) ??
      createEmptyStructuredMemory();

    const ws = runState.worldState!;
    const locationId = ctx.locationId;
    const locName = LOCATION_NAMES[locationId] ?? locationId;

    // 3. Milestone 체크 — visitLog push 전에 해야 FIRST_VISIT 감지 가능
    const newMilestones = this.checkMilestones(ctx, ws, runState, memory, locationId, turnNo);
    memory.milestones.push(...newMilestones);
    if (memory.milestones.length > MAX_MILESTONES) {
      memory.milestones = this.pruneMilestones(memory.milestones, MAX_MILESTONES);
    }

    // 4. VisitLogEntry 생성
    const visitEntry = this.buildVisitLogEntry(ctx, ws, locName, turnNo);
    memory.visitLog.push(visitEntry);
    if (memory.visitLog.length > MAX_VISIT_LOG) {
      memory.visitLog = this.pruneVisitLog(memory.visitLog, MAX_VISIT_LOG);
    }

    // 5. NpcJournal 업데이트 — ctx.npcsEncountered + runState에서 변동 있는 NPC도 추가
    const npcIdsToProcess = new Set(ctx.npcsEncountered);
    // runState.npcStates에서 trust/emotional이 초기값과 다른 NPC도 자동 추가
    for (const [npcId, npc] of Object.entries((runState.npcStates ?? {}) as Record<string, NPCState>)) {
      if (npc.emotional && (
        npc.emotional.trust !== (npc as any).initialTrust &&
        Math.abs(npc.emotional.trust) >= 5
      )) {
        npcIdsToProcess.add(npcId);
      }
    }
    for (const npcId of npcIdsToProcess) {
      memory.npcJournal = this.updateNpcJournal(
        memory.npcJournal,
        npcId,
        ctx,
        runState,
        ws,
        locationId,
        turnNo,
      );
    }

    // 6. IncidentChronicle 업데이트
    for (const inv of ctx.incidentInvolvements) {
      memory.incidentChronicle = this.updateIncidentChronicle(
        memory.incidentChronicle,
        inv,
        ctx,
        ws,
        locationId,
        turnNo,
      );
    }

    // 7. 서버사이드 사실 자동 추출 (이벤트 장면, 장소 특성)
    const autoFacts = this.extractFactsFromVisit(ctx, locationId, turnNo);
    for (const fact of autoFacts) {
      // 중복 방지: 같은 카테고리+텍스트가 이미 있으면 스킵
      const duplicate = memory.llmExtracted.some(
        (f) => f.category === fact.category && f.text === fact.text,
      );
      if (!duplicate) {
        memory.llmExtracted.push(fact);
      }
    }
    if (memory.llmExtracted.length > MAX_LLM_FACTS) {
      memory.llmExtracted.sort((a, b) => b.importance - a.importance || b.turnNo - a.turnNo);
      memory.llmExtracted = memory.llmExtracted.slice(0, MAX_LLM_FACTS);
    }

    // 8. WorldSnapshot 갱신
    memory.worldSnapshot = this.buildWorldSnapshot(ws, runState, turnNo);

    // 9. compactMemory (예산 체크)
    memory = this.compactMemory(memory);

    // 9. DB 저장 — structuredMemory + storySummary (호환성)
    const storySummaryLine = `[${locName} 방문] ${visitEntry.summaryText}`;
    let newStorySummary = memRow.storySummary ?? '';
    newStorySummary = newStorySummary
      ? `${newStorySummary}\n${storySummaryLine}`
      : storySummaryLine;
    if (newStorySummary.length > 3000) {
      newStorySummary = '...' + newStorySummary.slice(newStorySummary.length - 2997);
    }

    await this.db
      .update(runMemories)
      .set({
        structuredMemory: memory,
        storySummary: newStorySummary,
        updatedAt: new Date(),
      })
      .where(eq(runMemories.runId, runId));
  }

  // ── VisitLogEntry 생성 ──

  private buildVisitLogEntry(
    ctx: VisitContextCache,
    ws: WorldState,
    locName: string,
    endTurnNo: number,
  ): VisitLogEntry {
    const importance = this.calcVisitImportance(ctx);

    // 요약 생성 (150자 이내)
    const actionBriefs = ctx.actions
      .slice(0, 3)
      .map((a) => {
        const outcomeStr =
          a.outcome === 'SUCCESS' ? '성공' : a.outcome === 'PARTIAL' ? '부분성공' : '실패';
        return `${this.actionTypeKorean(a.actionType)}(${outcomeStr})`;
      })
      .join(', ');
    const npcPart =
      ctx.npcsEncountered.length > 0
        ? `. ${ctx.npcsEncountered.map((id) => this.npcName(id)).join(', ')} 만남`
        : '';
    const summaryText = `${actionBriefs}${npcPart}`.slice(0, 150);

    return {
      locationId: ctx.locationId,
      locationName: locName,
      day: ws.day ?? 1,
      phase: ws.phaseV2 ?? 'DAY',
      turnRange: [ctx.startTurnNo, endTurnNo],
      actions: ctx.actions.slice(0, 5),
      npcsEncountered: ctx.npcsEncountered,
      outcomes: { ...ctx.outcomes },
      reputationChanges: { ...ctx.reputationChanges },
      goldDelta: ctx.goldDelta,
      summaryText,
      importance,
    };
  }

  private calcVisitImportance(ctx: VisitContextCache): number {
    let imp = 0.3; // 기본
    if (ctx.incidentInvolvements.length > 0) imp += 0.2;
    if (ctx.marksAcquired.length > 0) imp += 0.4;
    // 전투 발생 여부는 visitContext에서 직접 판단 어려움 → 기본 유지
    return Math.min(1.0, imp);
  }

  private pruneVisitLog(log: VisitLogEntry[], max: number): VisitLogEntry[] {
    // importance 낮은 것부터 삭제 (최소 8개 보존)
    if (log.length <= max) return log;
    const sorted = [...log].sort((a, b) => a.importance - b.importance);
    const toRemove = log.length - max;
    const removeSet = new Set(sorted.slice(0, toRemove).map((e) => e.turnRange[0]));
    const result = log.filter((e) => !removeSet.has(e.turnRange[0]));
    return result.length >= 8 ? result : log.slice(-max);
  }

  // ── NpcJournal 업데이트 ──

  private updateNpcJournal(
    journal: NpcJournalEntry[],
    npcId: string,
    ctx: VisitContextCache,
    runState: RunState,
    ws: WorldState,
    locationId: string,
    turnNo: number,
  ): NpcJournalEntry[] {
    let entry = journal.find((e) => e.npcId === npcId);
    const npcDef = this.content.getNpc(npcId);
    const npcName = npcDef?.name ?? npcId;

    if (!entry) {
      entry = {
        npcId,
        npcName,
        interactions: [],
        latestEmotional: { trust: 0, fear: 0, respect: 0, suspicion: 0, attachment: 0, posture: 'CAUTIOUS' as NpcPosture },
        marks: [],
        summaryText: '',
      };
      journal.push(entry);
    }

    // 이번 방문에서 관련 행동 추출 — NPC와 같은 방문의 행동 중 이벤트가 있는 것 우선
    const npcActions = ctx.actions.filter((a) => a.eventId);
    // 이벤트가 없으면 전체 행동에서 추출
    const relevantActions = npcActions.length > 0 ? npcActions : ctx.actions;
    for (const action of relevantActions.slice(0, 2)) {
      const interaction: NpcInteraction = {
        turnNo,
        locationId,
        actionType: action.actionType,
        outcome: action.outcome,
        emotionalDelta: ctx.npcEmotionalDeltas[npcId] ?? {},
        snippet: action.brief.slice(0, 50),
      };
      entry.interactions.push(interaction);
      if (entry.interactions.length > MAX_NPC_INTERACTIONS) {
        entry.interactions = entry.interactions.slice(-MAX_NPC_INTERACTIONS);
      }
    }

    // latestEmotional 갱신
    const npcState = (runState.npcStates ?? {})[npcId] as NPCState | undefined;
    if (npcState) {
      entry.latestEmotional = {
        ...npcState.emotional,
        posture: computeEffectivePosture(npcState),
      };
    }

    // 마크 업데이트
    const npcMarks = (ws.narrativeMarks ?? [])
      .filter((m) => m.npcId === npcId)
      .map((m) => m.type);
    for (const mark of npcMarks) {
      if (!entry.marks.includes(mark)) {
        entry.marks.push(mark);
      }
    }

    // summaryText 재생성
    entry.summaryText = this.generateNpcSummary(entry);

    return journal;
  }

  private generateNpcSummary(entry: NpcJournalEntry): string {
    const emo = entry.latestEmotional;
    const parts: string[] = [];
    // 낮은 임계값으로 감정 상태를 더 세밀히 표현
    if (emo.trust > 15) parts.push(`신뢰${emo.trust}`);
    else if (emo.trust < -15) parts.push(`적대${emo.trust}`);
    else if (emo.trust !== 0) parts.push(`중립(${emo.trust})`);
    if (emo.fear > 20) parts.push(`공포${emo.fear}`);
    if (emo.suspicion > 20) parts.push(`의심${emo.suspicion}`);
    if (emo.respect > 15) parts.push(`존경${emo.respect}`);
    if (emo.attachment > 15) parts.push(`애착${emo.attachment}`);

    const lastInt = entry.interactions[entry.interactions.length - 1];
    const lastAction = lastInt
      ? `최근 ${this.actionTypeKorean(lastInt.actionType)}(${lastInt.outcome === 'SUCCESS' ? '성공' : lastInt.outcome === 'PARTIAL' ? '부분성공' : '실패'})`
      : '';

    const emotionStr = parts.length > 0 ? parts.join('/') : '초기';
    return `${entry.npcName}: ${emotionStr} 태도${emo.posture}. ${lastAction}`.slice(0, 100);
  }

  // ── IncidentChronicle 업데이트 ──

  private updateIncidentChronicle(
    chronicle: IncidentChronicleEntry[],
    inv: { incidentId: string; controlDelta: number; pressureDelta: number },
    ctx: VisitContextCache,
    ws: WorldState,
    locationId: string,
    turnNo: number,
  ): IncidentChronicleEntry[] {
    let entry = chronicle.find((e) => e.incidentId === inv.incidentId);

    if (!entry) {
      const runtime = (ws.activeIncidents ?? []).find(
        (i) => i.incidentId === inv.incidentId,
      );
      const def = this.content.getIncident(inv.incidentId);
      entry = {
        incidentId: inv.incidentId,
        kind: (runtime?.kind ?? def?.kind ?? 'CRIMINAL') as IncidentKind,
        title: def?.title ?? inv.incidentId,
        resolved: runtime?.resolved ?? false,
        playerInvolvements: [],
      };
      chronicle.push(entry);
    }

    // 관여 기록 추가
    const relevantAction = ctx.actions[ctx.actions.length - 1];
    const involvement: IncidentInvolvement = {
      turnNo,
      locationId,
      actionType: relevantAction?.actionType ?? 'OBSERVE',
      outcome: relevantAction?.outcome ?? 'PARTIAL',
      controlDelta: inv.controlDelta,
      pressureDelta: inv.pressureDelta,
      snippet: (relevantAction?.brief ?? '').slice(0, 50),
    };
    entry!.playerInvolvements.push(involvement);
    if (entry!.playerInvolvements.length > MAX_INCIDENT_INVOLVEMENTS) {
      entry!.playerInvolvements = entry!.playerInvolvements.slice(-MAX_INCIDENT_INVOLVEMENTS);
    }

    // 해결 상태 업데이트
    const runtimeInc = (ws.activeIncidents ?? []).find(
      (i) => i.incidentId === inv.incidentId,
    );
    if (runtimeInc?.resolved) {
      entry!.resolved = true;
      entry!.outcome = runtimeInc.outcome;
      entry!.finalControl = runtimeInc.control;
      entry!.finalPressure = runtimeInc.pressure;
    }

    return chronicle;
  }

  // ── Milestone 체크 ──

  private checkMilestones(
    ctx: VisitContextCache,
    ws: WorldState,
    runState: RunState,
    memory: StructuredMemory,
    locationId: string,
    turnNo: number,
  ): MilestoneEntry[] {
    const milestones: MilestoneEntry[] = [];
    const day = ws.day ?? 1;

    // FIRST_VISIT — visitLog에 push 전이므로 정확히 감지
    const visitedLocations = new Set(memory.visitLog.map((v) => v.locationId));
    if (!visitedLocations.has(locationId)) {
      const locName = LOCATION_NAMES[locationId] ?? locationId;
      milestones.push({
        type: 'FIRST_VISIT',
        turnNo,
        day,
        detail: `${locName} 첫 방문`,
        importance: 0.4,
      });
    }

    // MARK_ACQUIRED
    for (const markType of ctx.marksAcquired) {
      const mark = (ws.narrativeMarks ?? []).find((m) => m.type === markType);
      milestones.push({
        type: 'MARK_ACQUIRED',
        turnNo,
        day,
        detail: `★${markType} 표식 — ${mark?.context ?? markType}`.slice(0, 100),
        importance: 0.9,
        relatedNpcId: mark?.npcId,
        relatedIncidentId: mark?.incidentId,
      });
    }

    // ARC_COMMITTED (commitment가 3이 된 경우)
    const arcState = runState.arcState;
    if (arcState?.commitment === 3 && arcState.currentRoute) {
      const alreadyHas = memory.milestones.some(
        (m) => m.type === 'ARC_COMMITTED' && m.detail.includes(arcState.currentRoute!),
      );
      if (!alreadyHas) {
        milestones.push({
          type: 'ARC_COMMITTED',
          turnNo,
          day,
          detail: `${arcState.currentRoute} 루트 확정`,
          importance: 0.8,
        });
      }
    }

    // INCIDENT_RESOLVED
    for (const inv of ctx.incidentInvolvements) {
      const runtime = (ws.activeIncidents ?? []).find(
        (i) => i.incidentId === inv.incidentId && i.resolved,
      );
      if (runtime) {
        const def = this.content.getIncident(inv.incidentId);
        milestones.push({
          type: 'INCIDENT_RESOLVED',
          turnNo,
          day,
          detail: `${def?.title ?? inv.incidentId} ${runtime.outcome ?? 'RESOLVED'}`.slice(0, 100),
          importance: 0.7,
          relatedIncidentId: inv.incidentId,
        });
      }
    }

    // NPC_POSTURE_CHANGE (이전 기록과 비교)
    for (const npcId of ctx.npcsEncountered) {
      const prevEntry = memory.npcJournal.find((e) => e.npcId === npcId);
      if (!prevEntry) continue;
      const npcState = (runState.npcStates ?? {})[npcId] as NPCState | undefined;
      if (!npcState) continue;
      const newPosture = computeEffectivePosture(npcState);
      if (prevEntry.latestEmotional.posture !== newPosture) {
        milestones.push({
          type: 'NPC_POSTURE_CHANGE',
          turnNo,
          day,
          detail: `${prevEntry.npcName} 태도 변화: ${prevEntry.latestEmotional.posture}→${newPosture}`,
          importance: 0.6,
          relatedNpcId: npcId,
        });
      }
    }

    // REPUTATION_SHIFT — 세력 평판이 의미 있게 변동한 경우
    for (const [factionId, delta] of Object.entries(ctx.reputationChanges)) {
      if (Math.abs(delta) >= 3) {
        const factionName = FACTION_NAMES[factionId] ?? factionId;
        const alreadyHas = memory.milestones.some(
          (m) => m.type === 'REPUTATION_SHIFT' && m.detail.includes(factionName) && m.turnNo === turnNo,
        );
        if (!alreadyHas) {
          milestones.push({
            type: 'REPUTATION_SHIFT',
            turnNo,
            day,
            detail: `${factionName} 평판 ${delta > 0 ? '+' : ''}${delta} (총 ${ws.reputation?.[factionId] ?? 0})`,
            importance: 0.5,
          });
        }
      }
    }

    return milestones;
  }

  private pruneMilestones(milestones: MilestoneEntry[], max: number): MilestoneEntry[] {
    if (milestones.length <= max) return milestones;
    // MARK_ACQUIRED는 절대 보존
    const permanent = milestones.filter((m) => m.type === 'MARK_ACQUIRED');
    const rest = milestones.filter((m) => m.type !== 'MARK_ACQUIRED');
    // FIRST_VISIT 중 오래된 것 우선 삭제
    const firstVisits = rest.filter((m) => m.type === 'FIRST_VISIT');
    const others = rest.filter((m) => m.type !== 'FIRST_VISIT');

    const available = max - permanent.length;
    const keepOthers = others.slice(-Math.min(others.length, available));
    const keepFirstVisits = firstVisits.slice(-(available - keepOthers.length));

    return [...permanent, ...keepFirstVisits, ...keepOthers]
      .sort((a, b) => a.turnNo - b.turnNo);
  }

  // ── WorldSnapshot ──

  private buildWorldSnapshot(
    ws: WorldState,
    runState: RunState,
    turnNo: number,
  ): WorldMemorySnapshot {
    return {
      day: ws.day ?? 1,
      timePhase: ws.phaseV2 ?? 'DAY',
      hubHeat: ws.hubHeat,
      hubSafety: ws.hubSafety,
      reputation: { ...ws.reputation },
      activeIncidentCount: (ws.activeIncidents ?? []).filter((i) => !i.resolved).length,
      resolvedIncidentCount: (ws.activeIncidents ?? []).filter((i) => i.resolved).length,
      arcRoute: runState.arcState?.currentRoute ?? undefined,
      arcCommitment: runState.arcState?.commitment ?? 0,
      updatedAtTurnNo: turnNo,
    };
  }

  // ── 서버사이드 사실 자동 추출 ──

  private extractFactsFromVisit(
    ctx: VisitContextCache,
    locationId: string,
    turnNo: number,
  ): LlmExtractedFact[] {
    const facts: LlmExtractedFact[] = [];

    // 1. 이벤트 장면(sceneFrame)에서 장소 디테일 추출
    for (const action of ctx.actions) {
      if (action.brief && action.brief.length >= 15) {
        // 유의미한 장면 묘사만 추출 (짧은 것은 스킵)
        const briefText = action.brief.slice(0, 50);
        facts.push({
          turnNo,
          category: 'PLACE_DETAIL' as LlmFactCategory,
          text: briefText,
          relatedLocationId: locationId,
          importance: 0.6,
        });
      }
    }

    // 2. NPC 관련 장면 → NPC_DETAIL
    for (const npcId of ctx.npcsEncountered) {
      const npcDef = this.content.getNpc(npcId);
      if (npcDef) {
        const roleFact = `${npcDef.name}: ${npcDef.role}`.slice(0, 50);
        facts.push({
          turnNo,
          category: 'NPC_DETAIL' as LlmFactCategory,
          text: roleFact,
          relatedNpcId: npcId,
          importance: 0.7,
        });
      }
    }

    // 3. 사건 관여 → PLOT_HINT
    for (const inv of ctx.incidentInvolvements) {
      const def = this.content.getIncident(inv.incidentId);
      if (def) {
        const direction = inv.controlDelta > 0 ? '통제 강화' : inv.controlDelta < 0 ? '상황 악화' : '관찰';
        facts.push({
          turnNo,
          category: 'PLOT_HINT' as LlmFactCategory,
          text: `${def.title} — ${direction}`.slice(0, 50),
          importance: 0.8,
        });
      }
    }

    // 4. 특이한 판정 패턴 → ATMOSPHERE
    const totalOutcomes = ctx.outcomes.success + ctx.outcomes.partial + ctx.outcomes.fail;
    if (totalOutcomes >= 2) {
      if (ctx.outcomes.success >= 2 && ctx.outcomes.fail === 0) {
        const locName = LOCATION_NAMES[locationId] ?? locationId;
        facts.push({
          turnNo,
          category: 'ATMOSPHERE' as LlmFactCategory,
          text: `${locName}에서 연속 성공 — 자신감 상승`,
          relatedLocationId: locationId,
          importance: 0.5,
        });
      } else if (ctx.outcomes.fail >= 2) {
        const locName = LOCATION_NAMES[locationId] ?? locationId;
        facts.push({
          turnNo,
          category: 'ATMOSPHERE' as LlmFactCategory,
          text: `${locName}에서 연속 실패 — 위험 고조`,
          relatedLocationId: locationId,
          importance: 0.6,
        });
      }
    }

    // 중복 줄이기: 같은 카테고리+관련ID 조합은 importance 높은 1개만
    const seen = new Map<string, LlmExtractedFact>();
    for (const fact of facts) {
      const key = `${fact.category}:${fact.relatedNpcId ?? ''}:${fact.relatedLocationId ?? ''}`;
      const existing = seen.get(key);
      if (!existing || fact.importance > existing.importance) {
        seen.set(key, fact);
      }
    }
    return Array.from(seen.values());
  }

  // ── compactMemory ──

  compactMemory(memory: StructuredMemory): StructuredMemory {
    const size = JSON.stringify(memory).length;
    if (size <= MAX_JSON_SIZE) return memory;

    // 1단계: llmExtracted에서 importance < 0.6 제거
    memory.llmExtracted = memory.llmExtracted.filter((f) => f.importance >= 0.6);

    // 2단계: visitLog에서 importance < 0.3 제거 (최소 8개 보존)
    if (memory.visitLog.length > 8) {
      const kept = memory.visitLog.filter((v) => v.importance >= 0.3);
      memory.visitLog = kept.length >= 8 ? kept : memory.visitLog.slice(-8);
    }

    // 3단계: npcJournal에서 오래된 NPC의 interactions 축소
    for (const entry of memory.npcJournal) {
      if (entry.interactions.length > 2) {
        entry.interactions = entry.interactions.slice(-2);
      }
    }

    // 4단계: milestones 정리
    memory.milestones = this.pruneMilestones(memory.milestones, MAX_MILESTONES);

    // 5단계: incidentChronicle resolved 사건의 involvements 축소
    for (const entry of memory.incidentChronicle) {
      if (entry.resolved && entry.playerInvolvements.length > 2) {
        entry.playerInvolvements = entry.playerInvolvements.slice(-2);
      }
    }

    return memory;
  }

  // ── 유틸리티 ──

  private actionTypeKorean(actionType: string): string {
    const map: Record<string, string> = {
      INVESTIGATE: '조사', PERSUADE: '설득', SNEAK: '잠입', BRIBE: '뇌물',
      THREATEN: '위협', HELP: '도움', STEAL: '절도', FIGHT: '전투',
      OBSERVE: '관찰', TRADE: '거래', TALK: '대화', SEARCH: '수색',
      MOVE_LOCATION: '이동', REST: '휴식', SHOP: '상점',
    };
    return map[actionType] ?? actionType;
  }

  private npcName(npcId: string): string {
    const npc = this.content.getNpc(npcId);
    return npc?.name ?? npcId;
  }
}
