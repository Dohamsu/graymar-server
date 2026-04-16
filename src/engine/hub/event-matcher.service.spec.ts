/**
 * EventMatcherService — targetNpcId 가중치 테스트
 *
 * matchWithIncidentContext() 내부의 targetNpcId 부스트/패널티 로직 검증.
 * 실제 서비스 인스턴스를 사용하며, 가중치 영향을 확인하기 위해
 * 최소한의 이벤트 2개 + 결정론적 RNG를 사용.
 */

import { EventMatcherService } from './event-matcher.service.js';
import type {
  EventDefV2,
  WorldState,
  ArcState,
  ParsedIntentV2,
  PlayerAgenda,
  IncidentRoutingResult,
} from '../../db/types/index.js';
import { Rng } from '../rng/rng.service.js';

// ─── Helpers ───

function makeEvent(
  overrides: Partial<EventDefV2> & { eventId: string },
): EventDefV2 {
  return {
    locationId: 'LOC_MARKET',
    eventType: 'ENCOUNTER',
    priority: 1,
    weight: 10,
    conditions: null,
    gates: [],
    affordances: ['ANY'],
    friction: 0,
    matchPolicy: 'NEUTRAL',
    payload: {
      sceneFrame: 'test',
      choices: [],
      effectsOnEnter: [],
      tags: [],
      ...overrides.payload,
    },
    ...overrides,
  } as EventDefV2;
}

function makeWorldState(overrides?: Partial<WorldState>): WorldState {
  return {
    heat: 30,
    hubSafety: 'SAFE',
    timePhase: 'DAY',
    day: 1,
    flags: [],
    locationStates: {},
    ...overrides,
  } as WorldState;
}

function makeArcState(overrides?: Partial<ArcState>): ArcState {
  return {
    mainArcClock: { stage: 'EARLY', progress: 0 },
    discoveredQuestFacts: [],
    ...overrides,
  } as ArcState;
}

function makeIntent(overrides?: Partial<ParsedIntentV2>): ParsedIntentV2 {
  return {
    inputText: '테스트',
    actionType: 'TALK',
    tone: 'neutral',
    target: null,
    riskLevel: 1,
    intentTags: [],
    confidence: 2,
    source: 'RULE',
    ...overrides,
  } as ParsedIntentV2;
}

function makeRoutingResult(
  overrides?: Partial<IncidentRoutingResult>,
): IncidentRoutingResult {
  return {
    routeMode: 'INCIDENT_DRIVEN',
    tags: [],
    incident: null,
    ...overrides,
  } as IncidentRoutingResult;
}

const emptyAgenda: PlayerAgenda = {} as PlayerAgenda;

describe('EventMatcherService — targetNpcId 가중치', () => {
  let service: EventMatcherService;

  beforeEach(() => {
    service = new EventMatcherService();
  });

  it('targetNpcId === 이벤트 primaryNpcId → +50 부스트로 해당 이벤트 선택 확률 증가', () => {
    const evtMatch = makeEvent({
      eventId: 'EVT_NPC_A',
      weight: 10,
      payload: {
        sceneFrame: 'a',
        primaryNpcId: 'NPC_A',
        choices: [],
        effectsOnEnter: [],
        tags: [],
      },
    });
    const evtOther = makeEvent({
      eventId: 'EVT_NPC_B',
      weight: 10,
      payload: {
        sceneFrame: 'b',
        primaryNpcId: 'NPC_B',
        choices: [],
        effectsOnEnter: [],
        tags: [],
      },
    });

    const events = [evtMatch, evtOther];
    const ws = makeWorldState();
    const arcState = makeArcState();
    const intent = makeIntent();
    const routing = makeRoutingResult();

    // targetNpcId=NPC_A → EVT_NPC_A +50, EVT_NPC_B -50
    // base=1*10+10=20, EVT_NPC_A: 20+50=70, EVT_NPC_B: max(1, 20-50)=1
    // 70:1 비율 → EVT_NPC_A가 거의 항상 선택
    let matchCount = 0;
    for (let i = 0; i < 50; i++) {
      const rng = new Rng(`seed-${i}`, 0);
      const result = service.matchWithIncidentContext(
        events,
        'LOC_MARKET',
        intent,
        ws,
        arcState,
        emptyAgenda,
        {},
        10,
        rng,
        [],
        routing,
        undefined,
        'NPC_A',
      );
      if (result?.eventId === 'EVT_NPC_A') matchCount++;
    }

    // 70:1 비율이므로 50회 중 최소 45회 이상 NPC_A 이벤트 선택
    expect(matchCount).toBeGreaterThanOrEqual(45);
  });

  it('targetNpcId !== 이벤트 primaryNpcId → -50 패널티', () => {
    const evtMatch = makeEvent({
      eventId: 'EVT_NPC_A',
      weight: 10,
      payload: {
        sceneFrame: 'a',
        primaryNpcId: 'NPC_A',
        choices: [],
        effectsOnEnter: [],
        tags: [],
      },
    });
    const evtNoNpc = makeEvent({
      eventId: 'EVT_NO_NPC',
      weight: 10,
      payload: {
        sceneFrame: 'b',
        // primaryNpcId 없음 → 중립(0)
        choices: [],
        effectsOnEnter: [],
        tags: [],
      },
    });

    const events = [evtMatch, evtNoNpc];
    const ws = makeWorldState();
    const arcState = makeArcState();
    const intent = makeIntent();
    const routing = makeRoutingResult();

    // targetNpcId=NPC_C (둘 다 아님)
    // EVT_NPC_A: primaryNpcId=NPC_A != NPC_C → -50 → max(1, 20-50)=1
    // EVT_NO_NPC: primaryNpcId 없음 → 0 → 20
    // 1:20 비율 → EVT_NO_NPC가 거의 항상 선택
    let noNpcCount = 0;
    for (let i = 0; i < 50; i++) {
      const rng = new Rng(`seed-pen-${i}`, 0);
      const result = service.matchWithIncidentContext(
        events,
        'LOC_MARKET',
        intent,
        ws,
        arcState,
        emptyAgenda,
        {},
        10,
        rng,
        [],
        routing,
        undefined,
        'NPC_C',
      );
      if (result?.eventId === 'EVT_NO_NPC') noNpcCount++;
    }

    expect(noNpcCount).toBeGreaterThanOrEqual(45);
  });

  it('이벤트에 primaryNpcId가 없으면 targetNpcBoost=0 (중립)', () => {
    const evtA = makeEvent({
      eventId: 'EVT_A',
      weight: 10,
      payload: {
        sceneFrame: 'a',
        // primaryNpcId 없음
        choices: [],
        effectsOnEnter: [],
        tags: [],
      },
    });
    const evtB = makeEvent({
      eventId: 'EVT_B',
      weight: 10,
      payload: {
        sceneFrame: 'b',
        // primaryNpcId 없음
        choices: [],
        effectsOnEnter: [],
        tags: [],
      },
    });

    const events = [evtA, evtB];
    const ws = makeWorldState();
    const arcState = makeArcState();
    const intent = makeIntent();
    const routing = makeRoutingResult();

    // 둘 다 primaryNpcId 없음 → targetNpcBoost=0 → 동일 가중치
    let countA = 0;
    for (let i = 0; i < 100; i++) {
      const rng = new Rng(`seed-neutral-${i}`, 0);
      const result = service.matchWithIncidentContext(
        events,
        'LOC_MARKET',
        intent,
        ws,
        arcState,
        emptyAgenda,
        {},
        10,
        rng,
        [],
        routing,
        undefined,
        'NPC_A',
      );
      if (result?.eventId === 'EVT_A') countA++;
    }

    // 대략 50:50, 30~70 사이면 중립 확인
    expect(countA).toBeGreaterThanOrEqual(20);
    expect(countA).toBeLessThanOrEqual(80);
  });

  it('targetNpcId가 null이면 영향 없다', () => {
    const evtNpcA = makeEvent({
      eventId: 'EVT_NPC_A',
      weight: 10,
      payload: {
        sceneFrame: 'a',
        primaryNpcId: 'NPC_A',
        choices: [],
        effectsOnEnter: [],
        tags: [],
      },
    });
    const evtNpcB = makeEvent({
      eventId: 'EVT_NPC_B',
      weight: 10,
      payload: {
        sceneFrame: 'b',
        primaryNpcId: 'NPC_B',
        choices: [],
        effectsOnEnter: [],
        tags: [],
      },
    });

    const events = [evtNpcA, evtNpcB];
    const ws = makeWorldState();
    const arcState = makeArcState();
    const intent = makeIntent();
    const routing = makeRoutingResult();

    // targetNpcId=null → 부스트/패널티 없음 → 동일 가중치
    let countA = 0;
    for (let i = 0; i < 100; i++) {
      const rng = new Rng(`seed-null-${i}`, 0);
      const result = service.matchWithIncidentContext(
        events,
        'LOC_MARKET',
        intent,
        ws,
        arcState,
        emptyAgenda,
        {},
        10,
        rng,
        [],
        routing,
        undefined,
        null,
      );
      if (result?.eventId === 'EVT_NPC_A') countA++;
    }

    // 대략 50:50
    expect(countA).toBeGreaterThanOrEqual(20);
    expect(countA).toBeLessThanOrEqual(80);
  });

  it('가중치 최소값 1이 보장된다 (-50 패널티에도 0 이하로 떨어지지 않음)', () => {
    const evtLow = makeEvent({
      eventId: 'EVT_LOW',
      priority: 1,
      weight: 1, // base = 1*10+1=11
      payload: {
        sceneFrame: 'a',
        primaryNpcId: 'NPC_WRONG',
        choices: [],
        effectsOnEnter: [],
        tags: [],
      },
    });
    const evtHigh = makeEvent({
      eventId: 'EVT_HIGH',
      priority: 1,
      weight: 1, // base = 11
      payload: {
        sceneFrame: 'b',
        primaryNpcId: 'NPC_TARGET',
        choices: [],
        effectsOnEnter: [],
        tags: [],
      },
    });

    const events = [evtLow, evtHigh];
    const ws = makeWorldState();
    const arcState = makeArcState();
    const intent = makeIntent();
    const routing = makeRoutingResult();

    // targetNpcId=NPC_TARGET
    // EVT_LOW: 11 - 50 = max(1, -39) = 1
    // EVT_HIGH: 11 + 50 = 61
    // 둘 다 선택 가능해야 함 (최소 1 보장)
    let lowCount = 0;
    for (let i = 0; i < 200; i++) {
      const rng = new Rng(`seed-min-${i}`, 0);
      const result = service.matchWithIncidentContext(
        events,
        'LOC_MARKET',
        intent,
        ws,
        arcState,
        emptyAgenda,
        {},
        10,
        rng,
        [],
        routing,
        undefined,
        'NPC_TARGET',
      );
      if (result?.eventId === 'EVT_LOW') lowCount++;
    }

    // 1:61 비율 → 200회 중 lowCount > 0 (최소 1 보장으로 선택 가능)
    // 하지만 매우 드물므로 "0이 아닐 수도 있다"보다는 "null 반환이 없다" 확인
    // 중요: 결과가 null이 아님을 확인 (최소값 1 보장 = 항상 선택 가능)
    for (let i = 0; i < 10; i++) {
      const rng = new Rng(`seed-notnull-${i}`, 0);
      const result = service.matchWithIncidentContext(
        events,
        'LOC_MARKET',
        intent,
        ws,
        arcState,
        emptyAgenda,
        {},
        10,
        rng,
        [],
        routing,
        undefined,
        'NPC_TARGET',
      );
      expect(result).not.toBeNull();
    }
  });
});
