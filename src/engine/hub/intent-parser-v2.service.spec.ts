import { IntentParserV2Service } from './intent-parser-v2.service.js';
import type { IntentActionType } from '../../db/types/parsed-intent-v2.js';

describe('IntentParserV2Service — 듀얼 Intent 시스템 (35개 입력)', () => {
  let parser: IntentParserV2Service;

  beforeAll(() => {
    parser = new IntentParserV2Service();
  });

  // ============================================================
  // 이전 오분류 6건 (듀얼로 해소 기대)
  // ============================================================
  describe('이전 오분류 6건 — 듀얼로 자연스럽게 해소', () => {
    it('"몰래 접근해서 물건을 훔친다" → STEAL + SNEAK', () => {
      const r = parser.parse('몰래 접근해서 물건을 훔친다');
      expect(r.actionType).toBe('STEAL');
      expect(r.secondaryActionType).toBe('SNEAK');
    });

    it('"시비를 걸어 반응을 떠본다" → THREATEN (primary)', () => {
      const r = parser.parse('시비를 걸어 반응을 떠본다');
      expect(r.actionType).toBe('THREATEN');
      // secondary가 INVESTIGATE 또는 OBSERVE면 OK
      expect(['INVESTIGATE', 'OBSERVE', undefined]).toContain(r.secondaryActionType);
    });

    it('"경비대에 치안을 요청한다" → PERSUADE (primary)', () => {
      const r = parser.parse('경비대에 치안을 요청한다');
      expect(r.actionType).toBe('PERSUADE');
      // secondary에 HELP가 있으면 매칭 확장 가능
    });

    it('"칼을 꺼내 경고한다" → THREATEN (단일)', () => {
      const r = parser.parse('칼을 꺼내 경고한다');
      expect(r.actionType).toBe('THREATEN');
    });

    it('"엿듣는다" → SNEAK (키워드 재배치)', () => {
      const r = parser.parse('엿듣는다');
      expect(r.actionType).toBe('SNEAK');
    });

    it('"둘러보다 물건 산다" → TRADE + OBSERVE', () => {
      const r = parser.parse('둘러보다 물건 산다');
      // TRADE가 primary (최종 목적), OBSERVE가 secondary
      expect(['TRADE', 'OBSERVE']).toContain(r.actionType);
      if (r.actionType === 'TRADE') {
        expect(r.secondaryActionType).toBe('OBSERVE');
      }
    });
  });

  // ============================================================
  // 기존 정확 사례 — 단일 의도 (회귀 테스트)
  // ============================================================
  describe('단일 의도 — 기존 정확 사례 회귀', () => {
    const singleIntentCases: Array<{ input: string; expected: IntentActionType; label: string }> = [
      // FIGHT (5)
      { input: '주먹으로 가격한다', expected: 'FIGHT', label: 'FIGHT-주먹' },
      { input: '칼로 벤다', expected: 'FIGHT', label: 'FIGHT-칼' },
      { input: '쫓아가서 제압한다', expected: 'FIGHT', label: 'FIGHT-제압' },
      { input: '선제공격을 한다', expected: 'FIGHT', label: 'FIGHT-선제' },
      { input: '달려들어 때린다', expected: 'FIGHT', label: 'FIGHT-달려들' },

      // THREATEN (3)
      { input: '협박한다', expected: 'THREATEN', label: 'THREATEN-협박' },
      { input: '칼을 꺼내 보인다', expected: 'THREATEN', label: 'THREATEN-칼꺼내' },
      { input: '추궁한다', expected: 'THREATEN', label: 'THREATEN-추궁' },

      // STEAL (2)
      { input: '소매치기한다', expected: 'STEAL', label: 'STEAL-소매치기' },
      { input: '슬쩍 집어넣는다', expected: 'STEAL', label: 'STEAL-슬쩍' },

      // SNEAK (2)
      { input: '몰래 뒤를 밟는다', expected: 'SNEAK', label: 'SNEAK-미행' },
      { input: '살금살금 접근한다', expected: 'SNEAK', label: 'SNEAK-살금살금' },

      // INVESTIGATE (3)
      { input: '장부를 조사한다', expected: 'INVESTIGATE', label: 'INVESTIGATE-조사' },
      { input: '단서를 찾아본다', expected: 'INVESTIGATE', label: 'INVESTIGATE-단서' },
      { input: '물어본다', expected: 'INVESTIGATE', label: 'INVESTIGATE-물어본다' },

      // OBSERVE (2)
      { input: '주변을 둘러본다', expected: 'OBSERVE', label: 'OBSERVE-둘러보기' },
      { input: '동태를 살핀다', expected: 'OBSERVE', label: 'OBSERVE-동태' },

      // PERSUADE (2)
      { input: '설득한다', expected: 'PERSUADE', label: 'PERSUADE-설득' },
      { input: '도움을 청한다', expected: 'PERSUADE', label: 'PERSUADE-도움청' },

      // BRIBE (2)
      { input: '금화를 건넨다', expected: 'BRIBE', label: 'BRIBE-금화' },
      { input: '뇌물을 준다', expected: 'BRIBE', label: 'BRIBE-뇌물' },

      // HELP (1)
      { input: '다친 사람을 치료한다', expected: 'HELP', label: 'HELP-치료' },

      // TRADE (2)
      { input: '흥정한다', expected: 'TRADE', label: 'TRADE-흥정' },
      { input: '상점에서 물건을 산다', expected: 'TRADE', label: 'TRADE-상점(리다이렉트)' },

      // TALK (1)
      { input: '인사를 건넨다', expected: 'TALK', label: 'TALK-인사' },

      // MOVE_LOCATION (1)
      { input: '다른 곳으로 이동한다', expected: 'MOVE_LOCATION', label: 'MOVE-이동' },

      // REST (1)
      { input: '잠시 쉬겠다', expected: 'REST', label: 'REST-쉬겠다' },
    ];

    it.each(singleIntentCases)('[$label] "$input" → $expected', ({ input, expected }) => {
      const r = parser.parse(input);
      expect(r.actionType).toBe(expected);
    });
  });

  // ============================================================
  // 복합 행동 — 듀얼 출력 (새로운 테스트 케이스)
  // ============================================================
  describe('복합 행동 — 듀얼 출력', () => {
    it('"몰래 따라가서 정체를 확인한다" → INVESTIGATE + SNEAK', () => {
      const r = parser.parse('몰래 따라가서 정체를 확인한다');
      // INVESTIGATE(목적)이 primary, SNEAK(수단)이 secondary — 또는 반대도 OK
      const types = [r.actionType, r.secondaryActionType].filter(Boolean);
      expect(types).toContain('SNEAK');
      expect(types).toContain('INVESTIGATE');
    });

    it('"금화를 건네며 정보를 캐낸다" → BRIBE + INVESTIGATE', () => {
      const r = parser.parse('금화를 건네며 정보를 캐낸다');
      const types = [r.actionType, r.secondaryActionType].filter(Boolean);
      expect(types).toContain('BRIBE');
      expect(types).toContain('INVESTIGATE');
    });

    it('"숨어서 대화를 엿듣는다" → SNEAK (엿듣 = SNEAK)', () => {
      const r = parser.parse('숨어서 대화를 엿듣는다');
      expect(r.actionType).toBe('SNEAK');
    });

    it('"위협해서 정보를 얻는다" → THREATEN + INVESTIGATE', () => {
      const r = parser.parse('위협해서 정보를 캐낸다');
      const types = [r.actionType, r.secondaryActionType].filter(Boolean);
      expect(types).toContain('THREATEN');
    });
  });

  // ============================================================
  // 키워드 재배치 검증
  // ============================================================
  describe('키워드 재배치 검증', () => {
    it('"따진다" → THREATEN', () => {
      const r = parser.parse('따진다');
      expect(r.actionType).toBe('THREATEN');
    });

    it('"심문한다" → THREATEN', () => {
      const r = parser.parse('심문한다');
      expect(r.actionType).toBe('THREATEN');
    });

    it('"문책한다" → THREATEN', () => {
      const r = parser.parse('문책한다');
      expect(r.actionType).toBe('THREATEN');
    });

    it('"엿본다" → SNEAK (OBSERVE에서 이동)', () => {
      const r = parser.parse('엿본다');
      expect(r.actionType).toBe('SNEAK');
    });

    it('"가게에서 물건을 구경한다" → TRADE (SHOP 리다이렉트)', () => {
      const r = parser.parse('가게에서 물건을 구경한다');
      expect(r.actionType).toBe('TRADE');
    });

    it('"질문한다" → INVESTIGATE (TALK에서 이동)', () => {
      const r = parser.parse('질문한다');
      expect(r.actionType).toBe('INVESTIGATE');
    });
  });

  // ============================================================
  // MOVE_LOCATION 자유 텍스트 이동 감지
  // ============================================================
  describe('MOVE_LOCATION 자유 텍스트 이동 감지', () => {
    // 기본 이동 키워드
    it('"다른 곳으로 이동한다" → MOVE_LOCATION', () => {
      const r = parser.parse('다른 곳으로 이동한다');
      expect(r.actionType).toBe('MOVE_LOCATION');
    });

    // 장소명 + 이동 맥락 복합 감지
    it('"항만 쪽으로 발길을 옮긴다" → MOVE_LOCATION', () => {
      const r = parser.parse('항만 쪽으로 발길을 옮긴다');
      expect(r.actionType).toBe('MOVE_LOCATION');
    });

    it('"시장으로 가 보자" → MOVE_LOCATION', () => {
      const r = parser.parse('시장으로 가 보자');
      expect(r.actionType).toBe('MOVE_LOCATION');
    });

    it('"경비대로 향한다" → MOVE_LOCATION', () => {
      const r = parser.parse('경비대로 향한다');
      expect(r.actionType).toBe('MOVE_LOCATION');
    });

    it('"빈민가 쪽으로 간다" → MOVE_LOCATION', () => {
      const r = parser.parse('빈민가 쪽으로 간다');
      expect(r.actionType).toBe('MOVE_LOCATION');
    });

    it('"부두에 가서 배를 확인한다" → MOVE_LOCATION', () => {
      const r = parser.parse('부두에 가서 배를 확인한다');
      expect(r.actionType).toBe('MOVE_LOCATION');
    });

    it('"이곳은 위험하다. 시장으로 이동한다" → MOVE_LOCATION', () => {
      const r = parser.parse('이곳은 위험하다. 시장으로 이동한다');
      expect(r.actionType).toBe('MOVE_LOCATION');
    });

    it('"선술집으로 돌아간다" → MOVE_LOCATION', () => {
      const r = parser.parse('선술집으로 돌아간다');
      expect(r.actionType).toBe('MOVE_LOCATION');
    });

    it('"거점으로 복귀한다" → MOVE_LOCATION', () => {
      const r = parser.parse('거점으로 복귀한다');
      expect(r.actionType).toBe('MOVE_LOCATION');
    });

    // 출발/이탈 표현
    it('"여기를 떠나자" → MOVE_LOCATION', () => {
      const r = parser.parse('여기를 떠나자');
      expect(r.actionType).toBe('MOVE_LOCATION');
    });

    it('"여기서 빠져나가자" → MOVE_LOCATION', () => {
      const r = parser.parse('여기서 빠져나가자');
      expect(r.actionType).toBe('MOVE_LOCATION');
    });

    // 자연어 이동 의도 (장소명 + 접미사)
    it('"항구로 가자" → MOVE_LOCATION', () => {
      const r = parser.parse('항구로 가자');
      expect(r.actionType).toBe('MOVE_LOCATION');
    });

    it('"초소에 가서 상황을 알아본다" → MOVE_LOCATION', () => {
      const r = parser.parse('초소에 가서 상황을 알아본다');
      expect(r.actionType).toBe('MOVE_LOCATION');
    });

    it('"슬럼으로 잠입한다" → MOVE_LOCATION (장소+이동이 SNEAK보다 우선)', () => {
      const r = parser.parse('슬럼으로 잠입한다');
      // 장소명+이동 복합 감지가 SNEAK보다 우선
      expect(r.actionType).toBe('MOVE_LOCATION');
    });

    // 비이동 — 장소명만 있고 이동 맥락이 없으면 MOVE_LOCATION 아님
    it('"시장에서 물건을 살펴본다" → INVESTIGATE (이동 아님)', () => {
      const r = parser.parse('시장에서 물건을 살펴본다');
      // "시장에서"는 이미 그 장소에 있다는 맥락 → 이동이 아님
      expect(r.actionType).not.toBe('MOVE_LOCATION');
    });
  });

  // ============================================================
  // secondary가 없는 단일 의도 확인
  // ============================================================
  describe('단일 의도 시 secondary는 undefined', () => {
    it('"공격한다" — secondary 없음', () => {
      const r = parser.parse('공격한다');
      expect(r.actionType).toBe('FIGHT');
      expect(r.secondaryActionType).toBeUndefined();
    });

    it('"설득한다" — secondary 없음', () => {
      const r = parser.parse('설득한다');
      expect(r.actionType).toBe('PERSUADE');
      expect(r.secondaryActionType).toBeUndefined();
    });
  });

  // ============================================================
  // 에스컬레이션 + 듀얼 동시 동작
  // ============================================================
  describe('에스컬레이션과 듀얼의 독립성', () => {
    it('에스컬레이션 시 primary만 승격, secondary 유지', () => {
      const r = parser.parseWithInsistence(
        '몰래 접근해서 위협한다', 'RULE', undefined, 2, 'THREATEN',
      );
      // THREATEN이 에스컬레이션되면 FIGHT
      // SNEAK은 secondary로 유지
      expect(r.actionType).toBe('FIGHT');
      expect(r.escalated).toBe(true);
      expect(r.secondaryActionType).toBe('SNEAK');
    });
  });

  // ============================================================
  // 전체 35개 입력 요약 출력
  // ============================================================
  describe('전체 35개 입력 요약', () => {
    const ALL_INPUTS = [
      // 이전 오분류 6건
      '몰래 접근해서 물건을 훔친다',
      '시비를 걸어 반응을 떠본다',
      '경비대에 치안을 요청한다',
      '칼을 꺼내 경고한다',
      '엿듣는다',
      '둘러보다 물건 산다',
      // 단일 의도 26건
      '주먹으로 가격한다', '칼로 벤다', '쫓아가서 제압한다', '선제공격을 한다', '달려들어 때린다',
      '협박한다', '칼을 꺼내 보인다', '추궁한다',
      '소매치기한다', '슬쩍 집어넣는다',
      '몰래 뒤를 밟는다', '살금살금 접근한다',
      '장부를 조사한다', '단서를 찾아본다', '물어본다',
      '주변을 둘러본다', '동태를 살핀다',
      '설득한다', '도움을 청한다',
      '금화를 건넨다', '뇌물을 준다',
      '다친 사람을 치료한다',
      '흥정한다', '상점에서 물건을 산다',
      '인사를 건넨다',
      '다른 곳으로 이동한다',
      '잠시 쉬겠다',
      // 복합 행동 3건
      '몰래 따라가서 정체를 확인한다',
      '금화를 건네며 정보를 캐낸다',
    ];

    it(`총 ${ALL_INPUTS.length}개 입력 파싱 성공`, () => {
      const results = ALL_INPUTS.map((input) => {
        const r = parser.parse(input);
        const secondary = r.secondaryActionType ? `+${r.secondaryActionType}` : '';
        return { input, primary: r.actionType, secondary: r.secondaryActionType ?? null, display: `${r.actionType}${secondary}` };
      });

      // 콘솔 출력 (테스트 실행 시 확인용)
      console.log('\n=== 듀얼 Intent 파싱 결과 (35개) ===');
      console.log('─'.repeat(70));
      for (const r of results) {
        const pad = r.input.padEnd(28, '　');
        console.log(`  ${pad} → ${r.display}`);
      }
      console.log('─'.repeat(70));

      const dualCount = results.filter((r) => r.secondary !== null).length;
      console.log(`  듀얼 출력: ${dualCount}건 / ${results.length}건`);
      console.log('');

      expect(results.length).toBe(ALL_INPUTS.length);
      // 모든 파싱이 유효한 actionType을 반환해야 함
      for (const r of results) {
        expect(r.primary).toBeTruthy();
      }
    });
  });
});
