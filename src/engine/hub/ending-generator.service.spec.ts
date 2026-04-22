import {
  EndingGeneratorService,
  MIN_TURNS_FOR_NATURAL,
} from './ending-generator.service.js';
import type { ContentLoaderService } from '../../content/content-loader.service.js';
import type {
  EndingInput,
  IncidentRuntime,
  MainArcClock,
} from '../../db/types/index.js';

/** 테스트용 endings.json 최소 모킹 */
function makeEndingsData() {
  return {
    closingLines: {
      STABLE: '도시는 여전히 숨 쉬고 있었다.',
      UNSTABLE: '도시는 상처를 안고 다음 날을 맞았다.',
      COLLAPSED: '도시는 무너졌다.',
    },
    arcRouteEndings: {
      EXPOSE_CORRUPTION: {
        STABLE: {
          title: '정의의 대가',
          epilogue: '당신이 모은 증거는 도시를 뒤흔들었다.',
          rewards: { gold: 50, reputation: { CITY_GUARD: 10 } },
        },
        UNSTABLE: {
          title: '불완전한 진실',
          epilogue: '부패의 일부만 밝혀졌다.',
          rewards: { gold: 30 },
        },
        COLLAPSED: {
          title: '진실이 삼킨 도시',
          epilogue: '도시는 감당하지 못했다.',
          rewards: { gold: 10 },
        },
      },
      PROFIT_FROM_CHAOS: {
        STABLE: {
          title: '황금빛 그림자',
          epilogue: '부를 쌓았다.',
          rewards: { gold: 120 },
        },
        UNSTABLE: { title: '배신자의 길', epilogue: '적도 만들었다.' },
        COLLAPSED: { title: '재의 상인', epilogue: '잿더미.' },
      },
      ALLY_GUARD: {
        STABLE: { title: '질서의 수호자', epilogue: '평화가 돌아왔다.' },
        UNSTABLE: { title: '불안한 평화', epilogue: '뿌리는 못 뽑았다.' },
        COLLAPSED: { title: '철권의 잔해', epilogue: '진압은 폭동이 됐다.' },
      },
      NONE: {
        STABLE: {
          title: '스쳐간 이방인',
          epilogue: '어느 편에도 서지 않았다.',
        },
        UNSTABLE: { title: '방관자의 무게', epilogue: '아무것도 안 했다.' },
        COLLAPSED: { title: '잿더미의 증인', epilogue: '무너짐을 지켜봤다.' },
      },
    },
    npcEpilogueTemplates: {
      NPC_TEST: {
        high_trust: '테스트 NPC가 당신을 기억한다.',
        neutral: '테스트 NPC는 무심하다.',
        hostile: '테스트 NPC가 당신을 저주한다.',
      },
    },
  };
}

function makeContentMock(): Partial<ContentLoaderService> {
  return {
    getEndingsData: jest.fn(() => makeEndingsData()) as never,
    getNpc: jest.fn((id: string) =>
      id === 'NPC_TEST'
        ? ({
            id: 'NPC_TEST',
            name: '테스트 NPC',
            unknownAlias: '낯선 이',
          } as never)
        : null,
    ) as never,
  };
}

function makeInput(overrides: Partial<EndingInput> = {}): EndingInput {
  return {
    incidentOutcomes: [],
    npcEpilogues: [],
    narrativeMarks: [],
    globalHeat: 0,
    globalTension: 0,
    daysSpent: 10,
    reputation: {},
    arcRoute: null,
    arcCommitment: 0,
    dominantVectors: [],
    playerThreads: [],
    consequenceFootprint: {
      totalSuspicion: 0,
      totalPlayerProgress: 0,
      totalRivalProgress: 0,
    },
    ...overrides,
  };
}

function makeIncident(
  outcome: 'CONTAINED' | 'ESCALATED' | 'EXPIRED',
  id = 'inc_test',
): EndingInput['incidentOutcomes'][number] {
  return { incidentId: id, outcome, title: `사건 ${id}` };
}

describe('EndingGeneratorService', () => {
  let service: EndingGeneratorService;
  let contentMock: Partial<ContentLoaderService>;

  beforeEach(() => {
    contentMock = makeContentMock();
    service = new EndingGeneratorService(contentMock as ContentLoaderService);
  });

  describe('MIN_TURNS_FOR_NATURAL', () => {
    it('상수는 15로 export 됨', () => {
      expect(MIN_TURNS_FOR_NATURAL).toBe(15);
    });
  });

  describe('checkEndingConditions', () => {
    const baseClock: MainArcClock = {
      startDay: 1,
      softDeadlineDay: 14,
      triggered: false,
    };
    const resolved = (outcome: 'CONTAINED' = 'CONTAINED'): IncidentRuntime =>
      ({
        incidentId: 'inc_x',
        kind: 'CRIMINAL',
        stage: 1,
        control: 100,
        pressure: 0,
        deadlineClock: 100,
        spawnedAtClock: 10,
        resolved: true,
        outcome,
        historyLog: [],
        suspicion: 0,
        security: 0,
        playerProgress: 0,
        rivalProgress: 0,
        vectors: [],
      }) as unknown as IncidentRuntime;

    it('모든 Incident resolved + totalTurns ≥ 15 → ALL_RESOLVED', () => {
      const r = service.checkEndingConditions(
        [resolved(), resolved()],
        baseClock,
        5,
        20,
      );
      expect(r.shouldEnd).toBe(true);
      expect(r.reason).toBe('ALL_RESOLVED');
    });

    it('모든 Incident resolved + totalTurns < 15 → MIN_TURNS 가드로 차단', () => {
      const r = service.checkEndingConditions([resolved()], baseClock, 5, 10);
      expect(r.shouldEnd).toBe(false);
      expect(r.reason).toBeNull();
    });

    it('activeIncidents가 비어있으면 shouldEnd=false (배제)', () => {
      const r = service.checkEndingConditions([], baseClock, 5, 20);
      expect(r.shouldEnd).toBe(false);
    });
  });

  describe('generateEnding — arcRoute 분기', () => {
    it('arcRoute=EXPOSE_CORRUPTION + STABLE → "정의의 대가" 반환', () => {
      const input = makeInput({
        incidentOutcomes: [makeIncident('CONTAINED')],
        arcRoute: 'EXPOSE_CORRUPTION',
        daysSpent: 12,
      });
      const r = service.generateEnding(input, 'ALL_RESOLVED', 20);
      expect(r.arcRoute).toBe('EXPOSE_CORRUPTION');
      expect(r.arcTitle).toBe('정의의 대가');
      expect(r.arcEpilogue).toContain('증거');
      expect(r.arcRewards?.gold).toBe(50);
      expect(r.arcRewards?.reputation?.CITY_GUARD).toBe(10);
    });

    it('arcRoute=PROFIT_FROM_CHAOS + 3건 악화 → COLLAPSED "재의 상인"', () => {
      const input = makeInput({
        incidentOutcomes: [
          makeIncident('ESCALATED', 'a'),
          makeIncident('ESCALATED', 'b'),
          makeIncident('ESCALATED', 'c'),
        ],
        arcRoute: 'PROFIT_FROM_CHAOS',
      });
      const r = service.generateEnding(input, 'ALL_RESOLVED', 20);
      expect(r.cityStatus.stability).toBe('COLLAPSED');
      expect(r.arcRoute).toBe('PROFIT_FROM_CHAOS');
      expect(r.arcTitle).toBe('재의 상인');
    });

    it('arcRoute=null → NONE 분기로 매핑', () => {
      const input = makeInput({
        incidentOutcomes: [makeIncident('CONTAINED')],
        arcRoute: null,
      });
      const r = service.generateEnding(input, 'ALL_RESOLVED', 20);
      expect(r.arcRoute).toBe('NONE');
      expect(r.arcTitle).toBe('스쳐간 이방인');
    });

    it('알 수 없는 arcRoute 값도 NONE으로 fallback', () => {
      const input = makeInput({
        incidentOutcomes: [makeIncident('CONTAINED')],
        arcRoute: 'UNKNOWN_ROUTE',
      });
      const r = service.generateEnding(input, 'ALL_RESOLVED', 20);
      expect(r.arcRoute).toBe('NONE');
      expect(r.arcTitle).toBe('스쳐간 이방인');
    });

    it('ALLY_GUARD + UNSTABLE → "불안한 평화"', () => {
      const input = makeInput({
        incidentOutcomes: [
          makeIncident('CONTAINED', 'a'),
          makeIncident('ESCALATED', 'b'),
          makeIncident('EXPIRED', 'c'),
        ],
        arcRoute: 'ALLY_GUARD',
      });
      const r = service.generateEnding(input, 'ALL_RESOLVED', 20);
      expect(r.cityStatus.stability).toBe('UNSTABLE');
      expect(r.arcTitle).toBe('불안한 평화');
    });
  });

  describe('generateEnding — personalClosing', () => {
    it('기본 여정 정보로 2문장 이상 생성', () => {
      const input = makeInput({
        incidentOutcomes: [
          makeIncident('CONTAINED'),
          makeIncident('CONTAINED', 'b'),
        ],
        daysSpent: 14,
        dominantVectors: ['SOCIAL'],
        arcRoute: 'EXPOSE_CORRUPTION',
      });
      const r = service.generateEnding(input, 'ALL_RESOLVED', 30);
      expect(r.personalClosing).toBeDefined();
      expect(r.personalClosing).toContain('14일간');
      expect(r.personalClosing).toContain('30번');
      expect(r.personalClosing).toContain('2건의 사건');
    });

    it('trust ≥ 30 NPC가 있으면 이름 언급', () => {
      const input = makeInput({
        incidentOutcomes: [makeIncident('CONTAINED')],
        npcEpilogues: [
          {
            npcId: 'NPC_TEST',
            npcName: '테스트 NPC',
            trust: 50,
            fear: 0,
            respect: 0,
            suspicion: 0,
            attachment: 0,
            posture: 'FRIENDLY',
          },
        ],
        dominantVectors: ['SOCIAL'],
      });
      const r = service.generateEnding(input, 'ALL_RESOLVED', 20);
      expect(r.personalClosing).toContain('테스트 NPC');
      expect(r.personalClosing).toContain('기억할');
    });

    it('trust ≤ -30 NPC면 적대 여운 언급', () => {
      const input = makeInput({
        incidentOutcomes: [makeIncident('CONTAINED')],
        npcEpilogues: [
          {
            npcId: 'NPC_TEST',
            npcName: '테스트 NPC',
            trust: -50,
            fear: 0,
            respect: 0,
            suspicion: 0,
            attachment: 0,
            posture: 'HOSTILE',
          },
        ],
      });
      const r = service.generateEnding(input, 'ALL_RESOLVED', 20);
      expect(r.personalClosing).toContain('테스트 NPC');
      expect(r.personalClosing).toContain('지우지');
    });

    it('dominantVectors별 마지막 문장이 다름 (SOCIAL vs VIOLENT)', () => {
      const socialInput = makeInput({
        incidentOutcomes: [makeIncident('CONTAINED')],
        dominantVectors: ['SOCIAL'],
      });
      const violentInput = makeInput({
        incidentOutcomes: [makeIncident('CONTAINED')],
        dominantVectors: ['VIOLENT'],
      });
      const socialR = service.generateEnding(socialInput, 'ALL_RESOLVED', 20);
      const violentR = service.generateEnding(violentInput, 'ALL_RESOLVED', 20);
      expect(socialR.personalClosing).toContain('사람들 사이');
      expect(violentR.personalClosing).toContain('검이 만든 정적');
      expect(socialR.personalClosing).not.toEqual(violentR.personalClosing);
    });
  });

  describe('generateEnding — endingType / cityStatus', () => {
    it('endingReason=DEADLINE → endingType=DEADLINE', () => {
      const input = makeInput({
        incidentOutcomes: [makeIncident('EXPIRED')],
      });
      const r = service.generateEnding(input, 'DEADLINE', 20);
      expect(r.endingType).toBe('DEADLINE');
    });

    it('DEFEAT → closingLine은 사망 전용 문구', () => {
      const input = makeInput();
      const r = service.generateEnding(input, 'DEFEAT', 5);
      expect(r.endingType).toBe('DEFEAT');
      expect(r.closingLine).toContain('시야가 어두워진다');
    });

    it('containedCount ≥ escalated+expired → STABLE', () => {
      const input = makeInput({
        incidentOutcomes: [
          makeIncident('CONTAINED', 'a'),
          makeIncident('CONTAINED', 'b'),
          makeIncident('ESCALATED', 'c'),
        ],
      });
      const r = service.generateEnding(input, 'ALL_RESOLVED', 20);
      expect(r.cityStatus.stability).toBe('STABLE');
    });
  });

  describe('checkSoftDeadline (기존 유지)', () => {
    it('daysLeft ≤ 2 + ≥ 0이면 signal=true', () => {
      const r = service.checkSoftDeadline(
        { startDay: 1, softDeadlineDay: 14, triggered: false },
        12,
      );
      expect(r.signal).toBe(true);
      expect(r.daysLeft).toBe(2);
    });

    it('daysLeft=3이면 signal=false (이 함수는 2 이하만)', () => {
      const r = service.checkSoftDeadline(
        { startDay: 1, softDeadlineDay: 14, triggered: false },
        11,
      );
      expect(r.signal).toBe(false);
    });
  });
});
