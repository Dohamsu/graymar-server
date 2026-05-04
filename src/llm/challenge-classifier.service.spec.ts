/* eslint-disable @typescript-eslint/no-unsafe-argument */
import {
  ChallengeClassifierService,
  type ChallengeClassifierContext,
} from './challenge-classifier.service.js';

describe('ChallengeClassifierService', () => {
  let service: ChallengeClassifierService;
  const mockLlmCaller = { call: jest.fn() };
  const mockLlmConfig = {
    getLightModelConfig: jest.fn(() => ({
      provider: 'openai',
      model: 'gpt-4.1-nano',
      timeoutMs: 5000,
    })),
  };

  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.CHALLENGE_CLASSIFIER_ENABLED;
    service = new ChallengeClassifierService(
      mockLlmCaller as any,
      mockLlmConfig as any,
    );
  });

  function makeCtx(
    overrides: Partial<ChallengeClassifierContext> = {},
  ): ChallengeClassifierContext {
    return {
      rawInput: '주변을 둘러본다',
      actionType: 'OBSERVE',
      ...overrides,
    };
  }

  describe('룰 게이트 — 즉시 FREE', () => {
    it('MOVE_LOCATION → FREE (rule)', async () => {
      const decision = await service.classify(
        makeCtx({ actionType: 'MOVE_LOCATION', rawInput: '시장으로 간다' }),
      );
      expect(decision.result).toBe('FREE');
      expect(decision.source).toBe('rule');
      expect(mockLlmCaller.call).not.toHaveBeenCalled();
    });

    it('REST → FREE (rule)', async () => {
      const decision = await service.classify(
        makeCtx({ actionType: 'REST', rawInput: '잠시 쉰다' }),
      );
      expect(decision.result).toBe('FREE');
      expect(decision.source).toBe('rule');
    });

    it('SHOP → FREE (rule)', async () => {
      const decision = await service.classify(
        makeCtx({ actionType: 'SHOP', rawInput: '상점에 들른다' }),
      );
      expect(decision.result).toBe('FREE');
      expect(decision.source).toBe('rule');
    });

    it('EQUIP → FREE (rule)', async () => {
      const decision = await service.classify(
        makeCtx({ actionType: 'EQUIP', rawInput: '검을 장착한다' }),
      );
      expect(decision.result).toBe('FREE');
      expect(decision.source).toBe('rule');
    });
  });

  describe('룰 게이트 — 즉시 CHECK', () => {
    it('FIGHT → CHECK (rule)', async () => {
      const decision = await service.classify(
        makeCtx({ actionType: 'FIGHT', rawInput: '공격한다' }),
      );
      expect(decision.result).toBe('CHECK');
      expect(decision.source).toBe('rule');
      expect(mockLlmCaller.call).not.toHaveBeenCalled();
    });

    it('STEAL → CHECK (rule)', async () => {
      const decision = await service.classify(
        makeCtx({ actionType: 'STEAL', rawInput: '주머니를 턴다' }),
      );
      expect(decision.result).toBe('CHECK');
      expect(decision.source).toBe('rule');
    });

    it('PERSUADE → CHECK (rule)', async () => {
      const decision = await service.classify(
        makeCtx({ actionType: 'PERSUADE', rawInput: '설득한다' }),
      );
      expect(decision.result).toBe('CHECK');
      expect(decision.source).toBe('rule');
    });

    it('THREATEN → CHECK (rule)', async () => {
      const decision = await service.classify(
        makeCtx({ actionType: 'THREATEN', rawInput: '협박한다' }),
      );
      expect(decision.result).toBe('CHECK');
      expect(decision.source).toBe('rule');
    });
  });

  describe('LLM 분기 — 회색지대', () => {
    it('TALK + 자유 발화 → FREE (llm)', async () => {
      mockLlmCaller.call.mockResolvedValue({
        success: true,
        response: { text: '{"result":"FREE","reason":"casual greeting"}' },
      });
      const decision = await service.classify(
        makeCtx({ actionType: 'TALK', rawInput: '안녕이라고 인사한다' }),
      );
      expect(decision.result).toBe('FREE');
      expect(decision.source).toBe('llm');
      expect(mockLlmCaller.call).toHaveBeenCalledTimes(1);
    });

    it('OBSERVE + 단순 묘사 → FREE (llm)', async () => {
      mockLlmCaller.call.mockResolvedValue({
        success: true,
        response: { text: '{"result":"FREE","reason":"no resistance"}' },
      });
      const decision = await service.classify(
        makeCtx({ actionType: 'OBSERVE', rawInput: '태양을 쳐다본다' }),
      );
      expect(decision.result).toBe('FREE');
      expect(decision.source).toBe('llm');
    });

    it('INVESTIGATE + 단서 탐색 → CHECK (llm)', async () => {
      mockLlmCaller.call.mockResolvedValue({
        success: true,
        response: { text: '{"result":"CHECK","reason":"hidden clue"}' },
      });
      const decision = await service.classify(
        makeCtx({
          actionType: 'INVESTIGATE',
          rawInput: '숨겨진 단서를 찾는다',
        }),
      );
      expect(decision.result).toBe('CHECK');
      expect(decision.source).toBe('llm');
    });
  });

  describe('Fallback — 안전한 쪽 (CHECK)', () => {
    it('LLM 실패 → CHECK (fallback)', async () => {
      mockLlmCaller.call.mockResolvedValue({
        success: false,
        error: 'timeout',
      });
      const decision = await service.classify(
        makeCtx({ actionType: 'TALK', rawInput: '말을 건다' }),
      );
      expect(decision.result).toBe('CHECK');
      expect(decision.source).toBe('fallback');
    });

    it('LLM 응답이 JSON 아님 → CHECK (fallback)', async () => {
      mockLlmCaller.call.mockResolvedValue({
        success: true,
        response: { text: '잘 모르겠습니다' },
      });
      const decision = await service.classify(
        makeCtx({ actionType: 'OBSERVE', rawInput: '본다' }),
      );
      expect(decision.result).toBe('CHECK');
      expect(decision.source).toBe('fallback');
    });

    it('LLM 응답이 알 수 없는 result → CHECK (fallback)', async () => {
      mockLlmCaller.call.mockResolvedValue({
        success: true,
        response: { text: '{"result":"MAYBE","reason":"unsure"}' },
      });
      const decision = await service.classify(
        makeCtx({ actionType: 'TALK', rawInput: '말한다' }),
      );
      expect(decision.result).toBe('CHECK');
      expect(decision.source).toBe('fallback');
    });

    it('LLM throw → CHECK (fallback)', async () => {
      mockLlmCaller.call.mockRejectedValue(new Error('network error'));
      const decision = await service.classify(
        makeCtx({ actionType: 'TALK', rawInput: '말한다' }),
      );
      expect(decision.result).toBe('CHECK');
      expect(decision.source).toBe('fallback');
    });
  });

  describe('환경변수 토글', () => {
    it('CHALLENGE_CLASSIFIER_ENABLED=false → 항상 CHECK, llm 호출 안 함', async () => {
      process.env.CHALLENGE_CLASSIFIER_ENABLED = 'false';
      const disabled = new ChallengeClassifierService(
        mockLlmCaller as any,
        mockLlmConfig as any,
      );
      const decision = await disabled.classify(
        makeCtx({ actionType: 'MOVE_LOCATION', rawInput: '간다' }),
      );
      expect(decision.result).toBe('CHECK');
      expect(decision.source).toBe('rule');
      expect(mockLlmCaller.call).not.toHaveBeenCalled();
    });
  });

  describe('컨텍스트 전달', () => {
    it('targetNpcName/locationName/eventTitle 포함 시 user 메시지에 전달', async () => {
      mockLlmCaller.call.mockResolvedValue({
        success: true,
        response: { text: '{"result":"CHECK","reason":"hostile npc"}' },
      });
      await service.classify(
        makeCtx({
          actionType: 'TALK',
          rawInput: '비밀을 캐묻는다',
          targetNpcName: '그림자 길드원',
          targetNpcPosture: 'HOSTILE',
          locationName: '빈민가',
          eventTitle: '의심스러운 만남',
        }),
      );
      const callArg = mockLlmCaller.call.mock.calls[0][0];
      const userMsg = callArg.messages[1].content;
      expect(userMsg).toContain('비밀을 캐묻는다');
      expect(userMsg).toContain('그림자 길드원');
      expect(userMsg).toContain('HOSTILE');
      expect(userMsg).toContain('빈민가');
      expect(userMsg).toContain('의심스러운 만남');
    });
  });
});
