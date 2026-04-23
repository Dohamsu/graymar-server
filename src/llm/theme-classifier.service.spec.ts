// architecture/44 §이슈② — 테마 분류 검증

import { ThemeClassifierService } from './theme-classifier.service.js';
import {
  aggregateRecentThemes,
  getSaturatedThemes,
  pushNarrativeTheme,
  MAX_NARRATIVE_THEMES,
} from '../db/types/narrative-theme.js';

describe('ThemeClassifierService', () => {
  let service: ThemeClassifierService;

  beforeEach(() => {
    service = new ThemeClassifierService();
  });

  describe('WARNING — 자중/경고', () => {
    it('"자중하시오" → WARNING', () => {
      expect(service.classify('자중하시오')).toBe('WARNING');
    });
    it('"너무 깊게 파고들지 마시오" → WARNING (동의어)', () => {
      expect(service.classify('너무 깊게 파고들지 마시오')).toBe('WARNING');
    });
    it('"발을 들이지 마시오" → WARNING', () => {
      expect(service.classify('발을 들이지 마시오')).toBe('WARNING');
    });
    it('"조심하시오, 위험하오" → WARNING', () => {
      expect(service.classify('조심하시오, 위험하오')).toBe('WARNING');
    });
  });

  describe('SUSPICION — 의심', () => {
    it('"무슨 속셈이오" → SUSPICION', () => {
      expect(service.classify('무슨 속셈이오')).toBe('SUSPICION');
    });
    it('"뭘 노리시오" → SUSPICION', () => {
      expect(service.classify('뭘 노리시오')).toBe('SUSPICION');
    });
  });

  describe('THREAT — 위협 (WARNING 앞 우선)', () => {
    it('"죽여버리겠다" → THREAT', () => {
      expect(service.classify('죽여버리겠다')).toBe('THREAT');
    });
    it('"가만 안 두겠다" → THREAT', () => {
      expect(service.classify('가만 안 두겠다')).toBe('THREAT');
    });
  });

  describe('REASSURE — 안심', () => {
    it('"걱정 마시오" → REASSURE', () => {
      expect(service.classify('걱정 마시오')).toBe('REASSURE');
    });
  });

  describe('INFO_REQUEST / GOSSIP / FAREWELL', () => {
    it('"말해 주시오" → INFO_REQUEST', () => {
      expect(service.classify('말해 주시오')).toBe('INFO_REQUEST');
    });
    it('"소문을 들었소" → GOSSIP', () => {
      expect(service.classify('소문을 들었소')).toBe('GOSSIP');
    });
    it('"그럼 이만 가 보겠소" → FAREWELL', () => {
      expect(service.classify('그럼 이만 가 보겠소')).toBe('FAREWELL');
    });
  });

  describe('OTHER — 분류 불가', () => {
    it('"날씨가 좋소" → OTHER', () => {
      expect(service.classify('날씨가 좋소')).toBe('OTHER');
    });
    it('빈 문자열 → OTHER', () => {
      expect(service.classify('')).toBe('OTHER');
    });
  });
});

describe('narrative-theme utilities', () => {
  it('pushNarrativeTheme: 최대 10개 유지 (FIFO)', () => {
    let list: ReturnType<typeof pushNarrativeTheme> = [];
    for (let i = 1; i <= MAX_NARRATIVE_THEMES + 3; i++) {
      list = pushNarrativeTheme(list, {
        turnNo: i,
        npcId: `NPC_${i}`,
        theme: 'WARNING',
        snippet: `t${i}`,
      });
    }
    expect(list.length).toBe(MAX_NARRATIVE_THEMES);
    expect(list[0].turnNo).toBe(4); // 1,2,3 제거됨
    expect(list[list.length - 1].turnNo).toBe(MAX_NARRATIVE_THEMES + 3);
  });

  it('aggregateRecentThemes: 3턴 윈도우 내 카운트', () => {
    const entries = [
      { turnNo: 1, npcId: 'A', theme: 'WARNING' as const, snippet: '' },
      { turnNo: 2, npcId: 'B', theme: 'WARNING' as const, snippet: '' },
      { turnNo: 3, npcId: 'C', theme: 'WARNING' as const, snippet: '' },
      { turnNo: 4, npcId: 'D', theme: 'SUSPICION' as const, snippet: '' },
    ];
    const counts = aggregateRecentThemes(entries, 4, 3);
    // 윈도우 = T2~T4
    expect(counts.get('WARNING')).toBe(2);
    expect(counts.get('SUSPICION')).toBe(1);
  });

  it('getSaturatedThemes: 3턴 내 2회 이상 WARNING → 포화', () => {
    const entries = [
      { turnNo: 3, npcId: 'A', theme: 'WARNING' as const, snippet: '' },
      { turnNo: 4, npcId: 'B', theme: 'WARNING' as const, snippet: '' },
      { turnNo: 5, npcId: 'C', theme: 'SUSPICION' as const, snippet: '' },
    ];
    const saturated = getSaturatedThemes(entries, 5, 3, 2);
    expect(saturated).toEqual(['WARNING']);
  });

  it('getSaturatedThemes: OTHER는 포화 대상 제외', () => {
    const entries = [
      { turnNo: 1, npcId: 'A', theme: 'OTHER' as const, snippet: '' },
      { turnNo: 2, npcId: 'B', theme: 'OTHER' as const, snippet: '' },
      { turnNo: 3, npcId: 'C', theme: 'OTHER' as const, snippet: '' },
    ];
    expect(getSaturatedThemes(entries, 3, 3, 2)).toEqual([]);
  });
});
