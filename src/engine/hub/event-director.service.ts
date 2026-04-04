// PR5: Event Director 정책 레이어 (설계문서 19)
// 기존 EventMatcher를 래핑하여 5단계 정책 파이프라인 적용

import { Injectable } from '@nestjs/common';
import {
  EventMatcherService,
  type SessionNpcContext,
} from './event-matcher.service.js';
import type {
  EventDefV2,
  WorldState,
  ArcState,
  ParsedIntentV2,
  PlayerAgenda,
  IncidentRoutingResult,
} from '../../db/types/index.js';
import type {
  ParsedIntentV3,
  IntentGoalCategory,
  ApproachVector,
} from '../../db/types/parsed-intent-v3.js';
import type {
  EventDirectorResult,
  EventPriority,
} from '../../db/types/event-director.js';
import type { Rng } from '../rng/rng.service.js';

// goalCategory → 이벤트 태그 연관 매핑 (목표 기반 이벤트 선호)
const GOAL_TAG_AFFINITY: Record<IntentGoalCategory, string[]> = {
  GET_INFO: ['investigation', 'rumor', 'intelligence', 'clue', 'information'],
  GAIN_ACCESS: ['access', 'passage', 'sneak', 'entry'],
  SHIFT_RELATION: ['npc', 'dialogue', 'relationship', 'favor'],
  ACQUIRE_RESOURCE: ['trade', 'merchant', 'loot', 'supply'],
  BLOCK_RIVAL: ['sabotage', 'opposition', 'guard', 'block'],
  CREATE_DISTRACTION: ['distraction', 'chaos', 'diversion'],
  HIDE_TRACE: ['stealth', 'cover', 'sneak', 'escape'],
  ESCALATE_CONFLICT: ['conflict', 'fight', 'ambush', 'confrontation'],
  DEESCALATE_CONFLICT: ['peace', 'negotiate', 'calm', 'rest'],
  TEST_REACTION: ['observe', 'probe', 'watch', 'test'],
};

// approachVector → 이벤트 태그 연관 매핑
const VECTOR_TAG_AFFINITY: Record<ApproachVector, string[]> = {
  SOCIAL: ['dialogue', 'npc', 'negotiation', 'persuade'],
  STEALTH: ['stealth', 'sneak', 'shadow', 'covert'],
  PRESSURE: ['threat', 'intimidation', 'force', 'confrontation'],
  ECONOMIC: ['trade', 'merchant', 'bribe', 'economy'],
  OBSERVATIONAL: ['observe', 'investigation', 'clue', 'rumor'],
  POLITICAL: ['faction', 'corruption', 'politics', 'power'],
  LOGISTICAL: ['travel', 'supply', 'rest', 'passage'],
  VIOLENT: ['combat', 'fight', 'ambush', 'attack'],
};

@Injectable()
export class EventDirectorService {
  constructor(private readonly eventMatcher: EventMatcherService) {}

  /**
   * 5단계 파이프라인:
   * 1. Stage Filter: mainArcClock.stage와 event.stage[] 매칭
   * 2. Condition Filter: 기존 evaluateCondition() 위임
   * 3. Cooldown Filter: 기존 evaluateGates() + cooldownTurns
   * 4. Priority Sort: priority → weight 리매핑
   * 5. Weighted Random: EventMatcher에 위임
   */
  select(
    allEvents: EventDefV2[],
    locationId: string,
    intent: ParsedIntentV2,
    ws: WorldState,
    arcState: ArcState,
    agenda: PlayerAgenda,
    cooldowns: Record<string, number>,
    currentTurnNo: number,
    rng: Rng,
    recentEventIds: string[],
    routingResult: IncidentRoutingResult | null,
    sessionNpcContext?: SessionNpcContext,
    intentV3?: ParsedIntentV3 | null,
  ): EventDirectorResult {
    const filterLog: string[] = [];

    // Stage 1: mainArc.stage 필터 (MainArcProgress.stage)
    const currentStage = ws.mainArc?.stage;
    let stageFiltered: EventDefV2[];

    if (currentStage != null) {
      const stageStr = String(currentStage);
      stageFiltered = allEvents.filter((e) => {
        const eventStages = e.stages;
        // stages가 없으면 통과 (스테이지 무관 이벤트)
        if (!eventStages || eventStages.length === 0) return true;
        return eventStages.includes(stageStr);
      });
      const filtered = allEvents.length - stageFiltered.length;
      if (filtered > 0) {
        filterLog.push(`stage=${stageStr}: ${filtered}개 제외`);
      }
    } else {
      stageFiltered = allEvents;
    }

    // Stage 4: Priority → weight 리매핑 + IntentV3 목표 기반 가중치 부스트
    const remapped = stageFiltered.map((e) => {
      let boosted = this.remapPriority(e);
      if (intentV3) {
        const goalBoost = this.computeGoalBoost(e, intentV3);
        if (goalBoost > 0) {
          boosted = { ...boosted, weight: boosted.weight + goalBoost };
        }
      }
      return boosted;
    });
    filterLog.push(`priority 리매핑: ${remapped.length}개`);
    if (intentV3) {
      filterLog.push(
        `intentV3: goal=${intentV3.goalCategory}, vector=${intentV3.approachVector}`,
      );
    }

    // Stage 2,3,5: EventMatcher에 위임 (condition, gates, affordances, heat, weighted random)
    const selected = this.eventMatcher.matchWithIncidentContext(
      remapped,
      locationId,
      intent,
      ws,
      arcState,
      agenda,
      cooldowns,
      currentTurnNo,
      rng,
      recentEventIds,
      routingResult,
      sessionNpcContext,
    );

    const candidateCount = remapped.filter(
      (e) => e.locationId === locationId,
    ).length;
    filterLog.push(
      `최종 후보: ${candidateCount}개, 선택: ${selected?.eventId ?? 'null'}`,
    );

    return {
      selectedEvent: selected,
      candidateCount,
      filterLog,
    };
  }

  /**
   * Priority → weight 리매핑 (문서 19 기준)
   * priority ≥ 8 → critical(weight=10)
   * priority ≥ 6 → high(weight=6)
   * priority ≥ 4 → medium(weight=3)
   * else → low(weight=1)
   */
  private remapPriority(event: EventDefV2): EventDefV2 {
    // eventCategory가 있는 신규 이벤트만 리매핑
    if (!event.eventCategory) return event;

    const tier = this.getPriorityTier(event.priority);
    const weightMultiplier =
      tier === 'critical'
        ? 10
        : tier === 'high'
          ? 6
          : tier === 'medium'
            ? 3
            : 1;

    return {
      ...event,
      weight: Math.max(event.weight, event.priority * weightMultiplier),
    };
  }

  /**
   * IntentV3 목표/접근방식과 이벤트 태그의 연관도에 따른 가중치 부스트.
   * goalCategory 매칭: +15, approachVector 매칭: +10
   */
  private computeGoalBoost(
    event: EventDefV2,
    intentV3: ParsedIntentV3,
  ): number {
    const tags = event.payload?.tags ?? [];
    if (tags.length === 0) return 0;

    let boost = 0;
    const tagsLower = tags.map((t: string) => t.toLowerCase());

    // goalCategory 매칭
    const goalTags = GOAL_TAG_AFFINITY[intentV3.goalCategory] ?? [];
    for (const gt of goalTags) {
      if (tagsLower.some((t) => t.includes(gt))) {
        boost += 15;
        break;
      }
    }

    // approachVector 매칭
    const vectorTags = VECTOR_TAG_AFFINITY[intentV3.approachVector] ?? [];
    for (const vt of vectorTags) {
      if (tagsLower.some((t) => t.includes(vt))) {
        boost += 10;
        break;
      }
    }

    return boost;
  }

  private getPriorityTier(priority: number): EventPriority {
    if (priority >= 8) return 'critical';
    if (priority >= 6) return 'high';
    if (priority >= 4) return 'medium';
    return 'low';
  }
}
