import { EventDirectorService } from './event-director.service.js';
import { EventMatcherService } from './event-matcher.service.js';
import type {
  EventDefV2,
  WorldState,
  ArcState,
  ParsedIntentV2,
  PlayerAgenda,
  IncidentRoutingResult,
} from '../../db/types/index.js';

describe('EventDirectorService', () => {
  let director: EventDirectorService;
  let matcher: EventMatcherService;

  const baseWs: WorldState = {
    currentLocationId: 'LOC_MARKET',
    timePhase: 'DAY',
    timeCounter: 0,
    hubHeat: 20,
    hubSafety: 'SAFE',
    hubHeatReasons: [],
    tension: 3,
    mainArc: { stage: 1, unlockedArcIds: [], completedArcIds: [] },
    reputation: {},
    flags: {},
    deferredEffects: [],
    combatWindowCount: 0,
    combatWindowStart: 0,
    locationStates: {},
    globalClock: 10,
    day: 1,
    phaseV2: 'DAY',
    activeIncidents: [],
    npcGoals: {},
    signalFeed: [],
    narrativeMarks: [],
    mainArcClock: { startDay: 1, softDeadlineDay: 30, triggered: false },
    operationSession: null,
  };

  const baseArcState: ArcState = {
    currentRoute: null,
    commitment: 0,
    routeHistory: [],
  } as any;
  const baseAgenda: PlayerAgenda = { dominant: 'neutral', implicit: {} } as any;
  const baseIntent: ParsedIntentV2 = {
    actionType: 'INVESTIGATE',
    rawInput: '조사한다',
    tone: 'NEUTRAL',
  } as any;

  function makeEvent(
    overrides: Partial<EventDefV2> & {
      stages?: string[];
      eventCategory?: string;
    } = {},
  ): EventDefV2 {
    return {
      eventId: 'EVT_TEST',
      locationId: 'LOC_MARKET',
      eventType: 'ENCOUNTER',
      priority: 5,
      weight: 50,
      conditions: null,
      gates: [],
      affordances: ['INVESTIGATE', 'ANY'],
      friction: 0,
      matchPolicy: 'SUPPORT',
      payload: {
        sceneFrame: 'test',
        primaryNpcId: null,
        choices: [],
        effectsOnEnter: [],
        tags: [],
      },
      ...overrides,
    } as EventDefV2;
  }

  const fakeRng = {
    next: () => 0.5,
    chance: () => false,
    nextInt: () => 1,
  } as any;

  beforeEach(() => {
    matcher = new EventMatcherService();
    director = new EventDirectorService(matcher);
  });

  it('기본 선택: 이벤트가 정상 반환됨', () => {
    const events = [makeEvent()];
    const result = director.select(
      events,
      'LOC_MARKET',
      baseIntent,
      baseWs,
      baseArcState,
      baseAgenda,
      {},
      1,
      fakeRng,
      [],
      null,
    );
    expect(result.selectedEvent).not.toBeNull();
    expect(result.selectedEvent!.eventId).toBe('EVT_TEST');
    expect(result.filterLog.length).toBeGreaterThan(0);
  });

  it('stage 필터: 불일치 stage 이벤트 제외', () => {
    const events = [
      makeEvent({ eventId: 'EVT_WRONG_STAGE', stages: ['3'] }),
      makeEvent({ eventId: 'EVT_RIGHT_STAGE', stages: ['1'] }),
    ];
    // baseWs.mainArc.stage = 1 → '1' 매칭
    const result = director.select(
      events,
      'LOC_MARKET',
      baseIntent,
      baseWs,
      baseArcState,
      baseAgenda,
      {},
      1,
      fakeRng,
      [],
      null,
    );
    if (result.selectedEvent) {
      expect(result.selectedEvent.eventId).toBe('EVT_RIGHT_STAGE');
    }
  });

  it('stage null 이벤트는 항상 통과', () => {
    const events = [
      makeEvent({ eventId: 'EVT_NO_STAGE' }), // stages 없음 → 통과
    ];
    const result = director.select(
      events,
      'LOC_MARKET',
      baseIntent,
      baseWs,
      baseArcState,
      baseAgenda,
      {},
      1,
      fakeRng,
      [],
      null,
    );
    expect(result.selectedEvent).not.toBeNull();
  });

  it('priority 리매핑: eventCategory가 있는 이벤트의 weight 변경', () => {
    const events = [
      makeEvent({
        eventId: 'EVT_HIGH',
        priority: 8,
        weight: 10,
        eventCategory: 'conflict',
      }),
    ];
    const result = director.select(
      events,
      'LOC_MARKET',
      baseIntent,
      baseWs,
      baseArcState,
      baseAgenda,
      {},
      1,
      fakeRng,
      [],
      null,
    );
    expect(result.selectedEvent).not.toBeNull();
  });

  it('이벤트 없음 → null 반환', () => {
    const result = director.select(
      [],
      'LOC_MARKET',
      baseIntent,
      baseWs,
      baseArcState,
      baseAgenda,
      {},
      1,
      fakeRng,
      [],
      null,
    );
    expect(result.selectedEvent).toBeNull();
    expect(result.candidateCount).toBe(0);
  });

  it('EventMatcher 위임: routingResult 전달', () => {
    const events = [makeEvent()];
    const routing: IncidentRoutingResult = {
      routeMode: 'INCIDENT_LINK',
      incident: null,
      tags: ['GOSSIP'],
      matchScore: 0.5,
      matchedVector: 'test',
    } as any;
    const result = director.select(
      events,
      'LOC_MARKET',
      baseIntent,
      baseWs,
      baseArcState,
      baseAgenda,
      {},
      1,
      fakeRng,
      [],
      routing,
    );
    expect(result.selectedEvent).not.toBeNull();
  });

  it('filterLog에 디버깅 출력 포함', () => {
    const events = [makeEvent()];
    const result = director.select(
      events,
      'LOC_MARKET',
      baseIntent,
      baseWs,
      baseArcState,
      baseAgenda,
      {},
      1,
      fakeRng,
      [],
      null,
    );
    expect(result.filterLog.some((log) => log.includes('리매핑'))).toBe(true);
    expect(result.filterLog.some((log) => log.includes('최종 후보'))).toBe(
      true,
    );
  });
});
