/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-explicit-any */
import { NanoEventDirectorService } from './nano-event-director.service.js';
import type {
  NanoEventResult,
  NanoEventContext,
} from './nano-event-director.service.js';

describe('NanoEventDirectorService', () => {
  let service: NanoEventDirectorService;

  // --- mocks ---
  const mockNpcMap: Record<string, { name: string; unknownAlias: string }> = {
    NPC_A: { name: 'Alice', unknownAlias: '푸른 눈의 여인' },
    NPC_B: { name: 'Bob', unknownAlias: '덩치 큰 남자' },
    NPC_C: { name: 'Carol', unknownAlias: '수상한 상인' },
  };

  const mockContentLoader = {
    getNpc: jest.fn((id: string) => mockNpcMap[id] ?? null),
  };
  const mockLlmCaller = { call: jest.fn() };
  const mockLlmConfig = {
    getLightModelConfig: jest.fn(() => ({ model: 'test-model' })),
  };

  beforeEach(() => {
    jest.clearAllMocks();
    service = new NanoEventDirectorService(
      mockLlmCaller as any,
      mockLlmConfig as any,
      mockContentLoader as any,
    );
  });

  // --- helpers ---
  function makeResult(
    overrides: Partial<NanoEventResult> = {},
  ): NanoEventResult {
    return {
      npc: 'Alice',
      npcId: 'NPC_A',
      concept: '시장에서 수상한 거래가 벌어지고 있다',
      tone: '긴장',
      opening: '낡은 천막 사이로 바람이 분다.',
      npcGesture: '고개를 돌린다',
      fact: null,
      factRevealed: false,
      factDelivery: 'indirect',
      avoid: [],
      choices: [
        { label: '대화한다', affordance: 'TALK', npcId: 'NPC_A' },
        { label: '조사한다', affordance: 'INVESTIGATE', npcId: null },
        { label: '관찰한다', affordance: 'OBSERVE', npcId: null },
      ],
      ...overrides,
    };
  }

  function makeCtx(
    overrides: Partial<NanoEventContext> = {},
  ): NanoEventContext {
    return {
      locationId: 'LOC_MARKET',
      locationName: '시장',
      timePhase: 'DAY',
      hubHeat: 20,
      hubSafety: 'SAFE',
      rawInput: '주변을 살핀다',
      actionType: 'OBSERVE',
      resolveOutcome: 'SUCCESS',
      lastNpcId: 'NPC_A',
      lastNpcName: 'Alice',
      targetNpcId: null,
      wantNewNpc: false,
      npcConsecutiveTurns: 1,
      presentNpcs: [
        {
          npcId: 'NPC_A',
          displayName: 'Alice',
          posture: 'FRIENDLY',
          trust: 30,
          consecutiveTurns: 1,
          met: true,
        },
        {
          npcId: 'NPC_B',
          displayName: 'Bob',
          posture: 'CAUTIOUS',
          trust: 10,
          consecutiveTurns: 0,
          met: false,
        },
      ],
      recentSummary: '시장에서 조사를 진행했다.',
      availableFacts: [
        { factId: 'FACT_01', description: '밀수 루트 정보', rate: 0.8 },
      ],
      questState: 'S1',
      previousOpening: null,
      activeConditions: [],
      npcReactions: [],
      ...overrides,
    };
  }

  // ========== validate() ==========
  describe('validate()', () => {
    // Access private method via bracket notation
    const callValidate = (
      svc: NanoEventDirectorService,
      result: NanoEventResult,
      ctx: NanoEventContext,
    ): NanoEventResult => {
      return (svc as any).validate(result, ctx);
    };

    it('npcLocked=true, lockedNpcId=NPC_A -> npcId fixed to NPC_A', () => {
      const result = makeResult({ npcId: 'NPC_B', npc: 'Bob' });
      const ctx = makeCtx({ npcLocked: true, lockedNpcId: 'NPC_A' });
      const v = callValidate(service, result, ctx);
      expect(v.npcId).toBe('NPC_A');
      expect(v.npc).toBe('푸른 눈의 여인');
    });

    it('targetNpcId=NPC_B -> npcId overridden to NPC_B', () => {
      const result = makeResult({ npcId: 'NPC_A' });
      const ctx = makeCtx({ targetNpcId: 'NPC_B' });
      const v = callValidate(service, result, ctx);
      expect(v.npcId).toBe('NPC_B');
      expect(v.npc).toBe('덩치 큰 남자');
    });

    it('npcLocked + targetNpcId -> npcLocked wins', () => {
      const result = makeResult({ npcId: 'NPC_C' });
      const ctx = makeCtx({
        npcLocked: true,
        lockedNpcId: 'NPC_A',
        targetNpcId: 'NPC_B',
      });
      const v = callValidate(service, result, ctx);
      expect(v.npcId).toBe('NPC_A');
    });

    it('NPC not present -> fallback to lastNpcId', () => {
      const result = makeResult({ npcId: 'NPC_UNKNOWN' });
      const ctx = makeCtx({ lastNpcId: 'NPC_B' });
      const v = callValidate(service, result, ctx);
      expect(v.npcId).toBe('NPC_B');
    });

    it('NPC not present + no lastNpcId -> fallback to presentNpcs[0]', () => {
      const result = makeResult({ npcId: 'NPC_UNKNOWN' });
      const ctx = makeCtx({ lastNpcId: null });
      const v = callValidate(service, result, ctx);
      expect(v.npcId).toBe('NPC_A');
    });

    it('5 consecutive turns + other NPCs -> force switch', () => {
      const result = makeResult({ npcId: 'NPC_A' });
      const ctx = makeCtx({
        npcConsecutiveTurns: 5,
        lastNpcId: 'NPC_A',
      });
      const v = callValidate(service, result, ctx);
      expect(v.npcId).toBe('NPC_B');
    });

    it('5 consecutive turns + only 1 NPC -> no switch', () => {
      const result = makeResult({ npcId: 'NPC_A' });
      const ctx = makeCtx({
        npcConsecutiveTurns: 5,
        lastNpcId: 'NPC_A',
        presentNpcs: [
          {
            npcId: 'NPC_A',
            displayName: 'Alice',
            posture: 'FRIENDLY',
            trust: 30,
            consecutiveTurns: 5,
            met: true,
          },
        ],
      });
      const v = callValidate(service, result, ctx);
      expect(v.npcId).toBe('NPC_A');
    });

    it('invalid fact -> set to null', () => {
      const result = makeResult({ fact: 'FACT_NONEXISTENT', factRevealed: true });
      const ctx = makeCtx();
      const v = callValidate(service, result, ctx);
      expect(v.fact).toBeNull();
      expect(v.factRevealed).toBe(false);
    });

    it('valid fact -> preserved', () => {
      const result = makeResult({ fact: 'FACT_01', factRevealed: true });
      const ctx = makeCtx();
      const v = callValidate(service, result, ctx);
      expect(v.fact).toBe('FACT_01');
      expect(v.factRevealed).toBe(true);
    });

    it('opening starting with "당신은" -> emptied', () => {
      const result = makeResult({ opening: '당신은 시장에 도착했다.' });
      const ctx = makeCtx();
      const v = callValidate(service, result, ctx);
      expect(v.opening).toBe('');
    });

    it('opening starting with "당신이" -> emptied', () => {
      const result = makeResult({ opening: '당신이 걸어간다.' });
      const ctx = makeCtx();
      const v = callValidate(service, result, ctx);
      expect(v.opening).toBe('');
    });

    it('normal opening -> preserved', () => {
      const result = makeResult({ opening: '바람이 불어온다.' });
      const ctx = makeCtx();
      const v = callValidate(service, result, ctx);
      expect(v.opening).toBe('바람이 불어온다.');
    });

    it('invalid affordance -> normalized to TALK', () => {
      const result = makeResult({
        choices: [
          { label: '행동', affordance: 'INVALID_ACTION', npcId: null },
          { label: '대화', affordance: 'TALK', npcId: null },
          { label: '관찰', affordance: 'OBSERVE', npcId: null },
        ],
      });
      const ctx = makeCtx();
      const v = callValidate(service, result, ctx);
      expect(v.choices[0].affordance).toBe('TALK');
      expect(v.choices[1].affordance).toBe('TALK');
      expect(v.choices[2].affordance).toBe('OBSERVE');
    });

    it('only 2 choices -> padded to 3', () => {
      const result = makeResult({
        choices: [
          { label: '대화', affordance: 'TALK', npcId: null },
          { label: '관찰', affordance: 'OBSERVE', npcId: null },
        ],
      });
      const ctx = makeCtx();
      const v = callValidate(service, result, ctx);
      expect(v.choices).toHaveLength(3);
      expect(v.choices[2]).toEqual({
        label: '주변을 살핀다',
        affordance: 'OBSERVE',
        npcId: null,
      });
    });

    it('0 choices -> filled with 3 defaults', () => {
      const result = makeResult({ choices: [] });
      const ctx = makeCtx();
      const v = callValidate(service, result, ctx);
      expect(v.choices).toHaveLength(3);
      for (const c of v.choices) {
        expect(c.label).toBe('주변을 살핀다');
        expect(c.affordance).toBe('OBSERVE');
        expect(c.npcId).toBeNull();
      }
    });
  });

  // ========== buildUserMessage() ==========
  describe('buildUserMessage()', () => {
    const callBuild = (
      svc: NanoEventDirectorService,
      ctx: NanoEventContext,
    ): string => {
      return (svc as any).buildUserMessage(ctx);
    };

    it('npcLocked -> includes "[NPC 고정]"', () => {
      const ctx = makeCtx({
        npcLocked: true,
        lockedNpcId: 'NPC_A',
      });
      const msg = callBuild(service, ctx);
      expect(msg).toContain('[NPC 고정]');
      expect(msg).toContain('Alice');
    });

    it('targetNpcId -> includes "[NPC 지정]"', () => {
      const ctx = makeCtx({ targetNpcId: 'NPC_B' });
      const msg = callBuild(service, ctx);
      expect(msg).toContain('[NPC 지정]');
      expect(msg).toContain('Bob');
    });

    it('wantNewNpc -> includes "[NPC 전환]"', () => {
      const ctx = makeCtx({ wantNewNpc: true });
      const msg = callBuild(service, ctx);
      expect(msg).toContain('[NPC 전환]');
    });

    it('npcConsecutiveTurns >= 3 -> includes "[NPC 피로]"', () => {
      const ctx = makeCtx({ npcConsecutiveTurns: 4 });
      const msg = callBuild(service, ctx);
      expect(msg).toContain('[NPC 피로]');
      expect(msg).toContain('4턴 연속');
    });

    it('no NPC signals -> none of the signal tags', () => {
      const ctx = makeCtx({
        npcLocked: false,
        targetNpcId: null,
        wantNewNpc: false,
        npcConsecutiveTurns: 1,
      });
      const msg = callBuild(service, ctx);
      expect(msg).not.toContain('[NPC 고정]');
      expect(msg).not.toContain('[NPC 지정]');
      expect(msg).not.toContain('[NPC 전환]');
      expect(msg).not.toContain('[NPC 피로]');
    });

    it('activeConditions -> includes "[장소 조건]"', () => {
      const ctx = makeCtx({
        activeConditions: [
          { id: 'LOCKDOWN', effects: { blockedActions: ['STEAL'] } },
        ],
      });
      const msg = callBuild(service, ctx);
      expect(msg).toContain('[장소 조건');
      expect(msg).toContain('지역 봉쇄');
    });

    it('npcReactions -> includes "[NPC 반응]"', () => {
      const ctx = makeCtx({
        npcReactions: [
          {
            npcId: 'NPC_B',
            npcName: 'Bob',
            type: 'WARNING',
            text: '경계하는 눈빛을 보낸다',
          },
        ],
      });
      const msg = callBuild(service, ctx);
      expect(msg).toContain('[NPC 반응');
      expect(msg).toContain('Bob: 경계하는 눈빛을 보낸다');
    });

    it('previousOpening -> includes "[직전 opening]"', () => {
      const ctx = makeCtx({
        previousOpening: '바람이 불어온다.',
      });
      const msg = callBuild(service, ctx);
      expect(msg).toContain('[직전 opening]');
      expect(msg).toContain('바람이 불어온다.');
    });

    it('NPC list shows lastNpcId tag and met status', () => {
      const ctx = makeCtx();
      const msg = callBuild(service, ctx);
      expect(msg).toContain('직전 대화 NPC');
      expect(msg).toContain('미대면');
    });

    it('availableFacts rendered in message', () => {
      const ctx = makeCtx();
      const msg = callBuild(service, ctx);
      expect(msg).toContain('FACT_01');
      expect(msg).toContain('밀수 루트 정보');
      expect(msg).toContain('80%');
    });
  });
});
