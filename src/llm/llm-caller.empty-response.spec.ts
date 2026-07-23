// 빈 LLM 응답 방어 (arch/25 D-8 백로그 ①)
// 0토큰·공백 응답이 success로 반환되어 빈 서술이 llmStatus=DONE으로 커밋되던 경로 차단 검증.
// 실측 배경: run 71637853 — 31B 12턴 중 5턴 빈 서술 전부 DONE (retry-llm 게이트 미발동).
import { LlmCallerService } from './llm-caller.service.js';

type GenerateFn = (req: unknown) => Promise<{
  text: string;
  model: string;
  promptTokens?: number;
  completionTokens?: number;
}>;

function makeCaller(primaryGen: GenerateFn, fallbackGen?: GenerateFn) {
  const primary = { name: 'openai', generate: jest.fn(primaryGen) };
  const fallback = fallbackGen
    ? { name: 'openai-fallback', generate: jest.fn(fallbackGen) }
    : primary;
  const registry = {
    getPrimary: () => primary,
    getFallback: () => fallback,
    getByName: () => primary,
  };
  const configService = {
    get: () => ({
      maxRetries: 2,
      fallbackModel: fallbackGen ? 'openai/gpt-4.1-mini' : undefined,
    }),
    getLightModelConfig: () => ({
      provider: 'openai',
      model: 'gpt-4.1-nano',
      timeoutMs: 5000,
    }),
  };
  const caller = new LlmCallerService(
    registry as never,
    configService as never,
  );
  return { caller, primary, fallback };
}

const EMPTY = { text: '', model: 'google/gemma-4-31b-it', completionTokens: 0 };
const OK = { text: '서술 본문', model: 'google/gemma-4-31b-it' };

describe('LlmCallerService 빈 응답 방어', () => {
  it('primary 빈 응답 → 재시도로 정상 응답이면 success', async () => {
    let n = 0;
    const { caller } = makeCaller(() =>
      Promise.resolve(++n === 1 ? EMPTY : OK),
    );
    const result = await caller.call({ messages: [] } as never, 'narrative');
    expect(result.success).toBe(true);
    expect(result.response?.text).toBe('서술 본문');
    expect(result.attempts).toBe(2);
  });

  it('primary 연속 빈 응답 → fallback 모델로 성공', async () => {
    const { caller, fallback } = makeCaller(
      () => Promise.resolve(EMPTY),
      () =>
        Promise.resolve({ text: '폴백 서술', model: 'openai/gpt-4.1-mini' }),
    );
    const result = await caller.call({ messages: [] } as never, 'narrative');
    expect(result.success).toBe(true);
    expect(result.response?.text).toBe('폴백 서술');
    expect(fallback.generate).toHaveBeenCalledTimes(1);
  });

  it('fallback까지 빈 응답 → success=false (빈 성공 반환 금지)', async () => {
    const { caller } = makeCaller(
      () => Promise.resolve(EMPTY),
      () => Promise.resolve({ ...EMPTY, model: 'openai/gpt-4.1-mini' }),
    );
    const result = await caller.call({ messages: [] } as never, 'narrative');
    expect(result.success).toBe(false);
    expect(result.response).toBeUndefined();
  });

  it('공백 문자만 있는 응답도 빈 응답으로 취급', async () => {
    const { caller } = makeCaller(
      () => Promise.resolve({ text: '  \n\t ', model: 'm' }),
      () =>
        Promise.resolve({ text: '폴백 서술', model: 'openai/gpt-4.1-mini' }),
    );
    const result = await caller.call({ messages: [] } as never, 'narrative');
    expect(result.success).toBe(true);
    expect(result.response?.text).toBe('폴백 서술');
  });

  it('정상 응답은 1회 시도로 통과 (회귀 가드)', async () => {
    const { caller, primary } = makeCaller(() => Promise.resolve(OK));
    const result = await caller.call({ messages: [] } as never, 'narrative');
    expect(result.success).toBe(true);
    expect(result.attempts).toBe(1);
    expect(primary.generate).toHaveBeenCalledTimes(1);
  });
});
