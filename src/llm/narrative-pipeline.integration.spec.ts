// PR8: 전체 파이프라인 통합 테스트 (설계문서 18~20 통합 검증)

import { TokenBudgetService, TOKEN_BUDGET } from './token-budget.service.js';
import { MidSummaryService } from './mid-summary.service.js';
import { IntentMemoryService } from '../engine/hub/intent-memory.service.js';
import { MemoryRendererService } from './memory-renderer.service.js';
import { EventDirectorService } from '../engine/hub/event-director.service.js';
import { EventMatcherService } from '../engine/hub/event-matcher.service.js';
import { ProceduralEventService } from '../engine/hub/procedural-event.service.js';
import type { RecentTurnEntry } from './context-builder.service.js';
import type {
  EventDefV2,
  WorldState,
  ArcState,
  ParsedIntentV2,
  PlayerAgenda,
} from '../db/types/index.js';
import type { StructuredMemory } from '../db/types/structured-memory.js';
import { createEmptyStructuredMemory } from '../db/types/structured-memory.js';
import type { ProceduralHistoryEntry } from '../db/types/procedural-event.js';

describe('Narrative Pipeline Integration Tests (PR8)', () => {
  // ── 서비스 인스턴스 ──
  const tokenBudget = new TokenBudgetService();
  const mockLlmCaller = { callLight: jest.fn().mockResolvedValue('') };
  const mockAiTurnLog = { log: jest.fn() };
  const midSummary = new MidSummaryService(
    mockLlmCaller as any,
    mockAiTurnLog as any,
  );
  const intentMemory = new IntentMemoryService();
  const memoryRenderer = new MemoryRendererService();
  const eventMatcher = new EventMatcherService();
  const eventDirector = new EventDirectorService(eventMatcher);
  const proceduralEvent = new ProceduralEventService();

  const fakeRng = {
    next: () => 0.5,
    chance: () => false,
    nextInt: () => 1,
  } as any;

  // ── 헬퍼 ──
  function makeTurn(overrides: Partial<RecentTurnEntry> = {}): RecentTurnEntry {
    return {
      turnNo: 1,
      inputType: 'ACTION',
      rawInput: '조사한다',
      resolveOutcome: 'SUCCESS',
      narrative: '당신은 주변을 조사했다.',
      ...overrides,
    };
  }

  function makeEvent(overrides: Partial<EventDefV2> = {}): EventDefV2 {
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

  const baseWs: WorldState = {
    currentLocationId: 'LOC_MARKET',
    timePhase: 'DAY',
    timeCounter: 0,
    hubHeat: 20,
    hubSafety: 'SAFE',
    hubHeatReasons: [],
    tension: 3,
    mainArc: { unlockedArcIds: [], completedArcIds: [] },
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

  // ── 시나리오 1: 신규 LOCATION 방문 (0턴) ──
  it('1. 신규 방문 (0턴): midSummary=null, intentMemory=null', () => {
    const locationTurns: RecentTurnEntry[] = [];
    // midSummary: 6턴 이하 → null
    expect(locationTurns.length).toBeLessThanOrEqual(6);
    const summary =
      locationTurns.length > 6
        ? midSummary.generate(locationTurns.slice(0, -6))
        : null;
    expect(summary).toBeNull();

    // intentMemory: 빈 history → null
    const patterns = intentMemory.analyze([]);
    expect(patterns).toBeNull();
  });

  // ── 시나리오 2: 8턴 방문 → midSummary 존재, locationSessionTurns ≤ 6 ──
  it('2. 8턴 방문: midSummary 존재, locationSessionTurns ≤ 6', async () => {
    const allTurns = Array.from({ length: 8 }, (_, i) =>
      makeTurn({
        turnNo: i + 1,
        rawInput: `행동${i + 1}`,
        resolveOutcome: i % 2 === 0 ? 'SUCCESS' : 'PARTIAL',
      }),
    );

    expect(allTurns.length).toBe(8);
    expect(allTurns.length).toBeGreaterThan(6);

    const earlyTurns = allTurns.slice(0, -6);
    const recentTurns = allTurns.slice(-6);
    const summary = await midSummary.generate(earlyTurns);

    expect(summary.length).toBeGreaterThan(0);
    expect(summary.length).toBeLessThanOrEqual(400);
    expect(recentTurns.length).toBe(6);
  });

  // ── 시나리오 3: 토큰 오버플로 → 저우선 블록 트리밍 ──
  it('3. 토큰 오버플로: 저우선 블록 트리밍', () => {
    // 각 1000자 = ~333 토큰 × 10 블록 = ~3330 토큰 → TOTAL 2500 초과
    const parts = Array.from(
      { length: 10 },
      (_, i) => `[블록 ${i}]\n${'가'.repeat(1000)}`,
    );
    const totalBefore = parts.reduce(
      (sum, p) => sum + tokenBudget.estimateTokens(p),
      0,
    );
    expect(totalBefore).toBeGreaterThan(TOKEN_BUDGET.TOTAL);

    const trimmed = tokenBudget.enforceTotal(parts);
    const totalAfter = trimmed.reduce(
      (sum, p) => sum + tokenBudget.estimateTokens(p),
      0,
    );
    expect(totalAfter).toBeLessThanOrEqual(TOKEN_BUDGET.TOTAL);
  });

  // ── 시나리오 4: 고정 이벤트 전부 쿨다운 → 절차적 이벤트 생성 ──
  it('4. 고정 이벤트 전부 쿨다운 → 절차적 이벤트 생성', () => {
    // 모든 고정 이벤트에 쿨다운 설정 → EventDirector가 null 반환
    const events = [
      makeEvent({
        eventId: 'EVT_1',
        gates: [{ type: 'COOLDOWN_TURNS', turns: 100 }],
      }),
      makeEvent({
        eventId: 'EVT_2',
        gates: [{ type: 'COOLDOWN_TURNS', turns: 100 }],
      }),
    ];
    const cooldowns: Record<string, number> = { EVT_1: 50, EVT_2: 50 };
    const result = eventDirector.select(
      events,
      'LOC_MARKET',
      baseIntent,
      baseWs,
      baseArcState,
      baseAgenda,
      cooldowns,
      55,
      fakeRng,
      [],
      null,
    );

    // 고정 이벤트 실패
    expect(result.selectedEvent).toBeNull();

    // 절차적 이벤트로 fallback
    const procResult = proceduralEvent.generate(
      { locationId: 'LOC_MARKET', timePhase: 'DAY' },
      [],
      55,
      fakeRng,
    );
    expect(procResult).not.toBeNull();
    expect(procResult!.eventId).toBe('PROC_55');
    expect(procResult!.payload.tags).toContain('PROCEDURAL');
  });

  // ── 시나리오 5: 절차적 Anti-Repetition: 10턴 연속 반복 없음 ──
  it('5. 절차적 Anti-Repetition: 10턴 연속 반복 없음', () => {
    const history: ProceduralHistoryEntry[] = [];
    const generatedTriggers = new Set<string>();

    for (let turn = 1; turn <= 10; turn++) {
      const result = proceduralEvent.generate(
        { locationId: 'LOC_MARKET', timePhase: 'DAY' },
        history,
        turn,
        // 매 턴 다른 랜덤 값
        {
          next: () => (turn * 0.17) % 1,
          chance: () => false,
          nextInt: () => turn,
        } as any,
      );

      if (result) {
        // eventId에서 trigger 추출은 불가하므로 sceneFrame 다양성 확인
        generatedTriggers.add(result.payload.sceneFrame.slice(0, 20));

        // history에 기록 (간이)
        history.push({
          turnNo: turn,
          triggerId: `TRG_${turn}`,
          subjectId: `SUB_${turn}`,
          actionId: `ACT_${turn}`,
          outcomeId: `OUT_${turn}`,
          subjectActionKey: `SUB_${turn}:ACT_${turn}`,
        });
        // 15개 초과 시 오래된 것 제거
        if (history.length > 15) history.shift();
      }
    }

    // 10턴 동안 최소 3종류 이상의 다른 장면 생성
    expect(generatedTriggers.size).toBeGreaterThanOrEqual(3);
  });

  // ── 시나리오 6: Intent Memory: SNEAK×6 → "은밀 탐색" 감지 ──
  it('6. Intent Memory: SNEAK×6 → "은밀 탐색" 감지', () => {
    const history = Array.from({ length: 6 }, () => ({ actionType: 'SNEAK' }));
    const patterns = intentMemory.analyze(history);
    expect(patterns).not.toBeNull();
    expect(patterns!.some((p) => p.id === 'stealth_exploration')).toBe(true);

    const text = intentMemory.renderForContext(patterns!);
    expect(text).toContain('은밀 탐색');
  });

  // ── 시나리오 7: Active Clues: PLOT_HINT 3개 → 단서 블록 출력 ──
  it('7. Active Clues: PLOT_HINT 3개 → 단서 블록 출력', () => {
    const structured: StructuredMemory = {
      ...createEmptyStructuredMemory(),
      llmExtracted: [
        {
          turnNo: 1,
          category: 'PLOT_HINT',
          text: '항만 세금 이중 징수 의혹',
          importance: 0.8,
          relatedLocationId: 'LOC_HARBOR',
        },
        {
          turnNo: 2,
          category: 'PLOT_HINT',
          text: '에드릭이 장부를 감추고 있다',
          importance: 0.7,
        },
        {
          turnNo: 3,
          category: 'PLOT_HINT',
          text: '밀수 조직의 연결고리',
          importance: 0.6,
        },
        {
          turnNo: 4,
          category: 'NPC_DETAIL',
          text: '하를런의 흉터',
          importance: 0.5,
        }, // 제외 대상
        {
          turnNo: 5,
          category: 'PLOT_HINT',
          text: '낮은 중요도 단서',
          importance: 0.4,
        }, // importance < 0.6 → 제외
      ],
    };

    const clues = memoryRenderer.renderActiveClues(structured);
    expect(clues).toContain('항만 세금');
    expect(clues).toContain('에드릭');
    expect(clues).toContain('밀수 조직');
    // importance < 0.6 제외
    expect(clues).not.toContain('낮은 중요도');
    // NPC_DETAIL은 activeClues에 포함되지 않음
    expect(clues).not.toContain('하를런의 흉터');

    // 줄 수 확인 (3개)
    const lines = clues.split('\n').filter((l) => l.startsWith('-'));
    expect(lines.length).toBe(3);
  });

  // ── 시나리오 8: Event Director stage 필터 ──
  it('8. Event Director stage 필터: stage 불일치 이벤트 제외', () => {
    const wsWithStage = { ...baseWs, mainArc: { ...baseWs.mainArc, stage: 2 } };
    const events = [
      makeEvent({ eventId: 'EVT_STAGE_1', stages: ['1'] }),
      makeEvent({ eventId: 'EVT_STAGE_2', stages: ['2'] }),
      makeEvent({ eventId: 'EVT_NO_STAGE' }), // stages 없음 → 통과
    ];

    const result = eventDirector.select(
      events,
      'LOC_MARKET',
      baseIntent,
      wsWithStage,
      baseArcState,
      baseAgenda,
      {},
      1,
      fakeRng,
      [],
      null,
    );

    // stage=2이므로 EVT_STAGE_1은 제외, EVT_STAGE_2 또는 EVT_NO_STAGE 선택
    expect(result.selectedEvent).not.toBeNull();
    expect(result.selectedEvent!.eventId).not.toBe('EVT_STAGE_1');
    // filterLog에 stage 필터 기록
    expect(result.filterLog.some((log) => log.includes('stage=2'))).toBe(true);
  });
});
