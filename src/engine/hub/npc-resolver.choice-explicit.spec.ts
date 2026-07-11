// arch/65 — CHOICE 선택지 명시 NPC(Step 0) 회귀 테스트.
//   선택지 payload가 NPC를 지정(nano sourceNpcId 등)한 CHOICE 턴은
//   대화 잠금보다 그 NPC를 우선한다 (실측: 쥐왕 BRIBE 선택지의 뇌물이
//   잠금 상대 로사에게 가는 어긋남).

/* eslint-disable @typescript-eslint/no-unsafe-argument */
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
