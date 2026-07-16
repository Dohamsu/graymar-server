/* eslint-disable @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access */
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

  // [arch/76 D3] 명백한 도전 행동도 이제 nano 감정을 타되 result는 CHECK로 고정
  describe('도전 행동 — result CHECK 고정 + nano 감정', () => {
    it('FIGHT → nano 호출됨, result CHECK 고정', async () => {
      mockLlmCaller.call.mockResolvedValue({
        success: true,
        response: {
          text: '{"result":"CHECK","statHint":"str","difficultyMod":0,"plausibility":"NORMAL","physicalImpact":true,"reason":"전투"}',
        },
      });
      const d = await service.classify(
        makeCtx({ actionType: 'FIGHT', rawInput: '공격한다' }),
      );
      expect(d.result).toBe('CHECK');
      expect(d.physicalImpact).toBe(true);
      expect(mockLlmCaller.call).toHaveBeenCalledTimes(1);
    });

    it('FIGHT + nano가 FREE 판단해도 result는 CHECK로 고정(appraisal 유지)', async () => {
      mockLlmCaller.call.mockResolvedValue({
        success: true,
        response: {
          text: '{"result":"FREE","statHint":"str","difficultyMod":-1,"plausibility":"NORMAL","physicalImpact":true,"reason":"x"}',
        },
      });
      const d = await service.classify(makeCtx({ actionType: 'FIGHT' }));
      expect(d.result).toBe('CHECK');
      expect(d.statHint).toBe('str');
      expect(d.difficultyMod).toBe(-1);
    });

    it('마법-as-FIGHT → IMPLAUSIBLE 감지 + physicalImpact false 강제(불길 흔적 방지)', async () => {
      mockLlmCaller.call.mockResolvedValue({
        success: true,
        response: {
          text: '{"result":"CHECK","statHint":"str","difficultyMod":-2,"plausibility":"IMPLAUSIBLE","physicalImpact":true,"reason":"마법"}',
        },
      });
      const d = await service.classify(
        makeCtx({ actionType: 'FIGHT', rawInput: '마법으로 불길을 일으킨다' }),
      );
      expect(d.result).toBe('CHECK');
      expect(d.plausibility).toBe('IMPLAUSIBLE');
      // nano가 physicalImpact:true라 해도 IMPLAUSIBLE이면 서버가 false로 강제
      expect(d.physicalImpact).toBe(false);
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

  // [arch/76 D3] 행동-특정 감정 파라미터 (statHint/difficultyMod/plausibility)
  describe('행동 감정 — statHint / difficultyMod / plausibility', () => {
    it('유효 statHint + 난이도 + plausibility 파싱', async () => {
      mockLlmCaller.call.mockResolvedValue({
        success: true,
        response: {
          text: '{"result":"CHECK","statHint":"dex","difficultyMod":-1,"plausibility":"UNUSUAL","reason":"곡예"}',
        },
      });
      const d = await service.classify(
        makeCtx({ actionType: 'TALK', rawInput: '벽을 타 넘어 춤춘다' }),
      );
      expect(d.statHint).toBe('dex');
      expect(d.difficultyMod).toBe(-1);
      expect(d.plausibility).toBe('UNUSUAL');
    });

    it('허용되지 않은 statHint(maxHP) → null로 폐기', async () => {
      mockLlmCaller.call.mockResolvedValue({
        success: true,
        response: {
          text: '{"result":"CHECK","statHint":"maxHP","difficultyMod":0,"plausibility":"NORMAL","reason":"x"}',
        },
      });
      const d = await service.classify(makeCtx({ actionType: 'OBSERVE' }));
      expect(d.statHint).toBeNull();
    });

    it('difficultyMod 범위 초과 → [-2,+2] 클램프', async () => {
      mockLlmCaller.call.mockResolvedValue({
        success: true,
        response: {
          text: '{"result":"CHECK","statHint":null,"difficultyMod":-9,"plausibility":"IMPLAUSIBLE","reason":"무모"}',
        },
      });
      const d = await service.classify(makeCtx({ actionType: 'TALK' }));
      expect(d.difficultyMod).toBe(-2);
      expect(d.plausibility).toBe('IMPLAUSIBLE');
    });

    it('알 수 없는 plausibility → NORMAL 기본', async () => {
      mockLlmCaller.call.mockResolvedValue({
        success: true,
        response: {
          text: '{"result":"FREE","statHint":"wit","difficultyMod":2,"plausibility":"MAGIC","reason":"x"}',
        },
      });
      const d = await service.classify(makeCtx({ actionType: 'TALK' }));
      expect(d.plausibility).toBe('NORMAL');
      expect(d.difficultyMod).toBe(2);
      expect(d.statHint).toBe('wit');
    });
  });

  // [arch/76 D3-b′] socialImpact — 행동 내용 기반 감정 보정 파싱·검증
  describe('socialImpact — 감정 탈버킷 (D3-b′)', () => {
    it('유효 socialImpact 파싱 + 축별 ±5 클램프', async () => {
      mockLlmCaller.call.mockResolvedValue({
        success: true,
        response: {
          text: '{"result":"CHECK","statHint":"cha","difficultyMod":0,"plausibility":"UNUSUAL","socialImpact":{"trust":-1,"fear":9,"respect":-2,"suspicion":4,"attachment":0},"reason":"기행"}',
        },
      });
      const d = await service.classify(
        makeCtx({ actionType: 'TALK', rawInput: '죽은 쥐를 카운터에 올린다' }),
      );
      expect(d.socialImpact).toEqual({
        trust: -1,
        fear: 5, // 9 → 클램프
        respect: -2,
        suspicion: 4,
        attachment: 0,
      });
    });

    it('전 축 0이면 null — 기존 테이블 100% 적용 신호', async () => {
      mockLlmCaller.call.mockResolvedValue({
        success: true,
        response: {
          text: '{"result":"FREE","statHint":null,"difficultyMod":0,"plausibility":"NORMAL","socialImpact":{"trust":0,"fear":0,"respect":0,"suspicion":0,"attachment":0},"reason":"평범"}',
        },
      });
      const d = await service.classify(makeCtx({ actionType: 'TALK' }));
      expect(d.socialImpact).toBeNull();
    });

    it('socialImpact 누락 → null (하위 호환)', async () => {
      mockLlmCaller.call.mockResolvedValue({
        success: true,
        response: {
          text: '{"result":"CHECK","statHint":"per","difficultyMod":0,"plausibility":"NORMAL","reason":"x"}',
        },
      });
      const d = await service.classify(makeCtx({ actionType: 'OBSERVE' }));
      expect(d.socialImpact).toBeNull();
    });

    it('IMPLAUSIBLE 허풍은 양수 trust 차단 — 서버 강제', async () => {
      mockLlmCaller.call.mockResolvedValue({
        success: true,
        response: {
          text: '{"result":"CHECK","statHint":"cha","difficultyMod":-2,"plausibility":"IMPLAUSIBLE","socialImpact":{"trust":4,"fear":0,"respect":0,"suspicion":3,"attachment":0},"reason":"허풍"}',
        },
      });
      const d = await service.classify(
        makeCtx({ actionType: 'PERSUADE', rawInput: '마법으로 매혹한다' }),
      );
      expect(d.socialImpact).toEqual({
        trust: 0, // 양수 trust 차단
        fear: 0,
        respect: 0,
        suspicion: 3,
        attachment: 0,
      });
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
