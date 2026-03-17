import { MidSummaryService } from './mid-summary.service.js';
import type { RecentTurnEntry } from './context-builder.service.js';

describe('MidSummaryService', () => {
  let service: MidSummaryService;

  const mockLlmCaller = { callLight: jest.fn().mockResolvedValue('') };
  const mockAiTurnLog = { log: jest.fn() };

  beforeEach(() => {
    service = new MidSummaryService(mockLlmCaller as any, mockAiTurnLog as any);
    jest.clearAllMocks();
  });

  function makeTurn(overrides: Partial<RecentTurnEntry> = {}): RecentTurnEntry {
    return {
      turnNo: 1,
      inputType: 'ACTION',
      rawInput: '주변을 조사한다',
      resolveOutcome: 'SUCCESS',
      narrative: '당신은 주변을 살폈다.',
      ...overrides,
    };
  }

  it('빈 earlyTurns → 빈 문자열', async () => {
    expect(await service.generate([])).toBe('');
  });

  it('5턴 입력 → 요약 생성', async () => {
    const turns = [
      makeTurn({ turnNo: 1, rawInput: '조사한다', resolveOutcome: 'SUCCESS' }),
      makeTurn({ turnNo: 2, rawInput: '대화한다', resolveOutcome: 'PARTIAL' }),
      makeTurn({ turnNo: 3, rawInput: '숨는다', resolveOutcome: 'FAIL' }),
      makeTurn({ turnNo: 4, rawInput: '위협한다', resolveOutcome: 'SUCCESS' }),
      makeTurn({ turnNo: 5, rawInput: '거래한다', resolveOutcome: 'SUCCESS' }),
    ];
    const summary = await service.generate(turns);
    expect(summary.length).toBeGreaterThan(0);
    expect(summary.length).toBeLessThanOrEqual(400);
    expect(summary).toContain('이전 방문에서');
  });

  it('400자 제한 준수', async () => {
    const turns = Array.from({ length: 10 }, (_, i) =>
      makeTurn({
        turnNo: i,
        rawInput: '매우 긴 행동 설명으로 이것저것 많이 합니다 정말 길게',
        narrative: '이것은 매우 긴 내러티브로서 많은 내용을 담고 있습니다. NPC와의 대화와 단서 발견 등.',
      }),
    );
    const summary = await service.generate(turns);
    expect(summary.length).toBeLessThanOrEqual(400);
  });

  it('판정 결과가 포함됨', async () => {
    const turns = [
      makeTurn({ resolveOutcome: 'SUCCESS' }),
      makeTurn({ resolveOutcome: 'SUCCESS' }),
      makeTurn({ resolveOutcome: 'FAIL' }),
    ];
    const summary = await service.generate(turns);
    expect(summary).toContain('성공');
  });

  it('행동 요약이 포함됨', async () => {
    const turns = [makeTurn({ rawInput: '밀수단 단서를 조사' })];
    const summary = await service.generate(turns);
    expect(summary).toContain('밀수단 단서를 조사');
  });

  it('경량 LLM 실패 시 서버 뼈대만 반환', async () => {
    mockLlmCaller.callLight.mockRejectedValueOnce(new Error('timeout'));
    const turns = [makeTurn()];
    const summary = await service.generate(turns);
    expect(summary.length).toBeGreaterThan(0);
    expect(summary).toContain('이전 방문에서');
  });
});
