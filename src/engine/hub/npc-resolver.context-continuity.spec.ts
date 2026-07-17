// [버그 d20c1de8 — 불변식 35 확장] 비대화 행동의 맥락 연속 (Step 5b).
//   "그의 다리를 부러뜨린다" 뒤 "얼굴을 때린다"(대상 미명시 FIGHT)에서
//   채택 비트의 이벤트 NPC가 구타 대상을 가로채던 스왑 실측 차단.

import { NpcResolverService } from './npc-resolver.service.js';
import type { NpcResolutionContext } from './npc-resolver.service.js';

const GUILDMASTER = {
  npcId: 'NPC_GUILDMASTER',
  name: '하르텐',
  unknownAlias: '굳은살 박인 손',
  shortAlias: '장인',
  aliases: ['하르텐'],
  roleKeywords: null,
  tier: 'CORE',
};
const WARDEN = {
  npcId: 'NPC_WARDEN',
  name: '오슬라',
  unknownAlias: '금테 두른 관리',
  shortAlias: '관리',
  aliases: ['오슬라'],
  roleKeywords: null,
  tier: 'CORE',
};

class FakeContent {
  getAllNpcs(): unknown[] {
    return [GUILDMASTER, WARDEN];
  }
  getNpc(id: string): unknown {
    return [GUILDMASTER, WARDEN].find((n) => n.npcId === id);
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

const ctx = (
  overrides: Partial<NpcResolutionContext> = {},
): NpcResolutionContext =>
  ({
    rawInput: '더 아는것이 없는지 얼굴을 때린다',
    intent: { actionType: 'FIGHT', tone: 'NEUTRAL' },
    currentLocationId: 'LOC_KH_SMITHY',
    timePhase: 'NIGHT',
    actionHistory: [
      { primaryNpcId: 'NPC_GUILDMASTER', actionType: 'THREATEN' },
    ],
    candidateEvent: {
      eventId: 'BEAT_13_0',
      payload: { primaryNpcId: 'NPC_WARDEN' },
    },
    nodeType: 'LOCATION',
    inputType: 'ACTION',
    runState: { worldState: { npcLocations: {} } },
    ...overrides,
  }) as unknown as NpcResolutionContext;

describe('NpcResolver — 비대화 행동 맥락 연속 (Step 5b, 불변식 35 확장)', () => {
  const service = new NpcResolverService(
    new FakeContent() as never,
    new FakeWhereabouts() as never,
  );

  it('FIGHT 대상 미명시 — 직전 상대가 이벤트 NPC를 이긴다 (스왑 차단)', () => {
    const r = service.resolve(ctx());
    expect(r.npcId).toBe('NPC_GUILDMASTER');
    expect(r.source).toBe('CONTEXT_CONTINUITY');
  });

  it('실명 명시 지목은 여전히 우선 (STRONG > 5b)', () => {
    const r = service.resolve(ctx({ rawInput: '오슬라의 얼굴을 때린다' }));
    expect(r.npcId).toBe('NPC_WARDEN');
    expect(r.source).toBe('STRONG_EXPLICIT_NAME');
  });

  it('직전 상대가 없으면(도착 직후) 기존대로 이벤트 NPC', () => {
    const r = service.resolve(ctx({ actionHistory: [] }));
    expect(r.npcId).toBe('NPC_WARDEN');
    expect(r.source).toBe('EVENT_PRIMARY');
  });

  it('환경 지향 행동(SNEAK)은 5b 미적용', () => {
    const r = service.resolve(
      ctx({
        rawInput: '어둠에 몸을 숨긴다',
        intent: { actionType: 'SNEAK', tone: 'NEUTRAL' } as never,
      }),
    );
    expect(r.source).not.toBe('CONTEXT_CONTINUITY');
  });
});
