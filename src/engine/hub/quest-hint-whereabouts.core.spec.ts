import {
  composeHintWithWhereabouts,
  type HintWhereabouts,
} from './quest-hint-whereabouts.core.js';

// graymar quest.json S1 실제 nextHint (역할 지칭 — 미소개 안전 표현)
const ROLE_HINT =
  '장부가 사라졌다는 것만으로는 부족하다. 숫자를 다루는 사람, 회계나 문서 관련 인물을 찾아봐라.';

describe('composeHintWithWhereabouts', () => {
  describe('DIFFERENT_LOCATION — 다른 장소 유도', () => {
    const where: HintWhereabouts = {
      kind: 'DIFFERENT_LOCATION',
      locationLabel: '부둣가',
    };

    it('미소개 NPC — 실명 없이 "그런 인물은 …쪽에" 안내', () => {
      const out = composeHintWithWhereabouts(ROLE_HINT, where, {
        introduced: false,
        npcDisplay: '오슬라',
      });

      console.log('[미소개/다른장소]', out);
      expect(out).toContain('그런 인물은 지금 부둣가 쪽에 있을 것이다');
      expect(out).not.toContain('오슬라'); // 실명 노출 금지
      expect(out.startsWith(ROLE_HINT)).toBe(true);
    });

    it('소개된 NPC(받침 O) — 실명 + 목적격 "을"', () => {
      const out = composeHintWithWhereabouts(ROLE_HINT, where, {
        introduced: true,
        npcDisplay: '펠릭스',
      });

      console.log('[소개/다른장소/받침O]', out);
      expect(out).toContain('부둣가 쪽에서 펠릭스를 만날 수 있을 것이다');
    });

    it('소개된 NPC(받침 X) — 목적격 "를"', () => {
      const out = composeHintWithWhereabouts(ROLE_HINT, where, {
        introduced: true,
        npcDisplay: '오슬라',
      });

      console.log('[소개/다른장소/받침X]', out);
      expect(out).toContain('오슬라를 만날 수 있을 것이다');
    });

    it('locationLabel이 비면 원본 유지', () => {
      const out = composeHintWithWhereabouts(
        ROLE_HINT,
        { kind: 'DIFFERENT_LOCATION', locationLabel: '  ' },
        { introduced: true, npcDisplay: '오슬라' },
      );
      expect(out).toBe(ROLE_HINT);
    });
  });

  describe('SAME_LOCATION — 같은 장소', () => {
    const where: HintWhereabouts = { kind: 'SAME_LOCATION' };

    it('소개된 NPC — 주격 "이/가" + 이곳 안내', () => {
      const out = composeHintWithWhereabouts(ROLE_HINT, where, {
        introduced: true,
        npcDisplay: '오슬라',
      });

      console.log('[소개/같은장소]', out);
      expect(out).toContain('마침 오슬라가 이곳에 머물고 있다');
    });

    it('미소개 NPC — 실명 없이 "그럴 만한 인물"', () => {
      const out = composeHintWithWhereabouts(ROLE_HINT, where, {
        introduced: false,
        npcDisplay: '오슬라',
      });

      console.log('[미소개/같은장소]', out);
      expect(out).toContain('마침 그럴 만한 인물이 이곳에 머물고 있다');
      expect(out).not.toContain('오슬라');
    });
  });

  describe('UNKNOWN — 위치 불명', () => {
    it('원본 힌트를 그대로 반환(위치 절 없음)', () => {
      const out = composeHintWithWhereabouts(
        ROLE_HINT,
        { kind: 'UNKNOWN' },
        { introduced: true, npcDisplay: '오슬라' },
      );
      expect(out).toBe(ROLE_HINT);
    });
  });

  describe('엣지', () => {
    it('빈 baseHint는 그대로 반환', () => {
      expect(
        composeHintWithWhereabouts('', {
          kind: 'DIFFERENT_LOCATION',
          locationLabel: '부둣가',
        }),
      ).toBe('');
    });

    it('종결부호 없는 base에 마침표 보정 후 접미', () => {
      const out = composeHintWithWhereabouts(
        '회계 담당자를 찾아라',
        { kind: 'DIFFERENT_LOCATION', locationLabel: '창고' },
        { introduced: false },
      );

      console.log('[부호보정]', out);
      expect(out).toBe(
        '회계 담당자를 찾아라. 그런 인물은 지금 창고 쪽에 있을 것이다.',
      );
    });
  });
});
