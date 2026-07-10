// 버그 a44a7478 — 언급(3인칭) 질문 가드 회귀 테스트.
//   잠금 대화 중 "X는 어디서 만날 수 있죠?" 류 언급 질문은 X를 화자로
//   승격하지 않고 잠금 NPC를 유지한다 (+ 다른 장소면 whereaboutsHint).
//   "X에게/한테" 호명은 기존대로 화자 전환.

/* eslint-disable @typescript-eslint/no-unsafe-argument */
import { NpcResolverService } from './npc-resolver.service.js';
import type { NpcResolutionContext } from './npc-resolver.service.js';

const EDRIC = {
  npcId: 'NPC_EDRIC_VEIL',
  name: '에드릭 베일',
  unknownAlias: '날카로운 눈매의 회계사',
  shortAlias: '회계사',
  aliases: ['에드릭'],
  roleKeywords: ['장부'],
  tier: 'CORE',
};
const BROKER = {
  npcId: 'NPC_INFO_BROKER',
  name: '쉐도우',
  unknownAlias: '후드를 깊이 쓴 정보상',
  shortAlias: '정보상',
  aliases: ['쉐도우', '정보상'],
  roleKeywords: null,
  tier: 'SUB',
};

class FakeContent {
  getAllNpcs(): unknown[] {
    return [EDRIC, BROKER];
  }
  getNpc(id: string): unknown {
    return [EDRIC, BROKER].find((n) => n.npcId === id);
  }
  getFactsByKeywords(): unknown[] {
    return [];
  }
}

class FakeWhereabouts {
  constructor(private readonly kind: string = 'SAME_LOCATION') {}
  lookupNpc(): unknown {
    if (this.kind === 'DIFFERENT_LOCATION') {
      return {
        kind: 'DIFFERENT_LOCATION',
        locationLabel: "'잠긴 닻' 선술집",
        activity: '구석 자리에서 정보를 사고파는 거래를 진행한다',
      };
    }
    return { kind: this.kind };
  }
}

/** 에드릭과 대화 잠금 활성 상태의 기본 컨텍스트 */
const lockedCtx = (
  rawInput: string,
  overrides: Partial<NpcResolutionContext> = {},
): NpcResolutionContext =>
  ({
    rawInput,
    intent: { actionType: 'TALK', tone: 'NEUTRAL' },
    currentLocationId: 'LOC_MARKET',
    timePhase: 'NIGHT',
    actionHistory: [
      { primaryNpcId: 'NPC_EDRIC_VEIL', actionType: 'TALK' },
      { primaryNpcId: 'NPC_EDRIC_VEIL', actionType: 'PERSUADE' },
    ],
    candidateEvent: {
      eventId: 'EVT_X',
      payload: { primaryNpcId: 'NPC_EDRIC_VEIL' },
    },
    nodeType: 'LOCATION',
    inputType: 'ACTION',
    runState: {
      worldState: {
        npcLocations: {
          NPC_EDRIC_VEIL: 'LOC_MARKET',
          NPC_INFO_BROKER: 'LOC_MARKET', // 버그 재현: 같은 장소 판정이어도 가드 발동
        },
      },
    },
    ...overrides,
  }) as unknown as NpcResolutionContext;

describe('NpcResolverService — 언급 질문 가드 (버그 a44a7478)', () => {
  const make = (kind = 'SAME_LOCATION') =>
    new NpcResolverService(
      new FakeContent() as any,
      new FakeWhereabouts(kind) as any,
    );

  it('버그 재현 입력: "정보상은 어디서 만날 수 있죠?" → 잠금 NPC(에드릭) 유지', () => {
    const r = make().resolve(lockedCtx('정보상은 어디서 만날 수 있죠?'));
    expect(r.npcId).toBe('NPC_EDRIC_VEIL');
    expect(r.source).toBe('CONVERSATION_LOCK');
    expect(r.lockApplied).toBe(true);
    // 언급된 NPC는 alternatives에 화제로 기록
    expect(r.alternatives.some((a) => a.npcId === 'NPC_INFO_BROKER')).toBe(
      true,
    );
  });

  it('"정보상에 대해 아는 게 있소?" → 잠금 유지 (화제 질문)', () => {
    const r = make().resolve(lockedCtx('정보상에 대해 아는 게 있소?'));
    expect(r.npcId).toBe('NPC_EDRIC_VEIL');
    expect(r.source).toBe('CONVERSATION_LOCK');
  });

  it('언급 NPC가 다른 장소면 whereaboutsHint 부착', () => {
    const r = make('DIFFERENT_LOCATION').resolve(
      lockedCtx('정보상은 어디 있소?', {
        runState: {
          worldState: {
            npcLocations: {
              NPC_EDRIC_VEIL: 'LOC_MARKET',
              NPC_INFO_BROKER: 'LOC_TAVERN',
            },
          },
        },
      }),
    );
    expect(r.npcId).toBe('NPC_EDRIC_VEIL');
    expect(r.whereaboutsHint?.searchedNpcId).toBe('NPC_INFO_BROKER');
    expect(r.whereaboutsHint?.locationLabel).toBe("'잠긴 닻' 선술집");
  });

  it('호명("정보상에게 말을 건다")은 가드 미발동 — 화자 전환 유지', () => {
    const r = make().resolve(lockedCtx('정보상에게 말을 건다'));
    expect(r.npcId).toBe('NPC_INFO_BROKER');
    expect(r.source).toBe('STRONG_EXPLICIT_NAME');
  });

  it('잠금 NPC 본인 언급("에드릭은 어디서 왔소?")은 가드 무관 — 정상 STRONG', () => {
    const r = make().resolve(lockedCtx('에드릭은 어디서 왔소?'));
    expect(r.npcId).toBe('NPC_EDRIC_VEIL');
    expect(r.source).toBe('STRONG_EXPLICIT_NAME');
  });

  it('잠금 없으면 가드 미발동 — 기존 STRONG 동작 유지', () => {
    const r = make().resolve(
      lockedCtx('정보상은 어디서 만날 수 있죠?', { actionHistory: [] }),
    );
    expect(r.npcId).toBe('NPC_INFO_BROKER');
    expect(r.source).toBe('STRONG_EXPLICIT_NAME');
  });

  it('질문 패턴 없는 단순 언급("정보상을 찾아간다")은 기존대로 화자 전환', () => {
    const r = make().resolve(lockedCtx('정보상을 찾아간다'));
    expect(r.npcId).toBe('NPC_INFO_BROKER');
    expect(r.source).toBe('STRONG_EXPLICIT_NAME');
  });
});
