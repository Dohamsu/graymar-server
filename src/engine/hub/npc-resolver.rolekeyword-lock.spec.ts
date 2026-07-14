// 버그 86bff72b — MEDIUM(roleKeyword) 잠금 우선 가드 회귀 테스트.
//   브렌과 대화 잠금 중 "그럼 수비대에서는 어떤게 고충이신가요?"의 조직명
//   키워드("수비대")가 마이렐 roleKeywords에 걸려 화자를 가로챈 실측.
//   계약("MEDIUM: lock 부재 시 매칭")대로 잠금 활성 중 키워드 단독 매칭은
//   화제 언급으로 강등하고 잠금을 유지한다. 의도적 화자 전환은 Step 1
//   STRONG(실명/별칭/shortAlias/호명 조사)이 담당.

/* eslint-disable @typescript-eslint/no-unsafe-argument */
import { NpcResolverService } from './npc-resolver.service.js';
import type { NpcResolutionContext } from './npc-resolver.service.js';

const BREN = {
  npcId: 'NPC_CAPTAIN_BREN',
  name: '브렌 대위',
  unknownAlias: '단정한 장교',
  shortAlias: '제복 장교',
  aliases: ['브렌'],
  roleKeywords: null as string[] | null,
  tier: 'SUB',
};
const MAIREL = {
  npcId: 'NPC_MAIREL',
  name: '마이렐 단 경',
  unknownAlias: '야간 경비 책임자',
  shortAlias: '경비 책임자',
  aliases: ['마이렐'],
  // 코드 레벨 가드 검증용 — 콘텐츠에서는 제거된 조직명 키워드를 의도적으로 재현
  roleKeywords: ['수비대', '야간 책임자'],
  tier: 'CORE',
};

class FakeContent {
  constructor(private readonly npcs: unknown[] = [BREN, MAIREL]) {}
  getAllNpcs(): unknown[] {
    return this.npcs;
  }
  getNpc(id: string): unknown {
    return (this.npcs as Array<{ npcId: string }>).find((n) => n.npcId === id);
  }
  getFactsByKeywords(): unknown[] {
    return [];
  }
}

class FakeWhereabouts {
  lookupNpc(): unknown {
    return { kind: 'SAME_LOCATION' };
  }
}

/** 브렌과 대화 잠금 활성 상태의 기본 컨텍스트 */
const lockedCtx = (
  rawInput: string,
  overrides: Partial<NpcResolutionContext> = {},
): NpcResolutionContext =>
  ({
    rawInput,
    intent: { actionType: 'TALK', tone: 'NEUTRAL' },
    currentLocationId: 'LOC_GUARD',
    timePhase: 'DAY',
    actionHistory: [
      { primaryNpcId: 'NPC_CAPTAIN_BREN', actionType: 'TALK' },
      { primaryNpcId: 'NPC_CAPTAIN_BREN', actionType: 'TALK' },
    ],
    candidateEvent: {
      eventId: 'FREE_CONV_1',
      payload: { primaryNpcId: 'NPC_CAPTAIN_BREN' },
    },
    nodeType: 'LOCATION',
    inputType: 'ACTION',
    runState: {
      worldState: {
        npcLocations: {
          NPC_CAPTAIN_BREN: 'LOC_GUARD',
          NPC_MAIREL: 'LOC_GUARD', // 버그 재현: 같은 장소라 localFirst가 잡히던 경로
        },
      },
    },
    ...overrides,
  }) as unknown as NpcResolutionContext;

describe('NpcResolverService — roleKeyword 잠금 우선 가드 (버그 86bff72b)', () => {
  const make = (npcs?: unknown[]) =>
    new NpcResolverService(
      new FakeContent(npcs) as any,
      new FakeWhereabouts() as any,
    );

  it('버그 재현 입력: "그럼 수비대에서는 어떤게 고충이신가요?" → 잠금 NPC(브렌) 유지', () => {
    const r = make().resolve(
      lockedCtx(
        '그럼 수비대에서는 어떤게 고충이신가요? 요새 들리는 소문과는 전혀 무관한가요?',
      ),
    );
    expect(r.npcId).toBe('NPC_CAPTAIN_BREN');
    expect(r.source).toBe('CONVERSATION_LOCK');
    expect(r.lockApplied).toBe(true);
    // 키워드 후보는 alternatives에 화제로 기록
    expect(r.alternatives.some((a) => a.npcId === 'NPC_MAIREL')).toBe(true);
  });

  it('질문 패턴이 아닌 키워드 언급("수비대 순찰이 잦아졌군")도 잠금 유지', () => {
    const r = make().resolve(lockedCtx('수비대 순찰이 요즘 잦아졌군'));
    expect(r.npcId).toBe('NPC_CAPTAIN_BREN');
    expect(r.source).toBe('CONVERSATION_LOCK');
  });

  it('잠금 없으면 기존 MEDIUM 매칭 유지 — 마이렐 선택', () => {
    const r = make().resolve(
      lockedCtx('수비대에서는 어떤게 고충인가?', {
        actionHistory: [],
        candidateEvent: undefined,
      }),
    );
    expect(r.npcId).toBe('NPC_MAIREL');
    expect(r.source).toBe('MEDIUM_ROLE_KEYWORD');
  });

  it('잠금 NPC 본인이 키워드에 매칭되면 잠금 NPC로 MEDIUM 확정', () => {
    const brenWithKeyword = { ...BREN, roleKeywords: ['수비대'] };
    const r = make([brenWithKeyword, MAIREL]).resolve(
      lockedCtx('수비대 사정이 어떤지 궁금하군'),
    );
    expect(r.npcId).toBe('NPC_CAPTAIN_BREN');
    expect(r.source).toBe('MEDIUM_ROLE_KEYWORD');
  });

  it('shortAlias 호명("경비 책임자에게 말을 건다")은 STRONG — 화자 전환 유지', () => {
    const r = make().resolve(lockedCtx('경비 책임자에게 말을 건다'));
    expect(r.npcId).toBe('NPC_MAIREL');
    expect(r.source).toBe('STRONG_EXPLICIT_NAME');
  });
});
