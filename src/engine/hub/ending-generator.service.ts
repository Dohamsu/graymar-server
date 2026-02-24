// Narrative Engine v1 — Ending Generator Service
// 정본: architecture/Narrative_Engine_v1_Integrated_Spec.md §8-9

import { Injectable } from '@nestjs/common';
import { ContentLoaderService } from '../../content/content-loader.service.js';
import type { IncidentRuntime, IncidentOutcome } from '../../db/types/incident.js';
import type { NarrativeMark } from '../../db/types/narrative-mark.js';
import type { NPCState } from '../../db/types/npc-state.js';
import type { NpcEmotionalState } from '../../db/types/npc-state.js';
import { computeEffectivePosture } from '../../db/types/npc-state.js';
import type {
  MainArcClock,
  EndingInput,
  EndingResult,
  NpcEpilogue,
  CityStatus,
} from '../../db/types/ending.js';

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
  ): { shouldEnd: boolean; reason: 'ALL_RESOLVED' | 'DEADLINE' | null } {
    // 1. 모든 critical Incident가 해결(resolved)되었는지 확인
    const unresolved = activeIncidents.filter((inc) => !inc.resolved);
    if (activeIncidents.length > 0 && unresolved.length === 0) {
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
  ): EndingInput {
    const incidentOutcomes = activeIncidents
      .filter((inc) => inc.resolved)
      .map((inc) => ({
        incidentId: inc.incidentId,
        outcome: inc.outcome!,
        title: inc.incidentId, // 런타임에서 title을 가져와야 하지만 fallback으로 id 사용
      }));

    const npcEpilogues = Object.entries(npcStates).map(([npcId, npc]) => {
      const em = (npc.emotional ?? {}) as NpcEmotionalState;
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
    };
  }

  /**
   * 엔딩 결과 생성
   */
  generateEnding(
    input: EndingInput,
    endingReason: 'ALL_RESOLVED' | 'DEADLINE' | 'PLAYER_CHOICE',
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

    const closingLines = endingsData?.closingLines as Record<string, string> | undefined;
    const cityStatus: CityStatus = {
      stability,
      summary: closingLines?.[stability] ?? '도시는 계속되었다.',
    };

    // 2. NPC Epilogues 생성
    const epilogueTemplates = endingsData?.npcEpilogueTemplates as
      Record<string, Record<string, string>> | undefined;

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
        epilogueText = `${npc.npcName}은(는) 자신의 삶을 이어갔다.`;
      }

      return {
        npcId: npc.npcId,
        npcName: npc.npcName,
        epilogueText,
        finalPosture: npc.posture,
      };
    });

    // 3. Ending Type
    const endingType = endingReason === 'PLAYER_CHOICE'
      ? 'PLAYER_CHOICE' as const
      : endingReason === 'DEADLINE'
        ? 'DEADLINE' as const
        : 'NATURAL' as const;

    return {
      endingType,
      npcEpilogues,
      cityStatus,
      narrativeMarks: input.narrativeMarks,
      closingLine: cityStatus.summary,
      statistics: {
        daysSpent: input.daysSpent,
        incidentsContained: containedCount,
        incidentsEscalated: escalatedCount,
        incidentsExpired: expiredCount,
        totalTurns,
      },
    };
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
