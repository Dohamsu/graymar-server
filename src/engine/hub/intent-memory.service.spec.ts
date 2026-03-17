import { IntentMemoryService, type ActionHistoryEntry } from './intent-memory.service.js';

describe('IntentMemoryService', () => {
  let service: IntentMemoryService;

  beforeEach(() => {
    service = new IntentMemoryService();
  });

  function makeHistory(actionTypes: string[]): ActionHistoryEntry[] {
    return actionTypes.map((actionType) => ({ actionType }));
  }

  it('빈 actionHistory → null', () => {
    expect(service.analyze([])).toBeNull();
  });

  it('actionHistory <4 → null (최소 4회 필요)', () => {
    const history = makeHistory(['THREATEN', 'INVESTIGATE', 'SNEAK']);
    expect(service.analyze(history)).toBeNull();
  });

  it('THREATEN×3 + INVESTIGATE×2 → "공격적 심문"', () => {
    const history = makeHistory([
      'THREATEN', 'THREATEN', 'THREATEN',
      'INVESTIGATE', 'INVESTIGATE',
    ]);
    const result = service.analyze(history);
    expect(result).not.toBeNull();
    expect(result!.some((p) => p.id === 'aggressive_interrogation')).toBe(true);
  });

  it('SNEAK×3 + OBSERVE×3 → "은밀 탐색"', () => {
    const history = makeHistory([
      'SNEAK', 'SNEAK', 'SNEAK',
      'OBSERVE', 'OBSERVE', 'OBSERVE',
    ]);
    const result = service.analyze(history);
    expect(result).not.toBeNull();
    expect(result!.some((p) => p.id === 'stealth_exploration')).toBe(true);
  });

  it('혼합 → 가장 우세한 패턴 반환 (최대 2개)', () => {
    const history = makeHistory([
      'THREATEN', 'THREATEN', 'INVESTIGATE', 'INVESTIGATE',
      'SNEAK', 'OBSERVE',
      'FIGHT', 'FIGHT',
    ]);
    const result = service.analyze(history);
    expect(result).not.toBeNull();
    expect(result!.length).toBeLessThanOrEqual(2);
  });

  it('INVESTIGATE×3 + OBSERVE×2 + SEARCH×1 → "증거 수집"', () => {
    const history = makeHistory([
      'INVESTIGATE', 'INVESTIGATE', 'INVESTIGATE',
      'OBSERVE', 'OBSERVE', 'SEARCH',
    ]);
    const result = service.analyze(history);
    expect(result).not.toBeNull();
    expect(result!.some((p) => p.id === 'evidence_gathering')).toBe(true);
  });

  it('TRADE×2 + BRIBE×2 → "상업적"', () => {
    const history = makeHistory([
      'TRADE', 'TRADE', 'BRIBE', 'BRIBE',
    ]);
    const result = service.analyze(history);
    expect(result).not.toBeNull();
    expect(result!.some((p) => p.id === 'commercial')).toBe(true);
  });

  it('최근 10턴만 분석', () => {
    // 오래된 THREATEN 이력 (10개) + 최근 SNEAK/OBSERVE (6개)
    const old = makeHistory(Array(10).fill('THREATEN'));
    const recent = makeHistory(['SNEAK', 'SNEAK', 'SNEAK', 'OBSERVE', 'OBSERVE', 'OBSERVE']);
    const history = [...old, ...recent];
    const result = service.analyze(history);
    // 최근 10턴에 SNEAK/OBSERVE가 6개 → 은밀 탐색 감지
    expect(result).not.toBeNull();
    expect(result!.some((p) => p.id === 'stealth_exploration')).toBe(true);
  });

  it('renderForContext: 패턴 텍스트 변환', () => {
    const patterns = [
      { id: 'test', label: '테스트', description: '테스트 설명' },
    ];
    const text = service.renderForContext(patterns);
    expect(text).toContain('테스트');
    expect(text).toContain('테스트 설명');
  });
});
