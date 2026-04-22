// SummaryBuilderService 단위 테스트

import { SummaryBuilderService } from './summary-builder.service.js';
import type { ContentLoaderService } from '../../content/content-loader.service.js';
import type {
  EndingResult,
  IncidentRuntime,
  NarrativeMark,
  NPCState,
  RunState,
} from '../../db/types/index.js';

// ── 공통 fixture ──

function makeNpcState(overrides: Partial<NPCState> = {}): NPCState {
  return {
    npcId: 'NPC_X',
    introduced: false,
    encounterCount: 0,
    agenda: '',
    currentGoal: '',
    currentStage: 'INITIAL',
    trustToPlayer: 0,
    suspicion: 0,
    influence: 50,
    funds: 50,
    network: 50,
    exposure: 0,
    posture: 'CAUTIOUS',
    emotional: {
      trust: 0,
      fear: 0,
      respect: 0,
      suspicion: 0,
      attachment: 0,
    },
    ...overrides,
  };
}

function makeIncident(args: {
  id: string;
  outcome: 'CONTAINED' | 'ESCALATED' | 'EXPIRED';
  resolvedAtClock?: number;
}): IncidentRuntime {
  return {
    incidentId: args.id,
    kind: 'CRIMINAL',
    stage: 3,
    control: 80,
    pressure: 10,
    deadlineClock: 200,
    spawnedAtClock: 0,
    resolved: true,
    outcome: args.outcome,
    historyLog:
      args.resolvedAtClock !== undefined
        ? [
            {
              clock: args.resolvedAtClock,
              action: 'RESOLVE',
              detail: '',
            },
          ]
        : [],
  };
}

function makeRunState(overrides: Partial<RunState> = {}): RunState {
  return {
    hp: 100,
    maxHp: 100,
    stamina: 5,
    maxStamina: 5,
    inventory: [],
    npcRelations: {},
    eventCooldowns: {},
    characterName: '에반',
    ...overrides,
  } as RunState;
}

function makeEndingResult(overrides: Partial<EndingResult> = {}): EndingResult {
  return {
    endingType: 'NATURAL',
    npcEpilogues: [],
    cityStatus: { stability: 'STABLE', summary: '도시는 평온하다.' },
    narrativeMarks: [],
    closingLine: '도시는 여전히 숨 쉬고 있었다.',
    statistics: {
      daysSpent: 10,
      incidentsContained: 0,
      incidentsEscalated: 0,
      incidentsExpired: 0,
      totalTurns: 30,
    },
    arcRoute: 'NONE',
    ...overrides,
  };
}

function makeContentMock(): Partial<ContentLoaderService> {
  const incidents: Record<
    string,
    { incidentId: string; kind: string; title: string }
  > = {
    INC_MARKET: {
      incidentId: 'INC_MARKET',
      kind: 'CRIMINAL',
      title: '시장 도난 사건',
    },
    INC_RIOT: {
      incidentId: 'INC_RIOT',
      kind: 'SOCIAL',
      title: '빈민가 소요',
    },
  };
  const npcs: Record<
    string,
    { npcId: string; name: string; unknownAlias?: string; tier?: string }
  > = {
    NPC_HARLUN: {
      npcId: 'NPC_HARLUN',
      name: '하를런',
      unknownAlias: '부두의 보스',
      tier: 'CORE',
    },
    NPC_OWEN: {
      npcId: 'NPC_OWEN',
      name: '오웬',
      unknownAlias: '선술집 주인',
      tier: 'CORE',
    },
    NPC_EDRIC: {
      npcId: 'NPC_EDRIC',
      name: '에드릭',
      unknownAlias: '상단 대표',
      tier: 'SUB',
    },
  };
  const presets: Record<string, { presetId: string; name: string }> = {
    DOCKWORKER: { presetId: 'DOCKWORKER', name: '항구 노동자' },
  };
  return {
    getIncident: jest.fn((id: string) => incidents[id]) as never,
    getNpc: jest.fn((id: string) => npcs[id]) as never,
    getPreset: jest.fn((id: string) => presets[id]) as never,
  };
}

function makeService() {
  const content = makeContentMock();
  return {
    service: new SummaryBuilderService(content as ContentLoaderService),
    content,
  };
}

const baseRun = {
  id: 'run-1',
  presetId: 'DOCKWORKER',
  gender: 'male' as const,
  updatedAt: new Date('2026-04-20T00:00:00Z'),
  currentTurnNo: 30,
};

describe('SummaryBuilderService', () => {
  // ── Synopsis 분기 ──
  describe('buildEndingSummary / synopsis', () => {
    it('도입 문장에 presetLabel + characterName + daysSpent를 포함한다', () => {
      const { service } = makeService();
      const s = service.buildEndingSummary(
        baseRun,
        makeRunState({ characterName: '에반' }),
        makeEndingResult({
          statistics: {
            daysSpent: 12,
            incidentsContained: 0,
            incidentsEscalated: 0,
            incidentsExpired: 0,
            totalTurns: 30,
          },
        }),
      );
      expect(s.synopsis).toContain('항구 노동자 에반');
      expect(s.synopsis).toContain('12일간');
      expect(s.synopsis).toContain('그레이마르');
    });

    it('dominantVectors 상위 2개가 벡터쌍 테이블에 있으면 해당 문장을 사용한다', () => {
      const { service } = makeService();
      const s = service.buildEndingSummary(
        baseRun,
        makeRunState(),
        makeEndingResult({
          dominantVectors: ['SOCIAL', 'VIOLENT'],
        }),
      );
      // SOCIAL+VIOLENT 매핑
      expect(s.synopsis).toContain('주먹을 주저하지 않는');
    });

    it('벡터쌍 테이블에 없으면 Top1 단일 벡터 fallback 문장을 사용한다', () => {
      const { service } = makeService();
      const s = service.buildEndingSummary(
        baseRun,
        makeRunState(),
        makeEndingResult({
          dominantVectors: ['STEALTH'],
        }),
      );
      expect(s.synopsis).toContain('은밀한');
    });

    it('CONTAINED 사건이 있으면 pivot 문장에 incident title이 나온다', () => {
      const { service } = makeService();
      const runState = makeRunState({
        worldState: {
          activeIncidents: [
            makeIncident({
              id: 'INC_MARKET',
              outcome: 'CONTAINED',
              resolvedAtClock: 24,
            }),
          ],
        } as never,
      });
      const s = service.buildEndingSummary(
        baseRun,
        runState,
        makeEndingResult(),
      );
      expect(s.synopsis).toContain('시장 도난 사건');
      expect(s.synopsis).toContain('첫 매듭');
    });

    it('CONTAINED가 없고 NarrativeMark만 있으면 mark 기반 pivot 문장을 사용한다', () => {
      const { service } = makeService();
      const marks: NarrativeMark[] = [
        {
          type: 'SAVIOR',
          permanent: true,
          createdAtClock: 12,
          context: '',
        },
      ];
      const s = service.buildEndingSummary(
        baseRun,
        makeRunState(),
        makeEndingResult({ narrativeMarks: marks }),
      );
      expect(s.synopsis).toContain('한 사람의 목숨을 구했다');
    });

    it('arcRoute + stability로 closing 문장을 매핑한다 (EXPOSE_CORRUPTION / STABLE)', () => {
      const { service } = makeService();
      const s = service.buildEndingSummary(
        baseRun,
        makeRunState(),
        makeEndingResult({
          arcRoute: 'EXPOSE_CORRUPTION',
          cityStatus: { stability: 'STABLE', summary: '' },
        }),
      );
      expect(s.synopsis).toContain('정의의 이름');
    });
  });

  // ── keyEvents 우선순위 ──
  describe('buildEndingSummary / keyEvents', () => {
    it('ESCALATED(4) > CONTAINED(3) > EXPIRED(2) 순으로 정렬', () => {
      const { service } = makeService();
      const runState = makeRunState({
        worldState: {
          activeIncidents: [
            makeIncident({
              id: 'INC_EXPIRED',
              outcome: 'EXPIRED',
              resolvedAtClock: 10,
            }),
            makeIncident({
              id: 'INC_MARKET',
              outcome: 'CONTAINED',
              resolvedAtClock: 20,
            }),
            makeIncident({
              id: 'INC_RIOT',
              outcome: 'ESCALATED',
              resolvedAtClock: 30,
            }),
          ],
        } as never,
      });
      const s = service.buildEndingSummary(
        baseRun,
        runState,
        makeEndingResult(),
      );
      const kinds = s.keyEvents.map((e) => e.outcome);
      expect(kinds[0]).toBe('ESCALATED');
      expect(kinds[1]).toBe('CONTAINED');
      expect(kinds[2]).toBe('EXPIRED');
    });

    it('동일 우선순위면 day(clock) 오름차순으로 정렬', () => {
      const { service } = makeService();
      const runState = makeRunState({
        worldState: {
          activeIncidents: [
            makeIncident({
              id: 'INC_RIOT',
              outcome: 'CONTAINED',
              resolvedAtClock: 72, // day 7
            }),
            makeIncident({
              id: 'INC_MARKET',
              outcome: 'CONTAINED',
              resolvedAtClock: 24, // day 3
            }),
          ],
        } as never,
      });
      const s = service.buildEndingSummary(
        baseRun,
        runState,
        makeEndingResult(),
      );
      expect(s.keyEvents[0].text).toContain('시장 도난');
      expect(s.keyEvents[0].day).toBe(3);
      expect(s.keyEvents[1].text).toContain('빈민가 소요');
      expect(s.keyEvents[1].day).toBe(7);
    });

    it('NarrativeMark를 MARK kind로 포함하며 mark type별 문구를 사용한다', () => {
      const { service } = makeService();
      const marks: NarrativeMark[] = [
        { type: 'BETRAYER', permanent: true, createdAtClock: 36, context: '' },
      ];
      const s = service.buildEndingSummary(
        baseRun,
        makeRunState(),
        makeEndingResult({ narrativeMarks: marks }),
      );
      const markEvents = s.keyEvents.filter((e) => e.kind === 'MARK');
      expect(markEvents).toHaveLength(1);
      expect(markEvents[0].text).toContain('배신');
      expect(markEvents[0].day).toBe(4); // 36/12 = 3, +1 = 4
    });

    it('최대 6건으로 잘린다', () => {
      const { service } = makeService();
      const incidents = Array.from({ length: 10 }, (_, i) =>
        makeIncident({
          id: `INC_${i}`,
          outcome: 'CONTAINED',
          resolvedAtClock: i * 12,
        }),
      );
      const runState = makeRunState({
        worldState: { activeIncidents: incidents } as never,
      });
      const s = service.buildEndingSummary(
        baseRun,
        runState,
        makeEndingResult(),
      );
      expect(s.keyEvents.length).toBeLessThanOrEqual(6);
    });
  });

  // ── keyNpcs 선별 ──
  describe('buildEndingSummary / keyNpcs', () => {
    it('trust ≥ 30 NPC는 "가까운 벗" bondLabel로 상위 2명 포함', () => {
      const { service } = makeService();
      const runState = makeRunState({
        npcStates: {
          NPC_HARLUN: makeNpcState({
            npcId: 'NPC_HARLUN',
            introduced: true,
            introducedAtTurn: 5,
            emotional: {
              trust: 50,
              fear: 0,
              respect: 0,
              suspicion: 0,
              attachment: 0,
            },
          }),
          NPC_OWEN: makeNpcState({
            npcId: 'NPC_OWEN',
            introduced: true,
            introducedAtTurn: 5,
            emotional: {
              trust: 40,
              fear: 0,
              respect: 0,
              suspicion: 0,
              attachment: 0,
            },
          }),
          NPC_EDRIC: makeNpcState({
            npcId: 'NPC_EDRIC',
            emotional: {
              trust: 10,
              fear: 0,
              respect: 0,
              suspicion: 0,
              attachment: 0,
            },
          }),
        },
      });
      const s = service.buildEndingSummary(
        baseRun,
        runState,
        makeEndingResult(),
      );
      const friends = s.keyNpcs.filter((n) => n.bondLabel === '가까운 벗');
      expect(friends.length).toBe(2);
      expect(friends.map((n) => n.npcId).sort()).toEqual([
        'NPC_HARLUN',
        'NPC_OWEN',
      ]);
    });

    it('trust ≤ -30 최하위 1명을 "적대" bondLabel로 포함', () => {
      const { service } = makeService();
      const runState = makeRunState({
        npcStates: {
          NPC_EDRIC: makeNpcState({
            npcId: 'NPC_EDRIC',
            introduced: true,
            introducedAtTurn: 5,
            emotional: {
              trust: -50,
              fear: 0,
              respect: 0,
              suspicion: 0,
              attachment: 0,
            },
          }),
        },
      });
      const s = service.buildEndingSummary(
        baseRun,
        runState,
        makeEndingResult(),
      );
      const enemies = s.keyNpcs.filter((n) => n.bondLabel === '적대');
      expect(enemies).toHaveLength(1);
      expect(enemies[0].npcId).toBe('NPC_EDRIC');
    });

    it('미소개(introduced=false) NPC는 unknownAlias로 표시된다', () => {
      const { service } = makeService();
      const runState = makeRunState({
        npcStates: {
          NPC_HARLUN: makeNpcState({
            npcId: 'NPC_HARLUN',
            introduced: false,
            emotional: {
              trust: 60,
              fear: 0,
              respect: 20,
              suspicion: 0,
              attachment: 0,
            },
          }),
        },
      });
      const s = service.buildEndingSummary(
        baseRun,
        runState,
        makeEndingResult(),
      );
      expect(s.keyNpcs).toHaveLength(1);
      expect(s.keyNpcs[0].npcName).toBe('부두의 보스'); // unknownAlias
    });

    it('endingResult.npcEpilogues의 epilogueText를 50자 이내 oneLine으로 사용', () => {
      const { service } = makeService();
      const runState = makeRunState({
        npcStates: {
          NPC_HARLUN: makeNpcState({
            npcId: 'NPC_HARLUN',
            introduced: true,
            introducedAtTurn: 5,
            emotional: {
              trust: 50,
              fear: 0,
              respect: 0,
              suspicion: 0,
              attachment: 0,
            },
          }),
        },
      });
      const s = service.buildEndingSummary(
        baseRun,
        runState,
        makeEndingResult({
          npcEpilogues: [
            {
              npcId: 'NPC_HARLUN',
              npcName: '하를런',
              epilogueText:
                '하를런은 부두에서 당신의 이름을 기억했다. 노동자들 사이에서 당신은 전설이 되었다.',
              finalPosture: 'FRIENDLY',
            },
          ],
        }),
      );
      expect(s.keyNpcs[0].oneLine.length).toBeLessThanOrEqual(50);
      expect(s.keyNpcs[0].oneLine).toContain('하를런');
    });
  });

  // ── finale / stats / presetLabel ──
  describe('buildEndingSummary / finale & meta', () => {
    it('presetId → PRESET_LABELS 매핑', () => {
      const { service } = makeService();
      const s = service.buildEndingSummary(
        { ...baseRun, presetId: 'SMUGGLER' },
        makeRunState(),
        makeEndingResult(),
      );
      expect(s.presetLabel).toBe('밀수업자');
    });

    it('알 수 없는 preset은 content.getPreset().name으로 fallback', () => {
      const { service } = makeService();
      const s = service.buildEndingSummary(
        { ...baseRun, presetId: 'DOCKWORKER' },
        makeRunState(),
        makeEndingResult(),
      );
      // DOCKWORKER는 PRESET_LABELS에 있음
      expect(s.presetLabel).toBe('항구 노동자');
    });

    it('arcRoute 값이 알 수 없으면 NONE으로 정규화', () => {
      const { service } = makeService();
      const s = service.buildEndingSummary(
        baseRun,
        makeRunState(),
        makeEndingResult({ arcRoute: 'UNKNOWN_ROUTE' as never }),
      );
      expect(s.finale.arcRoute).toBe('NONE');
    });

    it('endingResult.arcTitle이 없으면 arcRoute × stability 기본 title fallback', () => {
      const { service } = makeService();
      const s = service.buildEndingSummary(
        baseRun,
        makeRunState(),
        makeEndingResult({
          arcRoute: 'ALLY_GUARD',
          cityStatus: { stability: 'COLLAPSED', summary: '' },
          arcTitle: undefined,
        }),
      );
      expect(s.finale.arcTitle).toBe('철권의 잔해');
    });

    it('stats는 endingResult.statistics를 복사한다', () => {
      const { service } = makeService();
      const s = service.buildEndingSummary(
        baseRun,
        makeRunState(),
        makeEndingResult({
          statistics: {
            daysSpent: 18,
            incidentsContained: 3,
            incidentsEscalated: 1,
            incidentsExpired: 0,
            totalTurns: 42,
          },
        }),
      );
      expect(s.stats).toEqual({
        daysSpent: 18,
        totalTurns: 42,
        incidentsContained: 3,
        incidentsEscalated: 1,
        incidentsExpired: 0,
      });
    });

    it('characterName이 비어있어도 fallback "이름 없는 용병"을 사용한다', () => {
      const { service } = makeService();
      const s = service.buildEndingSummary(
        baseRun,
        makeRunState({ characterName: undefined }),
        makeEndingResult(),
      );
      expect(s.characterName).toBe('이름 없는 용병');
    });
  });
});
