// Narrative Engine v1 — Ending Generator Service
// 정본: architecture/Narrative_Engine_v1_Integrated_Spec.md §8-9

import { Injectable } from '@nestjs/common';
import { ContentLoaderService } from '../../content/content-loader.service.js';
import type { IncidentRuntime } from '../../db/types/incident.js';
import type { NarrativeMark } from '../../db/types/narrative-mark.js';
import type { NPCState } from '../../db/types/npc-state.js';
import { computeEffectivePosture } from '../../db/types/npc-state.js';
import type {
  MainArcClock,
  EndingInput,
  EndingResult,
  NpcEpilogue,
  CityStatus,
} from '../../db/types/ending.js';

/** 한국어 조사 자동 판별 — 받침 유무에 따라 은/는, 이/가 등 선택 */
function korParticle(
  word: string,
  withBatchim: string,
  withoutBatchim: string,
): string {
  if (!word) return withBatchim;
  const last = word.charCodeAt(word.length - 1);
  if (last < 0xac00 || last > 0xd7a3) return withBatchim;
  return (last - 0xac00) % 28 !== 0 ? withBatchim : withoutBatchim;
}

@Injectable()
export class EndingGeneratorService {
  constructor(private readonly content: ContentLoaderService) {}

  /**
   * 엔딩 조건 확인 — 매 턴 후 호출
   */
  checkEndingConditions(
    activeIncidents: IncidentRuntime[],
    mainArcClock: MainArcClock,
    day: number,
    totalTurns?: number,
  ): { shouldEnd: boolean; reason: 'ALL_RESOLVED' | 'DEADLINE' | null } {
    const MIN_TURNS_FOR_NATURAL = 15;

    // 1. 모든 critical Incident가 해결(resolved)되었는지 확인
    const unresolved = activeIncidents.filter((inc) => !inc.resolved);
    if (activeIncidents.length > 0 && unresolved.length === 0) {
      // Fixplan3-P7: 최소 턴 수 미달 시 조기 엔딩 방지
      if (totalTurns !== undefined && totalTurns < MIN_TURNS_FOR_NATURAL) {
        return { shouldEnd: false, reason: null };
      }
      return { shouldEnd: true, reason: 'ALL_RESOLVED' };
    }

    // 2. Soft deadline 이후 모든 Incident 만료/해결
    if (mainArcClock.triggered && unresolved.length === 0) {
      return { shouldEnd: true, reason: 'DEADLINE' };
    }

    // 3. Soft deadline 도달 체크 (알림용)
    if (!mainArcClock.triggered && day >= mainArcClock.softDeadlineDay) {
      mainArcClock.triggered = true;
    }

    return { shouldEnd: false, reason: null };
  }

  /**
   * 엔딩 입력 데이터 수집
   */
  gatherEndingInputs(
    activeIncidents: IncidentRuntime[],
    npcStates: Record<string, NPCState>,
    narrativeMarks: NarrativeMark[],
    worldState: Record<string, unknown>,
    arcState: Record<string, unknown> | null,
    actionHistory?: Array<{ actionType: string; [k: string]: unknown }>,
    playerThreads?: Array<{
      approachVector: string;
      goalCategory: string;
      actionCount: number;
      successCount: number;
      status: string;
    }>,
  ): EndingInput {
    const incidentOutcomes = activeIncidents
      .filter((inc) => inc.resolved)
      .map((inc) => ({
        incidentId: inc.incidentId,
        outcome: inc.outcome!,
        title: inc.incidentId, // 런타임에서 title을 가져와야 하지만 fallback으로 id 사용
      }));

    const npcEpilogues = Object.entries(npcStates).map(([npcId, npc]) => {
      const em = npc.emotional ?? {};
      const npcDef = this.content.getNpc(npcId);
      return {
        npcId,
        npcName: npcDef?.name ?? npcId,
        trust: em.trust ?? 0,
        fear: em.fear ?? 0,
        respect: em.respect ?? 0,
        suspicion: em.suspicion ?? 0,
        attachment: em.attachment ?? 0,
        posture: computeEffectivePosture(npc),
      };
    });

    // User-Driven System v3: dominant vectors 계산
    const dominantVectors = this.computeDominantVectors(actionHistory);

    // User-Driven System v3: consequence footprint
    const consequenceFootprint =
      this.computeConsequenceFootprint(activeIncidents);

    // Living World v2: WorldFacts + PlayerGoals 추출
    const worldFacts = (
      (worldState.worldFacts as Array<{
        text: string;
        category: string;
        permanent: boolean;
      }>) ?? []
    )
      .filter((f) => f.permanent)
      .map((f) => f.text);
    const playerGoals = (
      (worldState.playerGoals as Array<{
        description: string;
        progress: number;
        completed: boolean;
      }>) ?? []
    ).map((g) => ({
      description: g.description,
      progress: g.progress,
      completed: g.completed,
    }));
    const locationChanges = Object.entries(
      (worldState.locationDynamicStates ?? {}) as Record<
        string,
        {
          locationId: string;
          security: number;
          unrest: number;
          activeConditions: Array<{ id: string }>;
        }
      >,
    )
      .filter(
        ([, s]) =>
          s.activeConditions?.length > 0 || s.security < 30 || s.unrest > 60,
      )
      .map(([locId, s]) => ({
        locationId: locId,
        security: s.security,
        unrest: s.unrest,
        conditions: s.activeConditions?.map((c) => c.id) ?? [],
      }));

    return {
      incidentOutcomes,
      npcEpilogues,
      narrativeMarks,
      globalHeat: (worldState.hubHeat as number) ?? 0,
      globalTension: (worldState.tension as number) ?? 0,
      daysSpent: (worldState.day as number) ?? 1,
      reputation: (worldState.reputation as Record<string, number>) ?? {},
      arcRoute: (arcState?.currentRoute as string) ?? null,
      arcCommitment: (arcState?.commitment as number) ?? 0,
      dominantVectors,
      playerThreads: playerThreads ?? [],
      consequenceFootprint,
      // Living World v2
      worldFacts,
      playerGoals,
      locationChanges,
    };
  }

  /**
   * 엔딩 결과 생성
   */
  generateEnding(
    input: EndingInput,
    endingReason: 'ALL_RESOLVED' | 'DEADLINE' | 'PLAYER_CHOICE' | 'DEFEAT',
    totalTurns: number,
  ): EndingResult {
    const endingsData = this.content.getEndingsData();

    // 1. City Status 계산
    const containedCount = input.incidentOutcomes.filter(
      (o) => o.outcome === 'CONTAINED',
    ).length;
    const escalatedCount = input.incidentOutcomes.filter(
      (o) => o.outcome === 'ESCALATED',
    ).length;
    const expiredCount = input.incidentOutcomes.filter(
      (o) => o.outcome === 'EXPIRED',
    ).length;

    let stability: CityStatus['stability'];
    if (escalatedCount >= 3) {
      stability = 'COLLAPSED';
    } else if (containedCount >= escalatedCount + expiredCount) {
      stability = 'STABLE';
    } else {
      stability = 'UNSTABLE';
    }

    const closingLines = endingsData?.closingLines as
      | Record<string, string>
      | undefined;
    const cityStatus: CityStatus = {
      stability,
      summary: closingLines?.[stability] ?? '도시는 계속되었다.',
    };

    // 2. NPC Epilogues 생성
    const epilogueTemplates = endingsData?.npcEpilogueTemplates as
      | Record<string, Record<string, string>>
      | undefined;

    const npcEpilogues: NpcEpilogue[] = input.npcEpilogues.map((npc) => {
      const templates = epilogueTemplates?.[npc.npcId];
      let epilogueText: string;

      if (templates) {
        if (npc.trust >= 30 && npc.posture === 'FRIENDLY') {
          epilogueText = templates.high_trust ?? templates.neutral ?? '';
        } else if (npc.trust <= -30 || npc.posture === 'HOSTILE') {
          epilogueText = templates.hostile ?? templates.neutral ?? '';
        } else {
          epilogueText = templates.neutral ?? '';
        }
      } else {
        epilogueText = `${npc.npcName}${korParticle(npc.npcName, '은', '는')} 자신의 삶을 이어갔다.`;
      }

      return {
        npcId: npc.npcId,
        npcName: npc.npcName,
        epilogueText,
        finalPosture: npc.posture,
      };
    });

    // 3. Ending Type
    const endingType =
      endingReason === 'PLAYER_CHOICE'
        ? ('PLAYER_CHOICE' as const)
        : endingReason === 'DEADLINE'
          ? ('DEADLINE' as const)
          : endingReason === 'DEFEAT'
            ? ('DEFEAT' as const)
            : ('NATURAL' as const);

    // User-Driven System v3: playstyle summary
    const playstyleSummary = this.buildPlaystyleSummary(input.dominantVectors);
    const threadSummary = this.buildThreadSummary(input.playerThreads);

    // closingLine 변형 (dominant vector 기반)
    const finalClosingLine =
      endingReason === 'DEFEAT'
        ? '시야가 어두워진다. 이름 없는 용병의 이야기는 여기서 끝났다.'
        : this.adjustClosingLine(cityStatus.summary, input.dominantVectors);

    return {
      endingType,
      npcEpilogues,
      cityStatus,
      narrativeMarks: input.narrativeMarks,
      closingLine: finalClosingLine,
      statistics: {
        daysSpent: input.daysSpent,
        incidentsContained: containedCount,
        incidentsEscalated: escalatedCount,
        incidentsExpired: expiredCount,
        totalTurns,
      },
      playstyleSummary,
      dominantVectors: input.dominantVectors,
      threadSummary,
    };
  }

  // --- User-Driven System v3 확장 헬퍼 ---

  private computeDominantVectors(
    actionHistory?: Array<{ actionType: string; [k: string]: unknown }>,
  ): string[] {
    if (!actionHistory || actionHistory.length === 0) return [];

    // actionType → approachVector 간이 매핑 (IntentV3Builder와 동일)
    const vectorMap: Record<string, string> = {
      TALK: 'SOCIAL',
      PERSUADE: 'SOCIAL',
      HELP: 'SOCIAL',
      SNEAK: 'STEALTH',
      STEAL: 'STEALTH',
      THREATEN: 'PRESSURE',
      BRIBE: 'ECONOMIC',
      TRADE: 'ECONOMIC',
      INVESTIGATE: 'OBSERVATIONAL',
      OBSERVE: 'OBSERVATIONAL',
      SEARCH: 'OBSERVATIONAL',
      FIGHT: 'VIOLENT',
    };

    const counts: Record<string, number> = {};
    for (const h of actionHistory) {
      const vector = vectorMap[h.actionType] ?? 'OBSERVATIONAL';
      counts[vector] = (counts[vector] ?? 0) + 1;
    }

    return Object.entries(counts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([v]) => v);
  }

  private computeConsequenceFootprint(incidents: IncidentRuntime[]): {
    totalSuspicion: number;
    totalPlayerProgress: number;
    totalRivalProgress: number;
  } {
    let totalSuspicion = 0;
    let totalPlayerProgress = 0;
    let totalRivalProgress = 0;

    for (const inc of incidents) {
      totalSuspicion += inc.suspicion ?? 0;
      totalPlayerProgress += inc.playerProgress ?? 0;
      totalRivalProgress += inc.rivalProgress ?? 0;
    }

    return { totalSuspicion, totalPlayerProgress, totalRivalProgress };
  }

  private buildPlaystyleSummary(
    dominantVectors?: string[],
  ): string | undefined {
    if (!dominantVectors || dominantVectors.length === 0) return undefined;

    const labels: Record<string, string> = {
      SOCIAL: '외교적인',
      STEALTH: '은밀한',
      PRESSURE: '강압적인',
      ECONOMIC: '상업적인',
      OBSERVATIONAL: '관찰력 있는',
      POLITICAL: '정치적인',
      VIOLENT: '거친',
      LOGISTICAL: '전략적인',
    };

    const adjectives = dominantVectors
      .slice(0, 2)
      .map((v) => labels[v] ?? v)
      .join('이며 ');

    return `${adjectives} 용병`;
  }

  private buildThreadSummary(
    threads?: Array<{
      approachVector: string;
      goalCategory: string;
      actionCount: number;
      successCount: number;
      status: string;
    }>,
  ): string | undefined {
    if (!threads || threads.length === 0) return undefined;

    const active = threads.filter(
      (t) => t.status === 'ACTIVE' || t.status === 'COMPLETED',
    );
    if (active.length === 0) return undefined;

    const sorted = [...active].sort((a, b) => b.actionCount - a.actionCount);
    const top = sorted[0];
    const rate =
      top.actionCount > 0
        ? Math.round((top.successCount / top.actionCount) * 100)
        : 0;

    return `주요 행동 패턴: ${top.approachVector} × ${top.goalCategory} (${top.actionCount}회, 성공률 ${rate}%)`;
  }

  private adjustClosingLine(
    baseLine: string,
    dominantVectors?: string[],
  ): string {
    if (!dominantVectors || dominantVectors.length === 0) return baseLine;

    const primary = dominantVectors[0];
    const suffixes: Record<string, string> = {
      VIOLENT: ' 피 냄새가 아직 골목에 배어 있었다.',
      STEALTH: ' 그림자 속에서 누군가 웃고 있었다.',
      SOCIAL: ' 사람들은 그의 이름을 기억했다.',
      ECONOMIC: ' 금화의 흔적이 그의 여정을 말해주었다.',
      PRESSURE: ' 두려움은 오래 남는 법이었다.',
    };

    const suffix = suffixes[primary];
    return suffix ? baseLine + suffix : baseLine;
  }

  /**
   * Soft deadline 시그널 체크 — WorldTick에서 호출
   * soft deadline까지 남은 일수가 2 이하면 severity-5 시그널 생성
   */
  checkSoftDeadline(
    mainArcClock: MainArcClock,
    day: number,
  ): { signal: boolean; daysLeft: number } {
    const daysLeft = mainArcClock.softDeadlineDay - day;
    if (daysLeft <= 2 && daysLeft >= 0) {
      return { signal: true, daysLeft };
    }
    return { signal: false, daysLeft };
  }
}
