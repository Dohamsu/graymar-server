// PR7: Procedural Event Generator (설계문서 20)
// 고정 이벤트 부족 시 Trigger+Subject+Action+Outcome 조합으로 동적 생성

import { Injectable } from '@nestjs/common';
import type { EventDefV2, Affordance } from '../../db/types/event-def.js';
import type {
  ProceduralSeed,
  ProceduralHistoryEntry,
  SeedConstraints,
} from '../../db/types/procedural-event.js';
import { TRIGGERS, SUBJECTS, ACTIONS, OUTCOMES } from './procedural-seeds.js';
import type { Rng } from '../rng/rng.service.js';

// Anti-Repetition 상수
const TRIGGER_COOLDOWN = 3;
const SUBJECT_ACTION_COOLDOWN = 5;
const MAX_CONSECUTIVE_OUTCOME = 2;
const MAX_CONSECUTIVE_NPC = 3;

@Injectable()
export class ProceduralEventService {
  /**
   * 동적 이벤트 생성.
   * 불변식: arcRouteTag/commitmentDeltaOnSuccess는 절대 없음 (메인 플롯 보호).
   */
  generate(
    constraints: SeedConstraints,
    history: ProceduralHistoryEntry[],
    turnNo: number,
    rng: Rng,
  ): EventDefV2 | null {
    // 1. Context Filter: location/time 기반 유효 seed 필터
    const validTriggers = this.filterSeeds(TRIGGERS, constraints);
    const validSubjects = this.filterSeeds(SUBJECTS, constraints);
    const validActions = ACTIONS; // 액션은 제약 없음
    const validOutcomes = OUTCOMES;

    if (validTriggers.length === 0 || validSubjects.length === 0) return null;

    // 2. Anti-Repetition: history 대조하여 차단된 seed 제외
    const availableTriggers = this.applyTriggerCooldown(
      validTriggers,
      history,
      turnNo,
    );
    const availableSubjects = this.applySubjectActionCooldown(
      validSubjects,
      validActions,
      history,
      turnNo,
    );

    if (availableTriggers.length === 0) return null;

    // 3. Seed 조합: 랜덤 선택
    const trigger = this.randomPick(availableTriggers, rng);
    if (!trigger) return null;
    const subject = this.randomPick(availableSubjects.subjects, rng);
    if (!subject) return null;
    const action = this.pickAvailableAction(
      validActions,
      subject,
      history,
      turnNo,
      rng,
    );
    if (!action) return null;
    const outcome = this.pickAvailableOutcome(validOutcomes, history, rng);
    if (!outcome) return null;

    // Anti-Repetition: 같은 NPC 연속 체크
    const npcId =
      subject.npcId && !this.isNpcConsecutiveBlocked(subject.npcId, history)
        ? subject.npcId
        : undefined;

    // 4. EventDefV2 생성
    const sceneFrame = `${trigger.text} ${subject.text}${subject.text.endsWith('이') || subject.text.endsWith('가') ? '' : '이(가)'} ${action.text} ${outcome.text}`;

    const affordances: Affordance[] = this.deriveAffordances(action, outcome);

    const event: EventDefV2 = {
      eventId: `PROC_${turnNo}`,
      locationId: constraints.locationId,
      eventType: 'ENCOUNTER',
      priority: 3, // 절차적 이벤트는 낮은 priority
      weight: 30,
      conditions: null,
      gates: [],
      affordances,
      friction: 0,
      matchPolicy: 'NEUTRAL',
      // 불변식: 메인 플롯 보호 (arcRouteTag, commitmentDeltaOnSuccess 없음)
      payload: {
        sceneFrame,
        primaryNpcId: npcId,
        choices: [],
        effectsOnEnter: [],
        tags: [
          ...(trigger.tags ?? []),
          ...(subject.tags ?? []),
          ...(outcome.tags ?? []),
          'PROCEDURAL',
        ],
      },
    };

    return event;
  }

  /**
   * 생성 후 history에 기록할 엔트리 생성
   */
  createHistoryEntry(
    turnNo: number,
    trigger: string,
    subject: string,
    action: string,
    outcome: string,
    npcId?: string,
  ): ProceduralHistoryEntry {
    return {
      turnNo,
      triggerId: trigger,
      subjectId: subject,
      actionId: action,
      outcomeId: outcome,
      npcId,
      subjectActionKey: `${subject}:${action}`,
    };
  }

  private filterSeeds(
    seeds: ProceduralSeed[],
    constraints: SeedConstraints,
  ): ProceduralSeed[] {
    return seeds.filter((s) => {
      if (
        s.locationIds &&
        s.locationIds.length > 0 &&
        !s.locationIds.includes(constraints.locationId)
      ) {
        return false;
      }
      if (
        s.timePhases &&
        s.timePhases.length > 0 &&
        !s.timePhases.includes(constraints.timePhase)
      ) {
        return false;
      }
      return true;
    });
  }

  private applyTriggerCooldown(
    triggers: ProceduralSeed[],
    history: ProceduralHistoryEntry[],
    turnNo: number,
  ): ProceduralSeed[] {
    const recentTriggers = new Set(
      history
        .filter((h) => turnNo - h.turnNo < TRIGGER_COOLDOWN)
        .map((h) => h.triggerId),
    );
    return triggers.filter((t) => !recentTriggers.has(t.id));
  }

  private applySubjectActionCooldown(
    subjects: ProceduralSeed[],
    actions: ProceduralSeed[],
    history: ProceduralHistoryEntry[],
    turnNo: number,
  ): { subjects: ProceduralSeed[] } {
    const recentKeys = new Set(
      history
        .filter((h) => turnNo - h.turnNo < SUBJECT_ACTION_COOLDOWN)
        .map((h) => h.subjectActionKey),
    );

    // subject가 모든 action과 조합했을 때 모두 쿨다운이면 제외
    const available = subjects.filter((s) =>
      actions.some((a) => !recentKeys.has(`${s.id}:${a.id}`)),
    );

    return { subjects: available.length > 0 ? available : subjects };
  }

  private pickAvailableAction(
    actions: ProceduralSeed[],
    subject: ProceduralSeed,
    history: ProceduralHistoryEntry[],
    turnNo: number,
    rng: Rng,
  ): ProceduralSeed | null {
    const recentKeys = new Set(
      history
        .filter((h) => turnNo - h.turnNo < SUBJECT_ACTION_COOLDOWN)
        .map((h) => h.subjectActionKey),
    );
    const available = actions.filter(
      (a) => !recentKeys.has(`${subject.id}:${a.id}`),
    );
    return this.randomPick(available.length > 0 ? available : actions, rng);
  }

  private pickAvailableOutcome(
    outcomes: ProceduralSeed[],
    history: ProceduralHistoryEntry[],
    rng: Rng,
  ): ProceduralSeed | null {
    // 같은 outcome 연속 max 2
    const recentOutcomes = history
      .slice(-MAX_CONSECUTIVE_OUTCOME)
      .map((h) => h.outcomeId);
    const lastOutcome =
      recentOutcomes.length > 0
        ? recentOutcomes[recentOutcomes.length - 1]
        : null;
    const consecutiveCount = lastOutcome
      ? recentOutcomes.filter((o) => o === lastOutcome).length
      : 0;

    let available = outcomes;
    if (consecutiveCount >= MAX_CONSECUTIVE_OUTCOME && lastOutcome) {
      available = outcomes.filter((o) => o.id !== lastOutcome);
    }

    return this.randomPick(available.length > 0 ? available : outcomes, rng);
  }

  private isNpcConsecutiveBlocked(
    npcId: string,
    history: ProceduralHistoryEntry[],
  ): boolean {
    const recent = history.slice(-MAX_CONSECUTIVE_NPC);
    return (
      recent.length >= MAX_CONSECUTIVE_NPC &&
      recent.every((h) => h.npcId === npcId)
    );
  }

  private deriveAffordances(
    action: ProceduralSeed,
    _outcome: ProceduralSeed,
  ): Affordance[] {
    const affordances: Affordance[] = ['ANY'];

    // action 기반 affordance 추가
    if (action.id === 'ACT_HIDE' || action.id === 'ACT_WATCH')
      affordances.push('OBSERVE', 'SNEAK');
    if (action.id === 'ACT_ARGUE' || action.id === 'ACT_FIGHT')
      affordances.push('FIGHT', 'THREATEN');
    if (action.id === 'ACT_BEG' || action.id === 'ACT_COLLAPSE')
      affordances.push('HELP');
    if (action.id === 'ACT_SELL' || action.id === 'ACT_TRADE')
      affordances.push('TRADE', 'BRIBE');
    if (action.id === 'ACT_SEARCH') affordances.push('INVESTIGATE', 'OBSERVE');
    if (action.id === 'ACT_STEAL') affordances.push('STEAL', 'SNEAK');
    if (action.id === 'ACT_WHISPER') affordances.push('INVESTIGATE', 'SNEAK');
    if (action.id === 'ACT_BLOCK') affordances.push('FIGHT', 'THREATEN');
    if (action.id === 'ACT_DROP') affordances.push('INVESTIGATE', 'HELP');
    if (action.id === 'ACT_FLEE') affordances.push('INVESTIGATE', 'OBSERVE');

    return [...new Set(affordances)];
  }

  private randomPick<T>(items: T[], rng: Rng): T | null {
    if (items.length === 0) return null;
    const idx = Math.floor(rng.next() * items.length);
    return items[idx];
  }
}
