// arch/65 — CHOICE 선택지 명시 NPC(Step 0) 회귀 테스트.
//   선택지 payload가 NPC를 지정(nano sourceNpcId 등)한 CHOICE 턴은
//   대화 잠금보다 그 NPC를 우선한다 (실측: 쥐왕 BRIBE 선택지의 뇌물이
//   잠금 상대 로사에게 가는 어긋남).

import { NpcResolverService } from './npc-resolver.service.js';
import type { NpcResolutionContext } from './npc-resolver.service.js';

const ROSA = {
  npcId: 'NPC_ROSA',
  name: '로사',
  unknownAlias: '주름진 손의 노점상',
  shortAlias: '노점상',
  aliases: ['로사'],
  roleKeywords: null,
  tier: 'SUB',
};
const RAT_KING = {
  npcId: 'NPC_RAT_KING',
  name: '쥐왕',
  unknownAlias: '두건 쓴 사내',
  shortAlias: '사내',
  aliases: ['쥐왕'],
  roleKeywords: null,
  tier: 'CORE',
};

class FakeContent {
  getAllNpcs(): unknown[] {
    return [ROSA, RAT_KING];
  }
  getNpc(id: string): unknown {
    return [ROSA, RAT_KING].find((n) => n.npcId === id);
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

/** 로사와 대화 잠금 활성 + 쥐왕 지정 BRIBE 선택지 클릭 상황 */
const choiceCtx = (
  overrides: Partial<NpcResolutionContext> = {},
): NpcResolutionContext =>
  ({
    rawInput: '그를 향해 은화 몇 닢을 슬쩍 밀어 넣는다',
    intent: { actionType: 'BRIBE', tone: 'NEUTRAL' },
    currentLocationId: 'LOC_SLUMS',
    timePhase: 'NIGHT',
    actionHistory: [
      { primaryNpcId: 'NPC_ROSA', actionType: 'TALK' },
      { primaryNpcId: 'NPC_ROSA', actionType: 'PERSUADE' },
    ],
    candidateEvent: {
      eventId: 'EVT_X',
      payload: { primaryNpcId: 'NPC_ROSA' },
    },
    nodeType: 'LOCATION',
    inputType: 'CHOICE',
    runState: {
      worldState: {
        npcLocations: {
          NPC_ROSA: 'LOC_SLUMS',
          NPC_RAT_KING: 'LOC_SLUMS',
        },
      },
    },
    ...overrides,
  }) as unknown as NpcResolutionContext;

describe('NpcResolver — CHOICE 명시 NPC 우선 (arch/65 Step 0)', () => {
  const service = new NpcResolverService(
    new FakeContent() as never,
    new FakeWhereabouts() as never,
  );

  it('선택지 지정 NPC가 대화 잠금을 이긴다 (쥐왕 BRIBE vs 로사 잠금)', () => {
    const r = service.resolve(choiceCtx({ choiceNpcId: 'NPC_RAT_KING' }));
    expect(r.npcId).toBe('NPC_RAT_KING');
    expect(r.source).toBe('CHOICE_EXPLICIT');
    expect(r.lockApplied).toBe(false);
  });

  it('지정 없는 CHOICE는 기존대로 대화 잠금 유지', () => {
    const r = service.resolve(choiceCtx({ choiceNpcId: null }));
    expect(r.npcId).toBe('NPC_ROSA');
    expect(r.source).toBe('CONVERSATION_LOCK');
  });

  it('존재하지 않는 NPC 지정은 무시하고 기존 경로로 fallback', () => {
    const r = service.resolve(choiceCtx({ choiceNpcId: 'NPC_GHOST' }));
    expect(r.npcId).toBe('NPC_ROSA');
    expect(r.source).toBe('CONVERSATION_LOCK');
  });

  it('ACTION 입력에서는 choiceNpcId가 있어도 Step 0을 타지 않는다', () => {
    const r = service.resolve(
      choiceCtx({ inputType: 'ACTION', choiceNpcId: 'NPC_RAT_KING' }),
    );
    expect(r.source).not.toBe('CHOICE_EXPLICIT');
  });
});

describe('NpcResolver — NPC 작별 발화 잠금 해제 (P2 2026-07-11)', () => {
  const service = new NpcResolverService(
    new FakeContent() as never,
    new FakeWhereabouts() as never,
  );

  it('npcFarewell 마킹된 대화는 잠금을 잇지 않는다 (토브렌 25턴 상주 재현 방지)', () => {
    const r = service.resolve(
      choiceCtx({
        inputType: 'ACTION',
        rawInput: '주변을 살펴본다',
        intent: { actionType: 'OBSERVE', tone: 'NEUTRAL' } as never,
        actionHistory: [
          { primaryNpcId: 'NPC_ROSA', actionType: 'TALK' },
          // NPC가 작별 발화 → 워커가 npcFarewell 마킹
          { primaryNpcId: 'NPC_ROSA', actionType: 'TALK', npcFarewell: true },
        ],
        candidateEvent: { eventId: 'EVT_X', payload: {} },
      }),
    );
    expect(r.source).not.toBe('CONVERSATION_LOCK');
    expect(r.npcId).not.toBe('NPC_ROSA');
  });

  it('작별 이후 새 SOCIAL 턴이 쌓이면 다시 잠금 성립 (재대화 허용)', () => {
    const r = service.resolve(
      choiceCtx({
        inputType: 'ACTION',
        rawInput: '주변을 살펴본다',
        intent: { actionType: 'OBSERVE', tone: 'NEUTRAL' } as never,
        actionHistory: [
          { primaryNpcId: 'NPC_ROSA', actionType: 'TALK', npcFarewell: true },
          // 플레이어가 다시 말을 걸어 새 대화 성립
          { primaryNpcId: 'NPC_ROSA', actionType: 'PERSUADE' },
        ],
        candidateEvent: { eventId: 'EVT_X', payload: {} },
      }),
    );
    expect(r.source).toBe('CONVERSATION_LOCK');
    expect(r.npcId).toBe('NPC_ROSA');
  });

  it('findLockFromHistory도 npcFarewell에서 끊긴다', () => {
    const lock = service.findLockFromHistory(
      [{ primaryNpcId: 'NPC_ROSA', actionType: 'TALK', npcFarewell: true }],
      'TALK',
    );
    expect(lock).toBeNull();
  });
});

describe('NpcResolver — 언급 질문 가드 확장 (자유 대화 검증 2026-07-12)', () => {
  const service = new NpcResolverService(
    new FakeContent() as never,
    new FakeWhereabouts() as never,
  );
  const lockedOnRosa = (rawInput: string) =>
    service.resolve(
      choiceCtx({
        inputType: 'ACTION',
        rawInput,
        intent: { actionType: 'PERSUADE', tone: 'NEUTRAL' } as never,
        actionHistory: [{ primaryNpcId: 'NPC_ROSA', actionType: 'TALK' }],
        candidateEvent: { eventId: 'EVT_X', payload: {} },
      }),
    );

  it('실측 T5 유형: "쥐왕에게 얼마나 쥐여줘야..." — 조사+언급질문은 잠금 유지', () => {
    const r = lockedOnRosa('쥐왕에게 얼마나 쥐여줘야 입을 열겠소?');
    expect(r.npcId).toBe('NPC_ROSA');
    expect(r.source).toBe('CONVERSATION_LOCK');
  });

  it('실측 T10 유형: "쥐왕이 말한 창고..." — 언급은 잠금 유지', () => {
    const r = lockedOnRosa('쥐왕이 말한 창고 주인이 누군지 아시오?');
    expect(r.npcId).toBe('NPC_ROSA');
  });

  it('정당한 화자 전환("쥐왕에게 말을 건다")은 여전히 전환', () => {
    const r = lockedOnRosa('쥐왕에게 말을 건다');
    expect(r.npcId).toBe('NPC_RAT_KING');
  });
});

// [V10-② — 2026-07-17] Step 0b: 이벤트 고유 선택지(sourceEventId) — 이벤트 NPC 우선
describe('NpcResolver — 이벤트 고유 CHOICE의 이벤트 NPC 우선 (V10-② Step 0b)', () => {
  const service = new NpcResolverService(
    new FakeContent() as never,
    new FakeWhereabouts() as never,
  );

  it('sourceEventId가 매칭 이벤트와 일치하면 이벤트 primaryNpcId가 잠금을 이긴다', () => {
    // 로사 잠금 중, 쥐왕 전제 이벤트의 고유 선택지를 클릭 (선택지에 npcId 없음)
    const r = service.resolve(
      choiceCtx({
        rawInput: '자리에 앉아 심문에 응한다',
        candidateEvent: {
          eventId: 'EVT_GUARD_INT_1',
          payload: { primaryNpcId: 'NPC_RAT_KING' },
        },
        choiceNpcId: null,
        choiceSourceEventId: 'EVT_GUARD_INT_1',
      }),
    );
    expect(r.npcId).toBe('NPC_RAT_KING');
    expect(r.source).toBe('CHOICE_EVENT');
    expect(r.lockApplied).toBe(false);
  });

  it('sourceEventId가 매칭 이벤트와 다르면 Step 0b 미발동 — 잠금 유지', () => {
    const r = service.resolve(
      choiceCtx({
        candidateEvent: {
          eventId: 'EVT_OTHER',
          payload: { primaryNpcId: 'NPC_RAT_KING' },
        },
        choiceNpcId: null,
        choiceSourceEventId: 'EVT_GUARD_INT_1',
      }),
    );
    expect(r.source).not.toBe('CHOICE_EVENT');
    expect(r.npcId).toBe('NPC_ROSA'); // 잠금 유지
  });

  it('선택지 npcId 지정(Step 0)이 있으면 그쪽이 먼저다', () => {
    const r = service.resolve(
      choiceCtx({
        candidateEvent: {
          eventId: 'EVT_GUARD_INT_1',
          payload: { primaryNpcId: 'NPC_ROSA' },
        },
        choiceNpcId: 'NPC_RAT_KING',
        choiceSourceEventId: 'EVT_GUARD_INT_1',
      }),
    );
    expect(r.source).toBe('CHOICE_EXPLICIT');
    expect(r.npcId).toBe('NPC_RAT_KING');
  });

  it('ACTION 입력은 Step 0b를 타지 않는다', () => {
    const r = service.resolve(
      choiceCtx({
        inputType: 'ACTION',
        rawInput: '로사에게 계속 묻는다',
        choiceNpcId: null,
        choiceSourceEventId: 'EVT_GUARD_INT_1',
        candidateEvent: {
          eventId: 'EVT_GUARD_INT_1',
          payload: { primaryNpcId: 'NPC_RAT_KING' },
        },
      }),
    );
    expect(r.source).not.toBe('CHOICE_EVENT');
  });
});
