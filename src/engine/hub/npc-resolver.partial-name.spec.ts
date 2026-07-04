// architecture/59 이슈 1 — NpcResolver 부분 이름 매칭 회귀 테스트.
//   "하를런"(aliases 변형)만으로도 STRONG_EXPLICIT_NAME 판정되어야 함.
//   shortAlias(일반 명사 위험)는 같은 장소에 있을 때만 인정.

/* eslint-disable @typescript-eslint/no-unsafe-argument */
import { NpcResolverService } from './npc-resolver.service.js';
import type { NpcResolutionContext } from './npc-resolver.service.js';

const HARLUN = {
  npcId: 'NPC_HARLUN',
  name: '하를런 보스',
  unknownAlias: '투박한 노동자',
  shortAlias: '노동자',
  aliases: ['하를런', '보스'],
  roleKeywords: ['두목', '형제단'],
  tier: 'CORE',
};
const TOBREN = {
  npcId: 'NPC_TOBREN',
  name: '토브렌',
  unknownAlias: '무표정한 창고 여인',
  shortAlias: '창고지기',
  aliases: [],
  roleKeywords: ['창고'],
  tier: 'CORE',
};

class FakeContent {
  getAllNpcs(): unknown[] {
    return [HARLUN, TOBREN];
  }
  getNpc(id: string): unknown {
    return [HARLUN, TOBREN].find((n) => n.npcId === id);
  }
  getFactsByKeywords(): unknown[] {
    return [];
  }
}

class FakeWhereabouts {
  lookupNpc(): { kind: string } {
    return { kind: 'SAME_LOCATION' };
  }
}

const baseCtx = (
  rawInput: string,
  overrides: Partial<NpcResolutionContext> = {},
): NpcResolutionContext =>
  ({
    rawInput,
    intent: { actionType: 'TALK', tone: 'NEUTRAL' },
    currentLocationId: 'LOC_HARBOR',
    timePhase: 'DAY',
    actionHistory: [],
    candidateEvent: {
      eventId: 'EVT_X',
      payload: { primaryNpcId: 'NPC_TOBREN' },
    },
    nodeType: 'LOCATION',
    inputType: 'ACTION',
    runState: {
      worldState: {
        npcLocations: { NPC_HARLUN: 'LOC_HARBOR', NPC_TOBREN: 'LOC_HARBOR' },
      },
    },
    ...overrides,
  }) as unknown as NpcResolutionContext;

describe('NpcResolverService — 부분 이름 매칭 (architecture/59 이슈 1)', () => {
  let resolver: NpcResolverService;

  beforeEach(() => {
    resolver = new NpcResolverService(
      new FakeContent() as any,
      new FakeWhereabouts() as any,
    );
  });

  it('aliases 변형("하를런")만으로 STRONG_EXPLICIT_NAME 판정', () => {
    const r = resolver.resolve(baseCtx('하를런에게 임금 지급 문제를 물어본다'));
    expect(r.npcId).toBe('NPC_HARLUN');
    expect(r.source).toBe('STRONG_EXPLICIT_NAME');
  });

  it('전체 이름("하를런 보스")은 기존대로 매칭 (회귀 방지)', () => {
    const r = resolver.resolve(baseCtx('하를런 보스에게 소문을 묻는다'));
    expect(r.npcId).toBe('NPC_HARLUN');
    expect(r.source).toBe('STRONG_EXPLICIT_NAME');
  });

  it('shortAlias는 같은 장소일 때만 매칭', () => {
    const here = resolver.resolve(baseCtx('노동자를 붙잡고 묻는다'));
    expect(here.npcId).toBe('NPC_HARLUN');
    expect(here.source).toBe('STRONG_EXPLICIT_NAME');

    const away = resolver.resolve(
      baseCtx('노동자를 붙잡고 묻는다', {
        runState: {
          worldState: {
            npcLocations: {
              NPC_HARLUN: 'LOC_MARKET', // 다른 장소
              NPC_TOBREN: 'LOC_HARBOR',
            },
          },
        },
      }),
    );
    expect(away.source).not.toBe('STRONG_EXPLICIT_NAME');
  });

  it('이름 신호가 전혀 없으면 이벤트 NPC fallback (기존 동작 유지)', () => {
    const r = resolver.resolve(baseCtx('주변 상황을 조용히 살펴본다'));
    expect(r.npcId).toBe('NPC_TOBREN');
    expect(r.source).toBe('EVENT_PRIMARY');
  });
});
