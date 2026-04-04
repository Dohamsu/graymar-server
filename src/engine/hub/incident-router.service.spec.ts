import { IncidentRouterService } from './incident-router.service.js';
import type {
  WorldState,
  IncidentRuntime,
  IncidentDef,
  ParsedIntentV3,
  IncidentVectorState,
} from '../../db/types/index.js';

function makeIntentV3(overrides: Partial<ParsedIntentV3> = {}): ParsedIntentV3 {
  return {
    version: 3,
    rawInput: '테스트',
    primaryActionType: 'TALK',
    tone: 'NEUTRAL',
    goalCategory: 'GET_INFO',
    goalText: '정보를 얻는다',
    approachVector: 'SOCIAL',
    riskLevel: 1,
    confidence: 2,
    source: 'RULE',
    intentTags: [],
    ...overrides,
  };
}

function makeIncident(
  overrides: Partial<IncidentRuntime> = {},
): IncidentRuntime {
  return {
    incidentId: 'inc_test',
    kind: 'POLITICAL',
    stage: 1,
    control: 30,
    pressure: 40,
    deadlineClock: 100,
    spawnedAtClock: 10,
    resolved: false,
    historyLog: [],
    suspicion: 0,
    security: 10,
    playerProgress: 0,
    rivalProgress: 0,
    vectors: [
      {
        vector: 'SOCIAL',
        enabled: true,
        preferred: true,
        friction: 0,
        effectivenessBase: 0.8,
        failForwardMode: 'HEAT',
      },
      {
        vector: 'OBSERVATIONAL',
        enabled: true,
        preferred: false,
        friction: 1,
        effectivenessBase: 0.5,
        failForwardMode: 'SUSPICION',
      },
    ],
    mutationFlags: [],
    ...overrides,
  };
}

function makeDef(overrides: Partial<IncidentDef> = {}): IncidentDef {
  return {
    incidentId: 'inc_test',
    kind: 'POLITICAL',
    title: '테스트 사건',
    description: '테스트',
    locationId: 'market',
    priority: 3,
    weight: 10,
    spawnConditions: {},
    stages: [
      {
        stage: 1,
        description: '1단계',
        affordances: ['ANY'],
        matchPolicy: 'SUPPORT',
        pressurePerTick: 2,
        controlReward: 10,
        controlPenalty: 5,
        sceneFrame: '긴장',
        choices: [],
      },
    ],
    signalTemplates: [],
    resolutionConditions: {
      controlThreshold: 80,
      pressureThreshold: 95,
      deadlineTicks: 50,
    },
    impactOnResolve: {
      CONTAINED: {
        heatDelta: -5,
        tensionDelta: -2,
        reputationChanges: {},
        flagsSet: [],
      },
      ESCALATED: {
        heatDelta: 10,
        tensionDelta: 5,
        reputationChanges: {},
        flagsSet: [],
      },
      EXPIRED: {
        heatDelta: 3,
        tensionDelta: 1,
        reputationChanges: {},
        flagsSet: [],
      },
    },
    relatedNpcIds: ['npc_elder'],
    tags: ['corruption'],
    isCritical: false,
    ...overrides,
  };
}

function makeWs(incidents: IncidentRuntime[] = []): WorldState {
  return {
    hubHeat: 30,
    hubSafety: 'SAFE',
    timePhase: 'DAY',
    currentLocationId: 'market',
    globalClock: 20,
    day: 2,
    flags: {},
    reputation: {},
    tension: 3,
    combatWindowCount: 0,
    deferredEffects: [],
    mainArc: { committedRoute: null, unlockedArcIds: [] },
    activeIncidents: incidents,
    signalFeed: [],
    narrativeMarks: [],
    mainArcClock: { deadlineTick: 200 },
  } as unknown as WorldState;
}

describe('IncidentRouterService', () => {
  let service: IncidentRouterService;

  beforeEach(() => {
    service = new IncidentRouterService();
  });

  it('incident 없으면 FALLBACK_SCENE 반환', () => {
    const ws = makeWs([]);
    const result = service.route(ws, 'market', makeIntentV3(), []);
    expect(result.routeMode).toBe('FALLBACK_SCENE');
    expect(result.incident).toBeNull();
    expect(result.matchScore).toBe(0);
  });

  it('resolved incident는 무시', () => {
    const incident = makeIncident({ resolved: true });
    const ws = makeWs([incident]);
    const result = service.route(ws, 'market', makeIntentV3(), [makeDef()]);
    expect(result.routeMode).toBe('FALLBACK_SCENE');
  });

  it('SOCIAL vector 매칭 → DIRECT_MATCH', () => {
    const incident = makeIncident();
    const ws = makeWs([incident]);
    const result = service.route(
      ws,
      'market',
      makeIntentV3({ approachVector: 'SOCIAL' }),
      [makeDef()],
    );
    expect(result.routeMode).toBe('DIRECT_MATCH');
    expect(result.matchedVector).toBe('SOCIAL');
    expect(result.matchScore).toBeGreaterThanOrEqual(40);
  });

  it('preferred vector는 추가 점수', () => {
    const incident = makeIncident();
    const ws = makeWs([incident]);
    const resultPreferred = service.route(
      ws,
      'market',
      makeIntentV3({ approachVector: 'SOCIAL' }),
      [makeDef()],
    );
    const resultNonPref = service.route(
      ws,
      'market',
      makeIntentV3({ approachVector: 'OBSERVATIONAL' }),
      [makeDef()],
    );
    expect(resultPreferred.matchScore).toBeGreaterThan(
      resultNonPref.matchScore,
    );
  });

  it('매칭 안 되는 vector → GOAL_AFFINITY 또는 FALLBACK', () => {
    const incident = makeIncident();
    const ws = makeWs([incident]);
    const result = service.route(
      ws,
      'market',
      makeIntentV3({
        approachVector: 'VIOLENT',
        goalCategory: 'ESCALATE_CONFLICT',
      }),
      [makeDef()],
    );
    // POLITICAL kind + ESCALATE_CONFLICT = 10 affinity + 10 location = 20 > threshold
    expect(result.routeMode).toBe('GOAL_AFFINITY');
    expect(result.incident?.incidentId).toBe('inc_test');
  });

  it('location 일치 시 가산', () => {
    const incident = makeIncident({ vectors: [] });
    const def = makeDef({ locationId: 'market' });
    const ws = makeWs([incident]);
    const resultMatch = service.route(
      ws,
      'market',
      makeIntentV3({
        approachVector: 'VIOLENT',
        goalCategory: 'SHIFT_RELATION',
      }),
      [def],
    );
    // POLITICAL + SHIFT_RELATION = 20 + location 10 = 30 > threshold
    expect(resultMatch.matchScore).toBeGreaterThanOrEqual(
      MATCH_THRESHOLD_VALUE(),
    );
  });

  it('pressure >= 80이면 추가 점수', () => {
    const lowPressure = makeIncident({ pressure: 40, vectors: [] });
    const highPressure = makeIncident({
      incidentId: 'inc_urgent',
      pressure: 85,
      vectors: [],
    });
    const defs = [makeDef(), makeDef({ incidentId: 'inc_urgent' })];
    const ws = makeWs([lowPressure, highPressure]);
    const result = service.route(
      ws,
      'market',
      makeIntentV3({
        approachVector: 'VIOLENT',
        goalCategory: 'SHIFT_RELATION',
      }),
      defs,
    );
    expect(result.incident?.incidentId).toBe('inc_urgent');
  });

  it('tags에 incident/kind/npc 태그 포함', () => {
    const incident = makeIncident();
    const ws = makeWs([incident]);
    const result = service.route(
      ws,
      'market',
      makeIntentV3({ approachVector: 'SOCIAL' }),
      [makeDef()],
    );
    expect(result.tags).toContain('incident:inc_test');
    expect(result.tags).toContain('kind:POLITICAL');
    expect(result.tags).toContain('npc:npc_elder');
    expect(result.tags).toContain('corruption');
  });

  it('secondary vector도 점수에 반영', () => {
    const incident = makeIncident();
    const ws = makeWs([incident]);
    const result = service.route(
      ws,
      'market',
      makeIntentV3({
        approachVector: 'VIOLENT',
        secondaryApproachVector: 'SOCIAL',
      }),
      [makeDef()],
    );
    // secondary SOCIAL 매칭으로 DIRECT_MATCH
    expect(result.routeMode).toBe('DIRECT_MATCH');
    expect(result.matchedVector).toBe('SOCIAL');
  });

  it('score < threshold → FALLBACK_SCENE', () => {
    const incident = makeIncident({ vectors: [] });
    const def = makeDef({ locationId: 'harbor' }); // location 불일치
    const ws = makeWs([incident]);
    // VIOLENT + GET_INFO + POLITICAL = 0 affinity, location mismatch = 0
    const result = service.route(
      ws,
      'market',
      makeIntentV3({
        approachVector: 'VIOLENT',
        goalCategory: 'ACQUIRE_RESOURCE',
      }),
      [def],
    );
    expect(result.routeMode).toBe('FALLBACK_SCENE');
  });
});

// threshold 값을 테스트에서 참조
function MATCH_THRESHOLD_VALUE() {
  return 15;
}
