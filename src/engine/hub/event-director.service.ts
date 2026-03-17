// PR5: Event Director 정책 레이어 (설계문서 19)
// 기존 EventMatcher를 래핑하여 5단계 정책 파이프라인 적용

import { Injectable } from '@nestjs/common';
import { EventMatcherService, type SessionNpcContext } from './event-matcher.service.js';
import type {
  EventDefV2,
  WorldState,
  ArcState,
  ParsedIntentV2,
  PlayerAgenda,
  IncidentRoutingResult,
} from '../../db/types/index.js';
import type { EventDirectorResult, EventPriority } from '../../db/types/event-director.js';
import type { Rng } from '../rng/rng.service.js';

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

    // Stage 4: Priority → weight 리매핑
    const remapped = stageFiltered.map((e) => this.remapPriority(e));
    filterLog.push(`priority 리매핑: ${remapped.length}개`);

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

    const candidateCount = remapped.filter((e) => e.locationId === locationId).length;
    filterLog.push(`최종 후보: ${candidateCount}개, 선택: ${selected?.eventId ?? 'null'}`);

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
    const weightMultiplier = tier === 'critical' ? 10 : tier === 'high' ? 6 : tier === 'medium' ? 3 : 1;

    return {
      ...event,
      weight: Math.max(event.weight, event.priority * weightMultiplier),
    };
  }

  private getPriorityTier(priority: number): EventPriority {
    if (priority >= 8) return 'critical';
    if (priority >= 6) return 'high';
    if (priority >= 4) return 'medium';
    return 'low';
  }
}
