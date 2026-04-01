// Quest Progression Service — quest.json stateTransitions 기반 퀘스트 단계 자동 전환
// FACT 발견 → 조건 충족 시 questState 자동 진행 (S0 → S1 → ... → S5)

import { Injectable, Logger } from '@nestjs/common';
import { ContentLoaderService } from '../../content/content-loader.service.js';
import type { RunState } from '../../db/types/permanent-stats.js';

interface StateTransition {
  requiredFacts?: string[];
  requiredAnyOf?: string[][];
  alternativeFacts?: string[];
  description?: string;
}

interface QuestData {
  questId: string;
  states: string[];
  stateTransitions: Record<string, StateTransition>;
  facts: Record<string, unknown>;
}

@Injectable()
export class QuestProgressionService {
  private readonly logger = new Logger(QuestProgressionService.name);

  constructor(private readonly content: ContentLoaderService) {}

  /**
   * 현재 퀘스트 상태와 발견된 facts를 비교하여 단계 전환 여부를 판단.
   * 한 번 호출에 최대 1단계만 전환 (연쇄 전환 방지).
   */
  checkTransition(
    currentState: string,
    discoveredFactIds: Set<string>,
  ): { newState: string | null; transitionDesc: string | null } {
    const quest = this.content.getQuestData() as QuestData | null;
    if (!quest?.stateTransitions) return { newState: null, transitionDesc: null };

    for (const [key, transition] of Object.entries(quest.stateTransitions)) {
      // key format: "S0_ARRIVE→S1_GET_ANGLE" (유니코드 화살표)
      const arrowIdx = key.indexOf('\u2192');
      if (arrowIdx === -1) continue;
      const from = key.slice(0, arrowIdx);
      const to = key.slice(arrowIdx + 1);
      if (from !== currentState) continue;

      const required = transition.requiredFacts ?? [];
      const anyOf = transition.requiredAnyOf ?? [];
      const alternatives = transition.alternativeFacts ?? [];

      // requiredFacts: 모두 발견되어야 함
      const allRequiredMet = required.every((f) => discoveredFactIds.has(f));
      if (!allRequiredMet) continue;

      // requiredAnyOf: 그룹 중 하나라도 모두 충족
      const anyOfMet =
        anyOf.length === 0 ||
        anyOf.some((group) => group.every((f) => discoveredFactIds.has(f)));
      if (!anyOfMet) continue;

      // alternativeFacts: 대체 경로 (하나라도 있으면 OK)
      const altMet =
        alternatives.length === 0 ||
        alternatives.some((f) => discoveredFactIds.has(f));

      // 최소 하나의 조건 계열이 실질적으로 충족되어야 전환
      const hasSubstantiveCondition =
        required.length > 0 || anyOf.length > 0;
      if (hasSubstantiveCondition || altMet) {
        this.logger.log(
          `Quest transition: ${from} -> ${to} (facts: ${[...discoveredFactIds].join(', ')})`,
        );
        return { newState: to, transitionDesc: transition.description ?? null };
      }
    }

    return { newState: null, transitionDesc: null };
  }

  /**
   * RunState에서 발견된 퀘스트 팩트 ID를 수집.
   * 소스:
   *  1) runState.discoveredQuestFacts (동기적으로 기록된 것)
   *  2) worldFacts 태그에서 FACT_ 프리픽스
   *  3) NPC personalMemory.knownFacts에서 FACT_ 매칭 (텍스트 기반 heuristic)
   */
  collectDiscoveredFacts(runState: RunState): Set<string> {
    const facts = new Set<string>();

    // 1) 명시적 추적 필드 (가장 신뢰성 높음)
    if (runState.discoveredQuestFacts) {
      for (const f of runState.discoveredQuestFacts) {
        facts.add(f);
      }
    }

    // 2) worldFacts 태그에서 FACT_ 프리픽스 수집
    const worldFacts = runState.worldState?.worldFacts;
    if (Array.isArray(worldFacts)) {
      for (const wf of worldFacts) {
        const tags = (wf as unknown as Record<string, unknown>).tags;
        if (Array.isArray(tags)) {
          for (const tag of tags) {
            if (typeof tag === 'string' && tag.startsWith('FACT_')) {
              facts.add(tag);
            }
          }
        }
      }
    }

    return facts;
  }

  /**
   * NPC와 상호작용 후 SUCCESS/PARTIAL 판정 시, 해당 NPC의 knownFacts에서
   * 다음 공개 대상 quest FACT ID를 반환.
   * 이미 discoveredQuestFacts에 있으면 스킵.
   */
  getRevealableQuestFact(
    npcId: string,
    runState: RunState,
  ): string | null {
    const npcDef = this.content.getNpc(npcId);
    if (!npcDef?.knownFacts || npcDef.knownFacts.length === 0) return null;

    const discovered = new Set(runState.discoveredQuestFacts ?? []);
    // 순서대로 첫 번째 미발견 fact 반환
    for (const entry of npcDef.knownFacts) {
      if (!discovered.has(entry.factId)) {
        return entry.factId;
      }
    }
    return null;
  }

  /**
   * factId에 해당하는 NPC knownFact의 detail 텍스트를 반환.
   * 대화 주제 추적에서 정확한 주제명을 기록하기 위해 사용.
   */
  getFactDetail(factId: string): string | null {
    const allNpcs = this.content.getAllNpcs();
    for (const npc of allNpcs) {
      if (!npc.knownFacts) continue;
      for (const entry of npc.knownFacts) {
        if (entry.factId === factId && entry.detail) {
          return entry.detail;
        }
      }
    }
    return null;
  }
}
