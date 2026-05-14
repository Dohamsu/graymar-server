/* eslint-disable @typescript-eslint/no-unsafe-argument */
import {
  NpcReactionDirectorService,
  type NpcReactionContext,
} from './npc-reaction-director.service.js';
import type { NPCState } from '../db/types/npc-state.js';

describe('NpcReactionDirectorService', () => {
  let service: NpcReactionDirectorService;
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
    delete process.env.NPC_REACTION_DIRECTOR_ENABLED;
    service = new NpcReactionDirectorService(
      mockLlmCaller as any,
      mockLlmConfig as any,
    );
  });

  function makeNpcState(overrides: Partial<NPCState> = {}): NPCState {
    return {
      npcId: 'NPC_TEST',
      basePosture: 'CAUTIOUS',
      relationship: { trust: 0, fear: 0, suspicion: 0 },
      knownFacts: [],
      relationSummary: 'CAUTIOUS, trust 0',
      encounterCount: 1,
      narrativeAppearanceCount: 0,
      llmRecentDialogues: [],
      bgRoleHints: [],
      lastSeenTurn: null,
      lastSeenLocation: null,
      trustToPlayer: 0,
      suspicion: 0,
      flags: [],
      relations: {},
      posture: 'CAUTIOUS',
      memoryFacts: [],
      emotional: {
        trust: 0,
        fear: 0,
        respect: 0,
        suspicion: 0,
        attachment: 0,
      },
      ...overrides,
    } as unknown as NPCState;
  }

  function makeCtx(
    overrides: Partial<NpcReactionContext> = {},
  ): NpcReactionContext {
    return {
      npcId: 'NPC_TEST',
      npcDisplayName: '테스트 NPC',
      npcRole: '상인',
      personalityCore: '경계심 많은 중년',
      speechStyle: '하오체, 짧고 단호한 말투',
      signature: ['눈을 가늘게 뜬다'],
      softSpot: '딸 이야기',
      innerConflict: '돈과 양심 사이',
      npcState: makeNpcState(),
      rawInput: '말을 건다',
      actionType: 'TALK',
      resolveOutcome: 'PARTIAL',
      ...overrides,
    };
  }

  describe('LLM 호출 + 결과 파싱', () => {
    it('valid JSON → parsed result with source=llm (E안 톤 필드 포함)', async () => {
      mockLlmCaller.call.mockResolvedValue({
        success: true,
        response: {
          text: '{"reactionType":"PROBE","immediateGoal":"신원을 떠보려 한다","refusalLevel":"POLITE","openingStance":"닫힌 자세로 거리를 둠","emotionalShiftHint":{"trust":0,"fear":0,"respect":1,"suspicion":2},"dialogueHint":"가볍게 떠보면서 정보를 얻으려 함","voiceQuality":"긴장된 낮은 톤","emotionalUndertone":"의심 깔린 호기심","bodyLanguageMood":"닫힌 자세, 손목만 살짝"}',
        },
      });

      const result = await service.direct(makeCtx());
      expect(result).not.toBeNull();
      expect(result!.reactionType).toBe('PROBE');
      expect(result!.refusalLevel).toBe('POLITE');
      expect(result!.immediateGoal).toBe('신원을 떠보려 한다');
      expect(result!.emotionalShiftHint.suspicion).toBe(2);
      expect(result!.voiceQuality).toBe('긴장된 낮은 톤');
      expect(result!.emotionalUndertone).toBe('의심 깔린 호기심');
      expect(result!.bodyLanguageMood).toBe('닫힌 자세, 손목만 살짝');
      expect(result!.source).toBe('llm');
    });

    it('톤 3축 누락 → 빈 문자열 (parse는 성공)', async () => {
      mockLlmCaller.call.mockResolvedValue({
        success: true,
        response: {
          text: '{"reactionType":"WELCOME","immediateGoal":"x","refusalLevel":"NONE","openingStance":"y","emotionalShiftHint":{"trust":0,"fear":0,"respect":0,"suspicion":0},"dialogueHint":"z"}',
        },
      });
      const r = await service.direct(makeCtx());
      expect(r!.voiceQuality).toBe('');
      expect(r!.emotionalUndertone).toBe('');
      expect(r!.bodyLanguageMood).toBe('');
      expect(r!.source).toBe('llm');
    });

    it('all 7 reactionTypes valid', async () => {
      const types = [
        'WELCOME',
        'OPEN_UP',
        'PROBE',
        'DEFLECT',
        'DISMISS',
        'THREATEN',
        'SILENCE',
      ];
      for (const t of types) {
        mockLlmCaller.call.mockResolvedValue({
          success: true,
          response: {
            text: `{"reactionType":"${t}","immediateGoal":"x","refusalLevel":"NONE","openingStance":"y","emotionalShiftHint":{"trust":0,"fear":0,"respect":0,"suspicion":0},"dialogueHint":"z"}`,
          },
        });
        const r = await service.direct(makeCtx());
        expect(r!.reactionType).toBe(t);
      }
    });

    it('emotionalShiftHint clamped to [-3, 3]', async () => {
      mockLlmCaller.call.mockResolvedValue({
        success: true,
        response: {
          text: '{"reactionType":"WELCOME","immediateGoal":"","refusalLevel":"NONE","openingStance":"","emotionalShiftHint":{"trust":99,"fear":-50,"respect":2,"suspicion":0},"dialogueHint":""}',
        },
      });
      const r = await service.direct(makeCtx());
      expect(r!.emotionalShiftHint.trust).toBe(3);
      expect(r!.emotionalShiftHint.fear).toBe(-3);
      expect(r!.emotionalShiftHint.respect).toBe(2);
    });
  });

  describe('Fallback — LLM 실패 시 posture 기반 안전 결정', () => {
    it('HOSTILE + FAIL → THREATEN + HOSTILE', async () => {
      mockLlmCaller.call.mockResolvedValue({ success: false });
      const r = await service.direct(
        makeCtx({
          npcState: makeNpcState({ posture: 'HOSTILE' as any }),
          resolveOutcome: 'FAIL',
        }),
      );
      expect(r!.reactionType).toBe('THREATEN');
      expect(r!.refusalLevel).toBe('HOSTILE');
      expect(r!.source).toBe('fallback');
    });

    it('FRIENDLY + SUCCESS → WELCOME + NONE', async () => {
      mockLlmCaller.call.mockResolvedValue({ success: false });
      const r = await service.direct(
        makeCtx({
          npcState: makeNpcState({ posture: 'FRIENDLY' as any }),
          resolveOutcome: 'SUCCESS',
        }),
      );
      expect(r!.reactionType).toBe('WELCOME');
      expect(r!.refusalLevel).toBe('NONE');
    });

    it('FEARFUL + FAIL → SILENCE + POLITE', async () => {
      mockLlmCaller.call.mockResolvedValue({ success: false });
      const r = await service.direct(
        makeCtx({
          npcState: makeNpcState({ posture: 'FEARFUL' as any }),
          resolveOutcome: 'FAIL',
        }),
      );
      expect(r!.reactionType).toBe('SILENCE');
    });

    it('CAUTIOUS + SUCCESS → OPEN_UP', async () => {
      mockLlmCaller.call.mockResolvedValue({ success: false });
      const r = await service.direct(
        makeCtx({
          npcState: makeNpcState({ posture: 'CAUTIOUS' as any }),
          resolveOutcome: 'SUCCESS',
        }),
      );
      expect(r!.reactionType).toBe('OPEN_UP');
    });

    it('JSON 파싱 실패 → fallback', async () => {
      mockLlmCaller.call.mockResolvedValue({
        success: true,
        response: { text: '잘 모르겠습니다' },
      });
      const r = await service.direct(makeCtx());
      expect(r!.source).toBe('fallback');
    });

    it('알 수 없는 reactionType → fallback', async () => {
      mockLlmCaller.call.mockResolvedValue({
        success: true,
        response: {
          text: '{"reactionType":"UNKNOWN","immediateGoal":"","refusalLevel":"NONE","openingStance":"","emotionalShiftHint":{"trust":0,"fear":0,"respect":0,"suspicion":0},"dialogueHint":""}',
        },
      });
      const r = await service.direct(makeCtx());
      expect(r!.source).toBe('fallback');
    });

    it('LLM throw → fallback', async () => {
      mockLlmCaller.call.mockRejectedValue(new Error('network error'));
      const r = await service.direct(makeCtx());
      expect(r!.source).toBe('fallback');
    });
  });

  describe('환경변수 토글', () => {
    it('NPC_REACTION_DIRECTOR_ENABLED=false → null 반환, llm 호출 안 함', async () => {
      process.env.NPC_REACTION_DIRECTOR_ENABLED = 'false';
      const disabled = new NpcReactionDirectorService(
        mockLlmCaller as any,
        mockLlmConfig as any,
      );
      const r = await disabled.direct(makeCtx());
      expect(r).toBeNull();
      expect(mockLlmCaller.call).not.toHaveBeenCalled();
    });
  });

  describe('컨텍스트 전달 (user 메시지)', () => {
    it('NPC 정보 + 행동 + 판정이 user 메시지에 포함', async () => {
      mockLlmCaller.call.mockResolvedValue({
        success: true,
        response: {
          text: '{"reactionType":"PROBE","immediateGoal":"x","refusalLevel":"NONE","openingStance":"y","emotionalShiftHint":{"trust":0,"fear":0,"respect":0,"suspicion":0},"dialogueHint":"z"}',
        },
      });
      await service.direct(
        makeCtx({
          rawInput: '비밀을 캐묻는다',
          actionType: 'INVESTIGATE',
          resolveOutcome: 'FAIL',
          locationName: '시장 거리',
          hubHeat: 75,
          recentNpcDialogue: '"가까이 오지 마시오."',
        }),
      );
      const userMsg = mockLlmCaller.call.mock.calls[0][0].messages[1]
        .content as string;
      expect(userMsg).toContain('테스트 NPC');
      expect(userMsg).toContain('상인');
      expect(userMsg).toContain('비밀을 캐묻는다');
      expect(userMsg).toContain('INVESTIGATE');
      expect(userMsg).toContain('FAIL');
      expect(userMsg).toContain('시장 거리');
      expect(userMsg).toContain('75');
      expect(userMsg).toContain('가까이 오지 마시오');
      expect(userMsg).toContain('경계심 많은 중년');
      expect(userMsg).toContain('하오체');
    });

    it('recentNpcDialogues 배열 → 최신순 T-1/T-2/T-3 라벨로 주입', async () => {
      mockLlmCaller.call.mockResolvedValue({
        success: true,
        response: {
          text: '{"reactionType":"PROBE","immediateGoal":"x","refusalLevel":"NONE","openingStance":"y","emotionalShiftHint":{"trust":0,"fear":0,"respect":0,"suspicion":0},"dialogueHint":"z"}',
        },
      });
      await service.direct(
        makeCtx({
          recentNpcDialogues: [
            '직전 턴 NPC가 말하기를 가까이 오지 마시오',
            '두 턴 전 NPC가 누구신지 묻소',
            '세 턴 전 NPC가 처음 본 얼굴이라 했소',
          ],
        }),
      );
      // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
      const userMsg = mockLlmCaller.call.mock.calls[0][0].messages[1]
        .content as string;
      expect(userMsg).toContain('[이 NPC 최근 대화 흐름');
      expect(userMsg).toContain('T-1:');
      expect(userMsg).toContain('T-2:');
      expect(userMsg).toContain('T-3:');
      expect(userMsg).toContain('가까이 오지 마시오');
      expect(userMsg).toContain('누구신지 묻소');
      expect(userMsg).toContain('처음 본 얼굴');
    });

    it('recentPlayerActions 배열 → 최신순 행동 흐름 주입', async () => {
      mockLlmCaller.call.mockResolvedValue({
        success: true,
        response: {
          text: '{"reactionType":"PROBE","immediateGoal":"x","refusalLevel":"NONE","openingStance":"y","emotionalShiftHint":{"trust":0,"fear":0,"respect":0,"suspicion":0},"dialogueHint":"z"}',
        },
      });
      await service.direct(
        makeCtx({
          recentPlayerActions: [
            { rawInput: '돈을 건넨다', actionType: 'BRIBE', outcome: 'FAIL' },
            {
              rawInput: '신분을 묻는다',
              actionType: 'INVESTIGATE',
              outcome: 'PARTIAL',
            },
          ],
        }),
      );
      // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
      const userMsg = mockLlmCaller.call.mock.calls[0][0].messages[1]
        .content as string;
      expect(userMsg).toContain('[최근 플레이어 행동');
      expect(userMsg).toContain('[BRIBE/FAIL]');
      expect(userMsg).toContain('돈을 건넨다');
      expect(userMsg).toContain('[INVESTIGATE/PARTIAL]');
      expect(userMsg).toContain('신분을 묻는다');
    });

    it('recentNpcDialogues 첫 항목 220자 cap, 두 번째 이후 120자 cap', async () => {
      mockLlmCaller.call.mockResolvedValue({
        success: true,
        response: {
          text: '{"reactionType":"PROBE","immediateGoal":"x","refusalLevel":"NONE","openingStance":"y","emotionalShiftHint":{"trust":0,"fear":0,"respect":0,"suspicion":0},"dialogueHint":"z"}',
        },
      });
      const longText = '가'.repeat(400);
      await service.direct(
        makeCtx({
          recentNpcDialogues: [longText, longText],
        }),
      );
      // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
      const userMsg = mockLlmCaller.call.mock.calls[0][0].messages[1]
        .content as string;
      // T-1: 220자 + 말줄임표
      expect(userMsg).toMatch(/T-1: 가{220}…/);
      // T-2: 120자 + 말줄임표
      expect(userMsg).toMatch(/T-2: 가{120}…/);
    });
  });

  describe('R2 사후 가드 — 같은 reactionType 4회 연속 차단', () => {
    function mockResp(type: string, refusal = 'POLITE') {
      mockLlmCaller.call.mockResolvedValue({
        success: true,
        response: {
          text: `{"reactionType":"${type}","immediateGoal":"x","refusalLevel":"${refusal}","openingStance":"y","emotionalShiftHint":{"trust":0,"fear":0,"respect":0,"suspicion":0},"dialogueHint":"z"}`,
        },
      });
    }

    it('PROBE×3 + THREATEN 행동 → THREATEN 으로 교정, refusalLevel FIRM 이상', async () => {
      mockResp('PROBE', 'POLITE');
      const r = await service.direct(
        makeCtx({
          actionType: 'THREATEN',
          resolveOutcome: 'SUCCESS',
          recentReactionTypes: ['PROBE', 'PROBE', 'PROBE'],
        }),
      );
      expect(r!.reactionType).toBe('THREATEN');
      // POLITE(1) → FIRM(2) 이상으로 강화
      expect(['FIRM', 'HOSTILE']).toContain(r!.refusalLevel);
      expect(r!.source).toBe('llm');
    });

    it('PROBE×3 + outcome FAIL → DEFLECT 로 교정, refusal 한 단계 강화', async () => {
      mockResp('PROBE', 'POLITE');
      const r = await service.direct(
        makeCtx({
          actionType: 'INVESTIGATE',
          resolveOutcome: 'FAIL',
          recentReactionTypes: ['PROBE', 'PROBE', 'PROBE'],
        }),
      );
      expect(r!.reactionType).toBe('DEFLECT');
      expect(r!.refusalLevel).toBe('FIRM');
    });

    it('PROBE×3 + outcome SUCCESS → OPEN_UP 로 교정, refusal 한 단계 완화', async () => {
      mockResp('PROBE', 'POLITE');
      const r = await service.direct(
        makeCtx({
          actionType: 'TALK',
          resolveOutcome: 'SUCCESS',
          recentReactionTypes: ['PROBE', 'PROBE', 'PROBE'],
        }),
      );
      expect(r!.reactionType).toBe('OPEN_UP');
      expect(r!.refusalLevel).toBe('NONE');
    });

    it('DEFLECT×3 + FAIL → DISMISS 로 교정', async () => {
      mockResp('DEFLECT', 'FIRM');
      const r = await service.direct(
        makeCtx({
          actionType: 'INVESTIGATE',
          resolveOutcome: 'FAIL',
          recentReactionTypes: ['DEFLECT', 'DEFLECT', 'DEFLECT'],
        }),
      );
      expect(r!.reactionType).toBe('DISMISS');
      expect(r!.refusalLevel).toBe('HOSTILE');
    });

    it('직전 3회가 모두 같지 않으면 가드 미작동 (LLM 결과 그대로)', async () => {
      mockResp('PROBE', 'POLITE');
      const r = await service.direct(
        makeCtx({
          actionType: 'INVESTIGATE',
          resolveOutcome: 'PARTIAL',
          recentReactionTypes: ['PROBE', 'PROBE', 'DEFLECT'],
        }),
      );
      expect(r!.reactionType).toBe('PROBE');
      expect(r!.refusalLevel).toBe('POLITE');
    });

    it('LLM 결과가 직전 흐름과 다르면 가드 미작동 (자연 변화 존중)', async () => {
      mockResp('OPEN_UP', 'NONE');
      const r = await service.direct(
        makeCtx({
          actionType: 'TALK',
          resolveOutcome: 'SUCCESS',
          recentReactionTypes: ['PROBE', 'PROBE', 'PROBE'],
        }),
      );
      expect(r!.reactionType).toBe('OPEN_UP');
      expect(r!.refusalLevel).toBe('NONE');
    });

    it('recentReactionTypes 미설정 → 가드 미작동 (하위 호환)', async () => {
      mockResp('PROBE', 'POLITE');
      const r = await service.direct(
        makeCtx({
          actionType: 'INVESTIGATE',
          resolveOutcome: 'FAIL',
          // recentReactionTypes 미설정
        }),
      );
      expect(r!.reactionType).toBe('PROBE');
    });

    it('recentReactionTypes 길이 < 3 → 가드 미작동', async () => {
      mockResp('PROBE', 'POLITE');
      const r = await service.direct(
        makeCtx({
          actionType: 'INVESTIGATE',
          resolveOutcome: 'FAIL',
          recentReactionTypes: ['PROBE', 'PROBE'],
        }),
      );
      expect(r!.reactionType).toBe('PROBE');
    });
  });
});
