import { Injectable } from '@nestjs/common';
import type {
  EventDefV2,
  WorldState,
  ArcState,
  ParsedIntentV2,
  PlayerAgenda,
  ConditionCmp,
  Gate,
} from '../../db/types/index.js';
import type { Rng } from '../rng/rng.service.js';

const DANGER_BLOCK_CHANCE = 25;
const CRACKDOWN_BLOCK_CHANCE = 40;

@Injectable()
export class EventMatcherService {
  /**
   * 6단계 이벤트 매칭 알고리즘
   * 1. locationId 필터
   * 2. conditions (CMP 평가)
   * 3. gates (COOLDOWN_TURNS, REQUIRE_FLAG, REQUIRE_ARC)
   * 4. affordances ∩ intent.actionType 매칭
   * 5. Heat 간섭 (DANGER/CRACKDOWN → BLOCK 이벤트 삽입)
   * 6. Agenda weight 보정 → priority*10 + weight + agendaBoost → RNG 가중치 선택
   */
  match(
    events: EventDefV2[],
    locationId: string,
    intent: ParsedIntentV2,
    ws: WorldState,
    arcState: ArcState,
    agenda: PlayerAgenda,
    cooldowns: Record<string, number>,
    currentTurnNo: number,
    rng: Rng,
    recentEventIds: string[] = [],
  ): EventDefV2 | null {
    // Step 1: locationId 필터
    let candidates = events.filter((e) => e.locationId === locationId);

    // Step 2: conditions 평가
    candidates = candidates.filter((e) =>
      this.evaluateCondition(e.conditions, ws, arcState),
    );

    // Step 3: gates 평가
    candidates = candidates.filter((e) =>
      this.evaluateGates(e.gates, ws, cooldowns, currentTurnNo, e.eventId),
    );

    // Step 4: affordances 매칭 (primary OR secondary)
    candidates = candidates.filter(
      (e) =>
        e.affordances.includes('ANY') ||
        e.affordances.includes(intent.actionType as any) ||
        (intent.secondaryActionType &&
         e.affordances.includes(intent.secondaryActionType as any)),
    );

    if (candidates.length === 0) return null;

    // Step 5: Heat 간섭 — DANGER/CRACKDOWN 확률로 BLOCK 이벤트 삽입
    if (ws.hubSafety === 'DANGER' || ws.hubSafety === 'ALERT') {
      const blockChance =
        ws.hubSafety === 'DANGER' ? DANGER_BLOCK_CHANCE : CRACKDOWN_BLOCK_CHANCE;
      if (rng.chance(blockChance)) {
        const blockEvents = candidates.filter(
          (e) => e.matchPolicy === 'BLOCK',
        );
        if (blockEvents.length > 0) {
          candidates = blockEvents;
        }
      }
    }

    // Step 6: Agenda weight 보정 + 최근 사용 이벤트 페널티 + 가중치 선택
    const consecutiveFallbacks = this.countConsecutiveFallbacks(recentEventIds, events);
    const recentSet = new Set(recentEventIds);
    const weights = candidates.map((e) => {
      const base = e.priority * 10 + e.weight;
      const agendaBoost = this.computeAgendaBoost(e, agenda);
      let penalty = 0;

      // FALLBACK 연속 페널티
      if (e.eventType === 'FALLBACK' && consecutiveFallbacks > 0) {
        penalty += consecutiveFallbacks * 30;
      }

      // 최근 사용된 이벤트 가중치 감점 (쿨다운 gates 없어도 반복 방지)
      if (recentSet.has(e.eventId)) {
        penalty += 40;
      }

      return Math.max(1, base + agendaBoost - penalty);
    });

    return this.weightedSelect(candidates, weights, rng);
  }

  private evaluateCondition(
    condition: ConditionCmp | null,
    ws: WorldState,
    arcState: ArcState,
  ): boolean {
    if (!condition) return true;

    const value = this.resolveField(condition.field, ws, arcState);
    if (value === undefined) return false;

    switch (condition.op) {
      case 'eq':
        return value === condition.value;
      case 'ne':
        return value !== condition.value;
      case 'gt':
        return (value as number) > (condition.value as number);
      case 'gte':
        return (value as number) >= (condition.value as number);
      case 'lt':
        return (value as number) < (condition.value as number);
      case 'lte':
        return (value as number) <= (condition.value as number);
      default:
        return false;
    }
  }

  private resolveField(
    field: string,
    ws: WorldState,
    arcState: ArcState,
  ): unknown {
    const parts = field.split('.');
    let obj: any = { ...ws, arcState };
    for (const part of parts) {
      if (obj == null) return undefined;
      obj = obj[part];
    }
    return obj;
  }

  private evaluateGates(
    gates: Gate[],
    ws: WorldState,
    cooldowns: Record<string, number>,
    currentTurnNo: number,
    eventId: string,
  ): boolean {
    for (const gate of gates) {
      switch (gate.type) {
        case 'COOLDOWN_TURNS': {
          const lastUsed = cooldowns[eventId] ?? -Infinity;
          if (currentTurnNo - lastUsed < (gate.turns ?? 0)) return false;
          break;
        }
        case 'REQUIRE_FLAG': {
          if (!gate.flag || !ws.flags[gate.flag]) return false;
          break;
        }
        case 'REQUIRE_ARC': {
          if (
            !gate.arcId ||
            !ws.mainArc.unlockedArcIds.includes(gate.arcId)
          )
            return false;
          break;
        }
      }
    }
    return true;
  }

  private computeAgendaBoost(
    event: EventDefV2,
    agenda: PlayerAgenda,
  ): number {
    let boost = 0;
    const tags = event.payload.tags;
    const buckets = agenda.implicit;

    if (tags.includes('destabilize') && buckets.destabilizeGuard > 0)
      boost += buckets.destabilizeGuard * 2;
    if (tags.includes('merchant') && buckets.allyMerchant > 0)
      boost += buckets.allyMerchant * 2;
    if (tags.includes('underworld') && buckets.empowerUnderworld > 0)
      boost += buckets.empowerUnderworld * 2;
    if (tags.includes('corruption') && buckets.exposeCorruption > 0)
      boost += buckets.exposeCorruption * 2;
    if (tags.includes('chaos') && buckets.profitFromChaos > 0)
      boost += buckets.profitFromChaos * 2;

    return boost;
  }

  private countConsecutiveFallbacks(
    recentEventIds: string[],
    allEvents: EventDefV2[],
  ): number {
    const eventMap = new Map(allEvents.map((e) => [e.eventId, e]));
    let count = 0;
    for (let i = recentEventIds.length - 1; i >= 0; i--) {
      const ev = eventMap.get(recentEventIds[i]);
      if (ev?.eventType === 'FALLBACK') {
        count++;
      } else {
        break;
      }
    }
    return count;
  }

  private weightedSelect(
    items: EventDefV2[],
    weights: number[],
    rng: Rng,
  ): EventDefV2 {
    const totalWeight = weights.reduce((sum, w) => sum + w, 0);
    let roll = rng.next() * totalWeight;
    for (let i = 0; i < items.length; i++) {
      roll -= weights[i];
      if (roll <= 0) return items[i];
    }
    return items[items.length - 1];
  }
}
