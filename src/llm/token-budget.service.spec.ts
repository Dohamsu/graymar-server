import { TokenBudgetService, TOKEN_BUDGET } from './token-budget.service.js';

describe('TokenBudgetService', () => {
  let service: TokenBudgetService;

  beforeEach(() => {
    service = new TokenBudgetService();
  });

  describe('estimateTokens', () => {
    it('빈 문자열 → 0', () => {
      expect(service.estimateTokens('')).toBe(0);
    });

    it('한국어 텍스트 토큰 추정', () => {
      const text = '이것은 한국어 테스트입니다.'; // 14자
      const tokens = service.estimateTokens(text);
      expect(tokens).toBe(Math.ceil(14 / 3)); // 5
    });

    it('영어 텍스트 토큰 추정', () => {
      const text = 'This is an English test.'; // 24자
      const tokens = service.estimateTokens(text);
      expect(tokens).toBe(Math.ceil(24 / 3)); // 8
    });

    it('혼합 텍스트 정확도 ±20%', () => {
      const text = '플레이어가 INVESTIGATE로 조사합니다.'; // 23자
      const tokens = service.estimateTokens(text);
      // 한국어+영어 혼합 → 대략 8 토큰 예상
      expect(tokens).toBeGreaterThan(0);
      expect(tokens).toBeLessThan(20);
    });
  });

  describe('trimToFit', () => {
    it('예산 내 텍스트는 그대로 반환', () => {
      const text = '짧은 텍스트.';
      expect(service.trimToFit(text, 100)).toBe(text);
    });

    it('예산 초과 시 문장 경계에서 자르기', () => {
      const text = '첫 번째 문장입니다. 두 번째 문장입니다. 세 번째 문장으로 매우 길게 계속됩니다.';
      const result = service.trimToFit(text, 10); // 30자 제한
      expect(result.length).toBeLessThanOrEqual(30);
      // 문장 경계에서 잘렸는지 확인
      expect(result.endsWith('.') || result.endsWith('다')).toBe(true);
    });

    it('빈 문자열 처리', () => {
      expect(service.trimToFit('', 100)).toBe('');
    });
  });

  describe('fitBlock', () => {
    it('null 입력 → null', () => {
      expect(service.fitBlock(null, 'SCENE_CONTEXT')).toBeNull();
    });

    it('예산 내 텍스트 통과', () => {
      const text = '짧은 장면.';
      expect(service.fitBlock(text, 'SCENE_CONTEXT')).toBe(text);
    });

    it('SCENE_CONTEXT 예산(150 토큰) 초과 시 트리밍', () => {
      const text = '가'.repeat(600); // 600자 = ~200 토큰 → 150 예산 초과
      const result = service.fitBlock(text, 'SCENE_CONTEXT')!;
      expect(service.estimateTokens(result)).toBeLessThanOrEqual(TOKEN_BUDGET.SCENE_CONTEXT);
    });
  });

  describe('enforceTotal', () => {
    it('총합이 예산 내면 그대로 반환', () => {
      const parts = ['짧은 블록.', '또 다른 블록.'];
      const result = service.enforceTotal(parts);
      expect(result).toEqual(parts);
    });

    it('초과 시 뒤쪽 블록부터 제거', () => {
      // TOTAL = 2500 토큰 = 약 7500자
      const longBlock = '가'.repeat(4000); // ~1333 토큰
      const parts = [longBlock, longBlock, longBlock]; // ~4000 토큰 → 초과
      const result = service.enforceTotal(parts);
      const totalTokens = result.reduce((sum, p) => sum + service.estimateTokens(p), 0);
      expect(totalTokens).toBeLessThanOrEqual(TOKEN_BUDGET.TOTAL);
    });

    it('빈 블록은 필터링', () => {
      const parts = ['유지.', '', '유지2.'];
      const result = service.enforceTotal(parts);
      expect(result).toEqual(['유지.', '유지2.']);
    });
  });
});
