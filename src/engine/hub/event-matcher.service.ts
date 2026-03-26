import { Injectable } from '@nestjs/common';
import type {
  EventDefV2,
  WorldState,
  ArcState,
  ParsedIntentV2,
  PlayerAgenda,
  ConditionCmp,
  Gate,
  IncidentRoutingResult,
} from '../../db/types/index.js';
import type { Rng } from '../rng/rng.service.js';

/** NPC 연속성 컨텍스트 — 같은 LOCATION 방문 내 NPC 상호작용 추적 */
export interface SessionNpcContext {
  lastPrimaryNpcId: string | null;
  sessionTurnCount: number;
  interactedNpcIds: string[];
}

const DANGER_BLOCK_CHANCE = 40;
const CRACKDOWN_BLOCK_CHANCE = 25;

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
    sessionNpcContext?: SessionNpcContext,
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

    // PR-D: 직전 이벤트 hard block — 연속 2회 방지
    const lastEventId = recentEventIds.length > 0 ? recentEventIds[recentEventIds.length - 1] : null;
    if (lastEventId) {
      const blocked = candidates.filter((e) => e.eventId !== lastEventId);
      if (blocked.length > 0) candidates = blocked;
      // 안전장치: 모든 후보가 직전 이벤트면 원래 후보 유지
    }

    // 방문 내 하드캡: 동일 이벤트 2회 이상 등장 시 후보에서 제외
    const visitEventCounts = new Map<string, number>();
    for (const id of recentEventIds) {
      visitEventCounts.set(id, (visitEventCounts.get(id) ?? 0) + 1);
    }
    const hardcapped = candidates.filter(
      (e) => (visitEventCounts.get(e.eventId) ?? 0) < 2,
    );
    // 안전장치: 전체 후보 제거되면 필터 스킵
    if (hardcapped.length > 0) {
      candidates = hardcapped;
    }

    const weights = candidates.map((e) => {
      const base = e.priority * 10 + e.weight;
      const agendaBoost = this.computeAgendaBoost(e, agenda);
      let penalty = 0;

      // FALLBACK 연속 페널티
      if (e.eventType === 'FALLBACK' && consecutiveFallbacks > 0) {
        penalty += consecutiveFallbacks * 30;
      }

      // 누진 반복 페널티 (연속 횟수 기반)
      const repeatPenalty = this.calcProgressiveRepeatPenalty(e.eventId, recentEventIds);
      penalty += repeatPenalty;

      // NPC 연속성 보너스 (BLOCK matchPolicy가 아닌 경우만)
      let npcBonus = 0;
      if (sessionNpcContext && e.matchPolicy !== 'BLOCK') {
        npcBonus = this.calcNpcContinuityBonus(e, sessionNpcContext);
      }

      // NPC 전환 페널티: 직전 NPC와 다른 NPC의 이벤트 → 장면 연속성 훼손 방지
      // 대화 계열 행동(TALK, PERSUADE, BRIBE, THREATEN, HELP)일 때 페널티 3배 강화 → NPC 유지 우선
      const _socialActions = new Set(['TALK', 'PERSUADE', 'BRIBE', 'THREATEN', 'HELP']);
      const baseSwitchPenalty = this.calcNpcSwitchPenalty(e, sessionNpcContext);
      const npcSwitchPenalty = _socialActions.has(intent.actionType) ? baseSwitchPenalty * 3 : baseSwitchPenalty;
      penalty += npcSwitchPenalty;

      // 이벤트 태그 연속성 보너스 (관련 이벤트 선호 → 내러티브 흐름 유지)
      const tagBonus = this.calcTagContinuityBonus(e, recentEventIds, events);

      // npcBonus가 repeatPenalty의 50% 이상 상쇄 불가
      const effectiveNpcBonus = repeatPenalty > 0
        ? Math.min(npcBonus, repeatPenalty * 0.5)
        : npcBonus;

      return Math.max(1, base + agendaBoost + effectiveNpcBonus + tagBonus - penalty);
    });

    return this.weightedSelect(candidates, weights, rng);
  }

  /**
   * Incident context 연동 이벤트 매칭.
   * routingResult가 있으면 관련 tags/npc/location 가중치 부스트.
   * null이면 기존 match() 동작과 동일.
   */
  matchWithIncidentContext(
    events: EventDefV2[],
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
  ): EventDefV2 | null {
    if (!routingResult || routingResult.routeMode === 'FALLBACK_SCENE') {
      return this.match(events, locationId, intent, ws, arcState, agenda, cooldowns, currentTurnNo, rng, recentEventIds, sessionNpcContext);
    }

    // Step 1-5: 기존 필터링
    let candidates = events.filter((e) => e.locationId === locationId);
    candidates = candidates.filter((e) => this.evaluateCondition(e.conditions, ws, arcState));
    candidates = candidates.filter((e) => this.evaluateGates(e.gates, ws, cooldowns, currentTurnNo, e.eventId));
    candidates = candidates.filter(
      (e) =>
        e.affordances.includes('ANY') ||
        e.affordances.includes(intent.actionType as any) ||
        (intent.secondaryActionType && e.affordances.includes(intent.secondaryActionType as any)),
    );

    if (candidates.length === 0) return null;

    // Heat 간섭
    if (ws.hubSafety === 'DANGER' || ws.hubSafety === 'ALERT') {
      const blockChance = ws.hubSafety === 'DANGER' ? DANGER_BLOCK_CHANCE : CRACKDOWN_BLOCK_CHANCE;
      if (rng.chance(blockChance)) {
        const blockEvents = candidates.filter((e) => e.matchPolicy === 'BLOCK');
        if (blockEvents.length > 0) candidates = blockEvents;
      }
    }

    // Step 6: Incident context 가중치 부스트
    const routingTags = new Set(routingResult.tags);
    const consecutiveFallbacks = this.countConsecutiveFallbacks(recentEventIds, events);

    // PR-D: 직전 이벤트 hard block — 연속 2회 방지
    const lastEventIdInc = recentEventIds.length > 0 ? recentEventIds[recentEventIds.length - 1] : null;
    if (lastEventIdInc) {
      const blocked = candidates.filter((e) => e.eventId !== lastEventIdInc);
      if (blocked.length > 0) candidates = blocked;
    }

    // 방문 내 하드캡: 동일 이벤트 2회 이상 등장 시 후보에서 제외
    const visitEventCounts = new Map<string, number>();
    for (const id of recentEventIds) {
      visitEventCounts.set(id, (visitEventCounts.get(id) ?? 0) + 1);
    }
    const hardcapped = candidates.filter(
      (e) => (visitEventCounts.get(e.eventId) ?? 0) < 2,
    );
    if (hardcapped.length > 0) {
      candidates = hardcapped;
    }

    const weights = candidates.map((e) => {
      const base = e.priority * 10 + e.weight;
      const agendaBoost = this.computeAgendaBoost(e, agenda);
      let penalty = 0;
      let incidentBoost = 0;

      // FALLBACK 연속 페널티
      if (e.eventType === 'FALLBACK' && consecutiveFallbacks > 0) {
        penalty += consecutiveFallbacks * 30;
      }

      // 누진 반복 페널티
      const repeatPenalty = this.calcProgressiveRepeatPenalty(e.eventId, recentEventIds);
      penalty += repeatPenalty;

      // Incident context 부스트: 이벤트 태그와 라우팅 태그 교집합
      const eventTags = e.payload.tags;
      for (const tag of eventTags) {
        if (routingTags.has(tag)) incidentBoost += 15;
        if (routingTags.has(`npc:${tag}`)) incidentBoost += 10;
      }
      if (routingResult.incident) {
        const kindTag = routingResult.incident.kind.toLowerCase();
        if (eventTags.some((t) => t.toLowerCase().includes(kindTag))) {
          incidentBoost += 10;
        }
      }

      // NPC 연속성 보너스 (BLOCK matchPolicy가 아닌 경우만)
      let npcBonus = 0;
      if (sessionNpcContext && e.matchPolicy !== 'BLOCK') {
        npcBonus = this.calcNpcContinuityBonus(e, sessionNpcContext);
      }

      // NPC 전환 페널티: 직전 NPC와 다른 NPC의 이벤트 → 장면 연속성 훼손 방지
      // 대화 계열 행동(TALK, PERSUADE, BRIBE, THREATEN, HELP)일 때 페널티 3배 강화 → NPC 유지 우선
      const _socialActions = new Set(['TALK', 'PERSUADE', 'BRIBE', 'THREATEN', 'HELP']);
      const baseSwitchPenalty = this.calcNpcSwitchPenalty(e, sessionNpcContext);
      const npcSwitchPenalty = _socialActions.has(intent.actionType) ? baseSwitchPenalty * 3 : baseSwitchPenalty;
      penalty += npcSwitchPenalty;

      // 이벤트 태그 연속성 보너스 (관련 이벤트 선호 → 내러티브 흐름 유지)
      const tagBonus = this.calcTagContinuityBonus(e, recentEventIds, events);

      // npcBonus가 repeatPenalty의 50% 이상 상쇄 불가
      const effectiveNpcBonus = repeatPenalty > 0
        ? Math.min(npcBonus, repeatPenalty * 0.5)
        : npcBonus;

      return Math.max(1, base + agendaBoost + incidentBoost + effectiveNpcBonus + tagBonus - penalty);
    });

    return this.weightedSelect(candidates, weights, rng);
  }

  /** 누진 반복 페널티: 연속 등장 횟수에 따라 증가 */
  private calcProgressiveRepeatPenalty(eventId: string, recentEventIds: string[]): number {
    let consecutive = 0;
    for (let i = recentEventIds.length - 1; i >= 0; i--) {
      if (recentEventIds[i] === eventId) consecutive++;
      else break;
    }
    if (consecutive === 0) return 0;
    if (consecutive === 1) return 60;  // PR-D: 40 → 60 강화
    if (consecutive === 2) return 70;
    return 100; // 3연속 이상: 사실상 차단
  }

  /**
   * 이벤트 태그 연속성 보너스: 직전 이벤트와 태그가 겹치면 +15~20.
   * 관련 이벤트가 이어지면 내러티브 흐름이 자연스러워진다.
   */
  private calcTagContinuityBonus(event: EventDefV2, recentEventIds: string[], allEvents: EventDefV2[]): number {
    if (recentEventIds.length === 0) return 0;
    const lastEventId = recentEventIds[recentEventIds.length - 1];
    if (lastEventId === event.eventId) return 0; // 같은 이벤트면 보너스 없음

    const lastEvent = allEvents.find((e) => e.eventId === lastEventId);
    if (!lastEvent) return 0;

    const lastTags = new Set((lastEvent.payload?.tags ?? []).map((t: string) => t.toLowerCase()));
    if (lastTags.size === 0) return 0;

    const currentTags = (event.payload?.tags ?? []).map((t: string) => t.toLowerCase());
    let matchCount = 0;
    for (const tag of currentTags) {
      if (lastTags.has(tag)) matchCount++;
    }

    if (matchCount === 0) return 0;
    // 1개 태그 매칭 +12, 2개 이상 +20
    return matchCount >= 2 ? 20 : 12;
  }

  /** NPC 연속성 보너스: 같은 NPC +25, 방문 내 상호작용 NPC +10 */
  private calcNpcContinuityBonus(event: EventDefV2, ctx: SessionNpcContext): number {
    const eventNpcId = (event.payload as Record<string, unknown>).primaryNpcId as string | undefined;
    if (!eventNpcId) return 0;

    // 직전 턴에서 대화한 NPC와 같은 이벤트 → +25
    if (ctx.lastPrimaryNpcId && eventNpcId === ctx.lastPrimaryNpcId) return 25;

    // 이번 방문 중 상호작용한 NPC → +10
    if (ctx.interactedNpcIds.includes(eventNpcId)) return 10;

    return 0;
  }

  /**
   * NPC 전환 페널티: 직전 턴에 상호작용한 NPC가 있을 때,
   * 다른 NPC의 이벤트가 선택되면 장면 연속성이 깨지므로 페널티 부여.
   * NPC 없는 이벤트(탐색, 환경 등)에는 페널티 없음.
   */
  private calcNpcSwitchPenalty(event: EventDefV2, ctx?: SessionNpcContext): number {
    if (!ctx?.lastPrimaryNpcId) return 0;
    const eventNpcId = (event.payload as Record<string, unknown>).primaryNpcId as string | undefined;
    // NPC 없는 이벤트 → 전환 페널티 없음 (자연스러운 장면 전환)
    if (!eventNpcId) return 0;
    // 같은 NPC → 페널티 없음
    if (eventNpcId === ctx.lastPrimaryNpcId) return 0;
    // 다른 NPC → 장면 연속성 훼손 페널티 (-30)
    return 30;
  }

  private evaluateCondition(
    condition: ConditionCmp | null,
    ws: WorldState,
    arcState: ArcState,
  ): boolean {
    if (!condition) return true;

    const value = this.resolveField(condition.field, ws, arcState);
    if (value === undefined) return false;

    // 연산자 정규화: JSON에서 기호(>=, <=, ==, !=, >, <)와 문자열(gte, lte, eq, ne, gt, lt) 모두 지원
    const op = this.normalizeOp(condition.op);
    switch (op) {
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

  /** 연산자 기호를 문자열 형태로 정규화 */
  private normalizeOp(op: string): string {
    switch (op) {
      case '>=': return 'gte';
      case '<=': return 'lte';
      case '==': return 'eq';
      case '!=': return 'ne';
      case '>': return 'gt';
      case '<': return 'lt';
      default: return op;
    }
  }

  private resolveField(
    field: string,
    ws: WorldState,
    arcState: ArcState,
  ): unknown {
    // 필드 별칭 정규화: events_v2.json에서 사용하는 약칭 → 실제 WorldState 필드
    const aliasMap: Record<string, string> = {
      'heat': 'hubHeat',
      'worldState.heat': 'hubHeat',
      'worldState.hubHeat': 'hubHeat',
    };
    const resolved = aliasMap[field] ?? field;

    const parts = resolved.split('.');
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
