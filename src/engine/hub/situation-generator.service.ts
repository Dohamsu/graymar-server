// Living World v2: 3계층 상황 생성기
// 세계 상태에서 상황을 생성한다. 기존 EventMatcher와 병렬 배치 (점진적 전환).

import { Injectable, Inject } from '@nestjs/common';
import type {
  WorldState,
  EventDefV2,
  ParsedIntentV2,
  IncidentDef,
  WorldFact,
} from '../../db/types/index.js';
import { ContentLoaderService } from '../../content/content-loader.service.js';
import { WorldFactService } from './world-fact.service.js';

/** 상황 트리거 유형 */
export type SituationTrigger =
  | 'LANDMARK' // Layer 1: 스토리 체크포인트
  | 'INCIDENT_DRIVEN' // Layer 2: 활성 사건 맥락
  | 'NPC_ACTIVITY' // Layer 3: NPC가 뭔가 하고 있음
  | 'NPC_CONFLICT' // Layer 3: NPC 간 대립
  | 'ENVIRONMENTAL' // Layer 3: 장소 조건에서 파생
  | 'CONSEQUENCE' // Layer 3: 이전 fact의 결과
  | 'DISCOVERY' // Layer 3: 새로운 발견
  | 'OPPORTUNITY' // Layer 3: 일시적 기회
  | 'ROUTINE'; // Layer 3: 일상적 장면

/** SituationGenerator 출력 (EventDefV2 호환) */
export interface Situation {
  trigger: SituationTrigger;
  eventDef: EventDefV2; // 기존 파이프라인과 호환
  primaryNpcId?: string;
  secondaryNpcId?: string;
  relatedFacts: string[]; // 관련 WorldFact ids
  dynamicSceneFrame?: string; // Layer 3에서 동적 생성된 장면 설명
}

@Injectable()
export class SituationGeneratorService {
  // P3: generate() 호출 시 설정, findTemplatePreferFact에서 참조
  private _discoveredFacts?: Set<string>;

  constructor(
    @Inject(ContentLoaderService)
    private readonly content: ContentLoaderService,
    private readonly worldFact: WorldFactService,
  ) {}

  /**
   * 3계층 상황 생성
   * Layer 1 → Layer 2 → Layer 3 순서로 시도, 첫 번째 성공한 계층의 결과 반환
   * 모든 계층 실패 시 null → 기존 EventMatcher로 fallback
   */
  generate(
    ws: WorldState,
    locationId: string,
    intent: ParsedIntentV2,
    allEvents: EventDefV2[],
    incidentDefs: IncidentDef[],
    recentPrimaryNpcIds?: string[],
    discoveredFacts?: Set<string>,
  ): Situation | null {
    this._discoveredFacts = discoveredFacts;
    // Layer 1: Landmark Event (스토리 체크포인트)
    const landmark = this.tryLandmark(ws, locationId, allEvents);
    if (landmark) return landmark;

    // Layer 2: Incident-Driven (활성 사건 맥락)
    const incident = this.tryIncidentDriven(
      ws,
      locationId,
      intent,
      allEvents,
      incidentDefs,
    );
    if (incident) return incident;

    // Layer 3: World-State Situation (완전 동적)
    const worldState = this.tryWorldState(
      ws,
      locationId,
      intent,
      allEvents,
      recentPrimaryNpcIds,
      discoveredFacts,
    );
    if (worldState) return worldState;

    return null; // fallback to EventMatcher
  }

  // ─── Layer 1: Landmark ─────────────────────────────────────

  private tryLandmark(
    ws: WorldState,
    locationId: string,
    allEvents: EventDefV2[],
  ): Situation | null {
    // ARC_HINT 이벤트 중 조건 충족된 것
    const arcHints = allEvents.filter(
      (e) => e.eventType === 'ARC_HINT' && e.locationId === locationId,
    );

    for (const event of arcHints) {
      // stages 필터
      if (event.stages && event.stages.length > 0) {
        const currentStage = ws.mainArc?.stage?.toString() ?? '0';
        if (!event.stages.includes(currentStage)) continue;
      }
      // arcRouteTag 필터
      if (event.arcRouteTag && ws.mainArc?.activeArcId !== event.arcRouteTag)
        continue;

      return {
        trigger: 'LANDMARK',
        eventDef: event,
        primaryNpcId: event.payload.primaryNpcId,
        relatedFacts: [],
      };
    }

    return null;
  }

  // ─── Layer 2: Incident-Driven ──────────────────────────────

  private tryIncidentDriven(
    ws: WorldState,
    locationId: string,
    intent: ParsedIntentV2,
    allEvents: EventDefV2[],
    incidentDefs: IncidentDef[],
  ): Situation | null {
    if (!ws.activeIncidents || ws.activeIncidents.length === 0) return null;

    // 현재 장소와 관련된 활성 Incident 찾기
    for (const runtime of ws.activeIncidents) {
      if (runtime.resolved) continue;

      const def = incidentDefs.find((d) => d.incidentId === runtime.incidentId);
      if (!def) continue;
      if (def.locationId !== locationId) continue;

      // 이 Incident와 관련된 이벤트 찾기
      const relatedEvents = allEvents.filter(
        (e) =>
          e.locationId === locationId &&
          e.payload.tags.some(
            (t) =>
              def.incidentId.toLowerCase().includes(t.toLowerCase()) ||
              t.includes(runtime.incidentId),
          ),
      );

      if (relatedEvents.length > 0) {
        // 가장 높은 priority 이벤트 선택
        const best = relatedEvents.sort((a, b) => b.priority - a.priority)[0];

        // Incident 관련 NPC 찾기
        const presentNpcs =
          ws.locationDynamicStates?.[locationId]?.presentNpcs ?? [];
        const relatedNpcs = (def as Record<string, unknown>)[
          'relatedNpcIds'
        ] as string[] | undefined;
        const primaryNpc = relatedNpcs?.find((n) => presentNpcs.includes(n));

        // 관련 facts
        const facts = this.worldFact.findByTags(ws, [
          runtime.incidentId.toLowerCase(),
        ]);

        return {
          trigger: 'INCIDENT_DRIVEN',
          eventDef: best,
          primaryNpcId: primaryNpc ?? best.payload.primaryNpcId,
          relatedFacts: facts.map((f) => f.id),
        };
      }
    }

    return null;
  }

  // ─── Layer 3: World-State ──────────────────────────────────

  private tryWorldState(
    ws: WorldState,
    locationId: string,
    intent: ParsedIntentV2,
    allEvents: EventDefV2[],
    recentPrimaryNpcIds?: string[],
    _discoveredFacts?: Set<string>,
  ): Situation | null {
    const locState = ws.locationDynamicStates?.[locationId];
    const allPresentNpcs = locState?.presentNpcs ?? [];
    const conditions = locState?.activeConditions ?? [];
    const recentFacts = this.worldFact.findByLocation(ws, locationId);

    // NPC를 tier별로 분류 (CORE > SUB > BACKGROUND)
    const { coreNpcs, subNpcs, bgNpcs } =
      this.classifyNpcsByTier(allPresentNpcs);
    // 상호작용 대상은 CORE + SUB만 (BACKGROUND는 배경)
    // 같은 NPC 연속 3턴 방지: 최근 사용된 NPC를 뒤로 밀기
    const recentNpcs = new Set(recentPrimaryNpcIds?.slice(-2) ?? []);
    const sortByRecency = (npcs: string[]) =>
      [...npcs].sort(
        (a, b) => (recentNpcs.has(a) ? 1 : 0) - (recentNpcs.has(b) ? 1 : 0),
      );
    const interactableNpcs = sortByRecency([...coreNpcs, ...subNpcs]);

    // 우선순위 1: NPC_CONFLICT (CORE/SUB NPC 간 적대 쌍) — 항상 우선
    const conflict = this.detectNpcConflict(
      ws,
      interactableNpcs,
      locationId,
      allEvents,
    );
    if (conflict) return conflict;

    // 우선순위 2~4: 다양성을 위해 턴 번호 기반 로테이션
    // 매 턴 같은 CONSEQUENCE만 나오는 것을 방지
    const turnMod = ws.globalClock % 3;

    if (turnMod === 0) {
      // CONSEQUENCE 우선
      const consequence = this.detectConsequence(
        ws,
        locationId,
        interactableNpcs,
        recentFacts,
        allEvents,
      );
      if (consequence) return consequence;
    }

    // ENVIRONMENTAL (장소 조건 기반)
    if (conditions.length > 0) {
      const envSituation = this.buildEnvironmentalSituation(
        ws,
        locationId,
        conditions,
        allEvents,
      );
      if (envSituation) return envSituation;
    }

    // NPC_ACTIVITY (CORE 우선, 없으면 SUB)
    if (interactableNpcs.length > 0 && turnMod !== 2) {
      const primaryNpcs = coreNpcs.length > 0 ? coreNpcs : subNpcs;
      const activity = this.buildNpcActivitySituation(
        ws,
        locationId,
        primaryNpcs,
        allEvents,
        bgNpcs,
      );
      if (activity) return activity;
    }

    // turnMod 1,2에서 CONSEQUENCE fallback
    if (turnMod !== 0) {
      const consequence = this.detectConsequence(
        ws,
        locationId,
        interactableNpcs,
        recentFacts,
        allEvents,
      );
      if (consequence) return consequence;
    }

    // 마지막: NPC_ACTIVITY fallback
    if (interactableNpcs.length > 0) {
      const primaryNpcs = coreNpcs.length > 0 ? coreNpcs : subNpcs;
      const activity = this.buildNpcActivitySituation(
        ws,
        locationId,
        primaryNpcs,
        allEvents,
        bgNpcs,
      );
      if (activity) return activity;
    }

    // ROUTINE fallback 제거 — SituationGenerator에서 의미 있는 상황만 생성하고,
    // 나머지는 EventDirector의 112개 고정 이벤트 라이브러리에 위임한다.
    return null;
  }

  private detectNpcConflict(
    ws: WorldState,
    presentNpcs: string[],
    locationId: string,
    allEvents: EventDefV2[],
  ): Situation | null {
    if (presentNpcs.length < 2) return null;

    // 서로 다른 faction의 NPC 쌍 찾기
    for (let i = 0; i < presentNpcs.length; i++) {
      for (let j = i + 1; j < presentNpcs.length; j++) {
        const npcA = this.content.getNpc(presentNpcs[i]);
        const npcB = this.content.getNpc(presentNpcs[j]);
        if (!npcA || !npcB) continue;
        if (npcA.faction && npcB.faction && npcA.faction !== npcB.faction) {
          // P3: ENCOUNTER 타입 이벤트를 템플릿으로 사용 (미발견 fact 우선)
          const template = this.findTemplatePreferFact(allEvents, locationId, [
            'ENCOUNTER',
          ]);
          if (!template) continue;

          const sceneFrame = `${npcA.name}과(와) ${npcB.name}이(가) ${locationId.replace('LOC_', '').toLowerCase()}에서 마주치고 있다. 긴장감이 감돈다.`;

          return {
            trigger: 'NPC_CONFLICT',
            eventDef: {
              ...template,
              eventId: `SIT_CONFLICT_${presentNpcs[i]}_${presentNpcs[j]}`,
              payload: {
                ...template.payload,
                sceneFrame,
                primaryNpcId: presentNpcs[i],
              },
            },
            primaryNpcId: presentNpcs[i],
            secondaryNpcId: presentNpcs[j],
            relatedFacts: [],
          };
        }
      }
    }
    return null;
  }

  private detectConsequence(
    ws: WorldState,
    locationId: string,
    presentNpcs: string[],
    recentFacts: WorldFact[],
    allEvents: EventDefV2[],
  ): Situation | null {
    // 최근 PLAYER_ACTION fact 중 NPC가 현재 장소에 있고, 해당 NPC가 fact를 아는 경우
    // 이미 CONSEQUENCE로 사용된 fact는 제외 (같은 fact에서 반복 생성 방지)
    const usedFactIds = new Set(
      ((ws as unknown as Record<string, unknown>)
        ._consequenceUsedFacts as string[]) ?? [],
    );
    for (const fact of recentFacts.slice(-5)) {
      if (fact.category !== 'PLAYER_ACTION') continue;
      if (usedFactIds.has(fact.id)) continue; // 이미 사용된 fact 스킵
      if (!fact.impact?.npcKnowledge) continue;

      for (const npcId of presentNpcs) {
        if (fact.impact.npcKnowledge[npcId]) {
          // 이 NPC가 플레이어의 행동을 알고 있음 → 반응 상황
          const npcDef = this.content.getNpc(npcId);
          if (!npcDef) continue;

          // P3: 미발견 fact 이벤트 우선 template
          const template = this.findTemplatePreferFact(allEvents, locationId, [
            'ENCOUNTER',
            'OPPORTUNITY',
          ]);
          if (!template) continue;

          const npcLabel = npcDef.unknownAlias || npcDef.name;
          const sceneFrame = `${npcLabel}이(가) 근처에 있다. 그의 태도에서 무언가 달라진 기색이 감지된다.`;

          return {
            trigger: 'CONSEQUENCE',
            eventDef: {
              ...template,
              eventId: `SIT_CONSEQUENCE_${fact.id}`,
              payload: {
                ...template.payload,
                sceneFrame,
                primaryNpcId: npcId,
              },
            },
            primaryNpcId: npcId,
            relatedFacts: [fact.id],
          };
        }
      }
    }
    return null;
  }

  private buildEnvironmentalSituation(
    ws: WorldState,
    locationId: string,
    conditions: Array<{
      id: string;
      source: string;
      effects: Record<string, unknown>;
    }>,
    allEvents: EventDefV2[],
  ): Situation | null {
    const condition = conditions[0]; // 첫 번째 활성 조건
    // P3: 미발견 fact 이벤트 우선 template
    const template = this.findTemplatePreferFact(allEvents, locationId, [
      'ENCOUNTER',
    ]);
    if (!template) return null;

    const conditionDescriptions: Record<string, string> = {
      CURFEW:
        '야간통행금지가 선포되어 거리가 텅 비어 있다. 순찰대의 횃불만이 움직인다.',
      LOCKDOWN:
        '경비대가 지역을 봉쇄했다. 검문소가 세워지고 모든 출입이 통제된다.',
      FESTIVAL:
        '축제 분위기가 거리를 감싸고 있다. 음악과 웃음소리가 울려퍼진다.',
      BLACK_MARKET: '어둠 속에서 은밀한 거래의 기척이 느껴진다.',
      RAID_AFTERMATH:
        '최근 급습의 흔적이 남아있다. 부서진 상자와 흩어진 물건들.',
    };

    const sceneFrame =
      conditionDescriptions[condition.id] ??
      `${condition.id} 상태가 이 장소에 영향을 미치고 있다.`;

    return {
      trigger: 'ENVIRONMENTAL',
      eventDef: {
        ...template,
        eventId: `SIT_ENV_${condition.id}_${locationId}`,
        payload: { ...template.payload, sceneFrame },
      },
      relatedFacts: [],
    };
  }

  private buildNpcActivitySituation(
    ws: WorldState,
    locationId: string,
    primaryNpcs: string[],
    allEvents: EventDefV2[],
    bgNpcs: string[] = [],
  ): Situation | null {
    // 첫 번째 CORE/SUB NPC의 활동 기반 상황
    const npcId = primaryNpcs[0];
    const npcDef = this.content.getNpc(npcId);
    if (!npcDef) return null;

    const schedule = npcDef.schedule;
    const currentActivity =
      schedule?.default[ws.phaseV2]?.activity ?? '무언가를 하고 있다';

    // P3: 미발견 fact 이벤트 우선 template
    const template = this.findTemplatePreferFact(allEvents, locationId, [
      'ENCOUNTER',
      'FALLBACK',
    ]);
    if (!template) return null;

    // 배경 NPC가 있으면 장면에 생동감 추가
    let bgDescription = '';
    if (bgNpcs.length > 0) {
      const bgNames = bgNpcs.slice(0, 2).map((id) => {
        const def = this.content.getNpc(id);
        return def?.unknownAlias ?? def?.role ?? '누군가';
      });
      bgDescription = ` 주변에서 ${bgNames.join('과(와) ')}이(가) 각자의 일에 몰두하고 있다.`;
    }

    const npcLabel = npcDef.unknownAlias || npcDef.name;
    const sceneFrame = `${npcLabel}이(가) ${currentActivity}.${bgDescription}`;

    const npcFacts = this.worldFact.findByNpc(ws, npcId);

    return {
      trigger: 'NPC_ACTIVITY',
      eventDef: {
        ...template,
        eventId: `SIT_ACTIVITY_${npcId}_${ws.globalClock}`,
        payload: {
          ...template.payload,
          sceneFrame,
          primaryNpcId: npcId,
        },
      },
      primaryNpcId: npcId,
      relatedFacts: npcFacts.slice(-3).map((f) => f.id),
    };
  }

  /** P3: 미발견 discoverableFact가 있는 이벤트를 우선 선택하는 template finder */
  private findTemplatePreferFact(
    allEvents: EventDefV2[],
    locationId: string,
    eventTypes: string[],
  ): EventDefV2 | undefined {
    const candidates = allEvents.filter(
      (e) => e.locationId === locationId && eventTypes.includes(e.eventType),
    );
    if (candidates.length === 0) return undefined;
    // 미발견 fact가 있는 이벤트 우선
    if (this._discoveredFacts) {
      const factEvent = candidates.find((e) => {
        const df = (e as unknown as Record<string, unknown>)
          .discoverableFact as string | undefined;
        return df && !this._discoveredFacts!.has(df);
      });
      if (factEvent) return factEvent;
    }
    return candidates[0];
  }

  /** NPC를 tier별로 분류 */
  private classifyNpcsByTier(npcIds: string[]): {
    coreNpcs: string[];
    subNpcs: string[];
    bgNpcs: string[];
  } {
    const coreNpcs: string[] = [];
    const subNpcs: string[] = [];
    const bgNpcs: string[] = [];

    for (const npcId of npcIds) {
      const def = this.content.getNpc(npcId);
      const tier = def?.tier ?? 'SUB';
      switch (tier) {
        case 'CORE':
          coreNpcs.push(npcId);
          break;
        case 'BACKGROUND':
          bgNpcs.push(npcId);
          break;
        default:
          subNpcs.push(npcId);
          break;
      }
    }

    return { coreNpcs, subNpcs, bgNpcs };
  }

  private buildRoutineSituation(
    locationId: string,
    allEvents: EventDefV2[],
  ): Situation | null {
    // FALLBACK 이벤트 사용
    const fallback = allEvents.find(
      (e) => e.locationId === locationId && e.eventType === 'FALLBACK',
    );
    if (!fallback) return null;

    return {
      trigger: 'ROUTINE',
      eventDef: fallback,
      relatedFacts: [],
    };
  }
}
